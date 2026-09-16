import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import { aggregatePredictionEvaluations, canManage, dateSchema, evaluatePrediction, getResultDataProvider, parseResultCsv, raceResultInputSchema, requiresMfa, resultDataProviderCatalog, resultDataProviderIdSchema, resultEntrySchema, verifyJraVanResultBundle } from '@keiba/domain';
import type { BatchResultCsvRow, RaceResultInput, ResultEntry, Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

const evaluationRuleVersion = 'HORSE_EVALUATION_V1';
const importReasonSchema = z.string().trim().min(1).max(500);
const importBatchRowsSchema = z.object({ targetRevision: z.number().int().positive(), raceCanceled: z.boolean(), entries: z.array(resultEntrySchema).max(18) }).strict();
const resultBundleProvenanceSchema = z.object({
  formatVersion: z.literal('UMAREAL_JRA_VAN_BUNDLE_V1'), targetDate: dateSchema,
  manifestChecksum: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const batchImportRowsSchema = z.object({
  providerId: resultDataProviderIdSchema, providerFormatVersion: z.string().min(1).max(80), sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDisposition: z.enum(['NEW', 'CORRECTION']).default('NEW'), previousImportBatchId: z.string().uuid().nullable().default(null),
  bundle: resultBundleProvenanceSchema.nullable().default(null),
  races: z.array(z.object({ raceId: z.string().uuid(), targetRevision: z.number().int().positive(), raceCanceled: z.boolean(), entries: z.array(resultEntrySchema).max(18) }).strict()).min(1).max(100)
}).strict();
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type ResultImportChange = { key: string; action: '変更' | '変更なし'; fields: { field: string; before: unknown; after: unknown }[] };

@Controller()
export class ResultsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async staff(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN', 'OPERATOR'] as Role[])) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '結果管理の権限と二段階認証を確認してください。' });
    return actor;
  }

  private async ensureCsvEnabled(tx: Prisma.TransactionClient) {
    const settings = await tx.systemSetting.findUnique({ where: { id: 'global' }, select: { csvImportEnabled: true } });
    if (settings && !settings.csvImportEnabled) throw new ForbiddenException({ code: 'CSV_IMPORT_STOPPED', message: '管理設定によりCSV取込を停止しています。' });
  }

  private resultImportBaseline(race: { id: string; startsAt: Date; status: string; entries: { id: string; number: number; horseName: string }[]; resultDraft: { revision: number; content: unknown } | null }) {
    return hashToken(JSON.stringify({
      race: { id: race.id, startsAt: race.startsAt, status: race.status },
      entries: race.entries.map(entry => ({ id: entry.id, number: entry.number, horseName: entry.horseName })),
      draft: race.resultDraft ? { revision: race.resultDraft.revision, content: race.resultDraft.content } : null
    }));
  }

  private batchResultImportBaseline(races: { id: string; startsAt: Date; status: string; entries: { id: string; number: number; horseName: string }[]; resultDraft: { revision: number; content: unknown } | null }[]) {
    return hashToken(JSON.stringify(races.map(race => this.resultImportBaseline(race))));
  }

  private sameRaceIds(left: string[], right: string[]) {
    return left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]);
  }

  private async confirmedResultImports(tx: Prisma.TransactionClient, take = 200) {
    const batches = await tx.importBatch.findMany({ where: { kind: 'results-batch', confirmedAt: { not: null } }, orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }], take });
    return batches.flatMap(batch => {
      const stored = batchImportRowsSchema.safeParse(batch.rows);
      return stored.success ? [{ batch, stored: stored.data }] : [];
    });
  }

  private async confirmedResultImportBySource(tx: Prisma.TransactionClient, providerId: string, sourceChecksum: string) {
    const matches = await tx.$queryRaw<Array<{ id: string; actorId: string; rows: unknown; confirmedAt: Date }>>`
      SELECT id, "actorId", rows, "confirmedAt"
      FROM import_batches
      WHERE kind = 'results-batch'
        AND "confirmedAt" IS NOT NULL
        AND rows->>'providerId' = ${providerId}
        AND rows->>'sourceChecksum' = ${sourceChecksum}
      ORDER BY "confirmedAt" DESC, id DESC
      LIMIT 1
    `;
    if (!matches[0]) return null;
    const stored = batchImportRowsSchema.safeParse(matches[0].rows);
    return stored.success ? { batch: matches[0], stored: stored.data } : null;
  }

  private resultImportChanges(before: RaceResultInput, raceCanceled: boolean, entries: ResultEntry[], horses: { id: string; number: number; horseName: string }[]) {
    const changes: ResultImportChange[] = [];
    const canceledFields = before.raceCanceled === raceCanceled ? [] : [{ field: 'raceCanceled', before: before.raceCanceled, after: raceCanceled }];
    changes.push({ key: 'レース中止', action: canceledFields.length ? '変更' : '変更なし', fields: canceledFields });
    const beforeById = new Map(before.entries.map(entry => [entry.entryId, entry]));
    for (const entry of entries) {
      const current = beforeById.get(entry.entryId);
      const fields = (['status', 'finishPosition', 'popularity', 'finalOdds'] as const)
        .filter(field => JSON.stringify(current?.[field] ?? null) !== JSON.stringify(entry[field]))
        .map(field => ({ field, before: current?.[field] ?? null, after: entry[field] }));
      const horse = horses.find(item => item.id === entry.entryId)!;
      changes.push({ key: `${horse.number}番 ${horse.horseName}`, action: fields.length ? '変更' : '変更なし', fields });
    }
    return changes;
  }

  private async race(raceId: string) {
    z.string().uuid().parse(raceId);
    const race = await this.auth.db.race.findUnique({
      where: { id: raceId },
      include: {
        entries: { orderBy: { number: 'asc' } },
        resultDraft: true,
        resultVersions: { orderBy: { version: 'desc' }, select: { id: true, version: true, sourceRevision: true, ruleVersion: true, raceCanceled: true, reason: true, confirmedAt: true, confirmedBy: true } }
      }
    });
    if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
    return race;
  }

  private validateEntries(input: RaceResultInput, race: Awaited<ReturnType<ResultsController['race']>>) {
    const expected = new Set(race.entries.map(entry => entry.id));
    if (input.entries.length !== expected.size || input.entries.some(entry => !expected.has(entry.entryId))) throw new BadRequestException({ code: 'RESULT_ENTRIES_INCOMPLETE', message: '全出走馬の結果を重複なく入力してください。' });
  }

  private currentDraft(content: unknown, revision: number, entries: Awaited<ReturnType<ResultsController['race']>>['entries']) {
    const parsed = raceResultInputSchema.safeParse({ ...(content as object), revision });
    if (parsed.success) return parsed.data;
    const legacy = z.object({ raceCanceled: z.boolean(), entries: z.array(z.unknown()), reason: z.string() }).passthrough().safeParse(content);
    if (legacy.success) {
      const normalized = raceResultInputSchema.safeParse({ revision, raceCanceled: legacy.data.raceCanceled, entries: legacy.data.entries, reason: legacy.data.reason || '旧結果下書きから移行' });
      if (normalized.success) return normalized.data;
    }
    return { revision, raceCanceled: false, reason: '', entries: entries.map(entry => ({ entryId: entry.id, status: 'FINISHED' as const, finishPosition: null, popularity: entry.popularity, finalOdds: entry.winOdds?.toString() ?? null })) };
  }

  @Get('admin/results/races')
  async races(@Req() req: AppRequest) {
    await this.staff(req);
    const items = await this.auth.db.race.findMany({ where: { startsAt: { lte: new Date() }, OR: [{ prediction: { versions: { some: {} } } }, { win5ProductRaces: { some: { product: { versions: { some: {} } } } } }, { resultDraft: { isNot: null } }, { resultVersions: { some: {} } }] }, orderBy: [{ startsAt: 'desc' }, { id: 'asc' }], take: 100, include: { resultDraft: { select: { revision: true, updatedAt: true, content: true } }, resultVersions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, sourceRevision: true, confirmedAt: true, raceCanceled: true } } } });
    return { items: items.map(item => {
      const source = z.object({ source: z.enum(['CSV_SINGLE', 'CSV_BATCH']), sourceProvider: resultDataProviderIdSchema.optional() }).passthrough().safeParse(item.resultDraft?.content);
      return { id: item.id, raceDate: item.raceDate, venue: item.venue, number: item.number, name: item.name, startsAt: item.startsAt, status: item.status, draftRevision: item.resultDraft?.revision ?? 0, draftSource: source.success ? source.data.source : null, draftProvider: source.success ? source.data.sourceProvider ?? null : null, latestResult: item.resultVersions[0] ?? null };
    }) };
  }

  @Post('admin/results/import/preview')
  async batchImportPreview(@Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req);
    const { csv, providerId, bundleManifest } = z.object({
      csv: z.string().max(90000), providerId: resultDataProviderIdSchema.default('CANONICAL_CSV'),
      bundleManifest: z.string().max(30000).optional()
    }).strict().parse(body);
    const parsed = getResultDataProvider(providerId).parse(csv);
    const provider = { id: parsed.provider.id, label: parsed.provider.label, formatVersion: parsed.provider.formatVersion };
    const sourceChecksum = hashToken(csv);
    let bundle: z.infer<typeof resultBundleProvenanceSchema> | null = null;
    if (bundleManifest !== undefined) {
      if (providerId !== 'JRA_VAN_BRIDGE_V1') parsed.errors.push({ row: 0, field: 'bundleManifest', message: 'bundle manifestはJRA-VAN連携ブリッジでのみ指定できます。' });
      else {
        const verified = verifyJraVanResultBundle(bundleManifest, csv, parsed.rows, hashToken);
        parsed.errors.push(...verified.errors);
        if (verified.manifest && verified.errors.length === 0) bundle = {
          formatVersion: verified.manifest.formatVersion,
          targetDate: verified.manifest.targetDate,
          manifestChecksum: hashToken(bundleManifest)
        };
      }
    }
    if (parsed.errors.length) return { provider, sourceChecksum, bundle, errors: parsed.errors, races: [], batchId: null };
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      await this.ensureCsvEnabled(tx);
      const grouped = new Map<string, { rows: { value: BatchResultCsvRow; rowNumber: number }[]; firstRow: number }>();
      parsed.rows.forEach((row, index) => {
        const key = `${row.raceDate}:${row.venue}:${row.raceNumber}`;
        const group = grouped.get(key) ?? { rows: [], firstRow: index + 2 };
        group.rows.push({ value: row, rowNumber: index + 2 }); grouped.set(key, group);
      });
      const importedRaces = await tx.race.findMany({
        where: { OR: [...grouped.values()].map(group => ({ raceDate: group.rows[0].value.raceDate, venue: group.rows[0].value.venue, number: group.rows[0].value.raceNumber })) },
        include: { entries: { orderBy: { number: 'asc' } }, resultDraft: true }
      });
      const raceByKey = new Map(importedRaces.map(race => [`${race.raceDate}:${race.venue}:${race.number}`, race]));
      const errors: { row: number; field: string; message: string }[] = [];
      const prepared: { race: typeof importedRaces[number]; raceCanceled: boolean; entries: ResultEntry[]; targetRevision: number; changes: ResultImportChange[] }[] = [];
      for (const [key, group] of grouped) {
        const race = raceByKey.get(key);
        if (!race) { errors.push({ row: group.firstRow, field: 'raceNumber', message: `${group.rows[0].value.raceDate} ${group.rows[0].value.venue} ${group.rows[0].value.raceNumber}Rは登録されていません。` }); continue; }
        if (new Date() < race.startsAt) { errors.push({ row: group.firstRow, field: 'raceNumber', message: `${race.venue} ${race.number}Rは発走時刻前です。` }); continue; }
        const registered = new Map(race.entries.map(entry => [entry.number, entry]));
        group.rows.forEach(row => { if (!registered.has(row.value.horseNumber)) errors.push({ row: row.rowNumber, field: 'horseNumber', message: `${race.venue} ${race.number}Rに${row.value.horseNumber}番は登録されていません。` }); });
        const imported = new Set(group.rows.map(row => row.value.horseNumber));
        for (const entry of race.entries) if (!imported.has(entry.number)) errors.push({ row: group.firstRow, field: 'horseNumber', message: `${race.venue} ${race.number}Rの${entry.number}番 ${entry.horseName}の結果がありません。` });
        const canceled = group.rows.filter(row => row.value.status === 'CANCELED').length;
        if (canceled > 0 && canceled !== group.rows.length) { errors.push({ row: group.firstRow, field: 'status', message: `${race.venue} ${race.number}RはCANCELEDと他の状態を混在できません。` }); continue; }
        if (group.rows.some(row => errors.some(error => error.row === row.rowNumber)) || errors.some(error => error.row === group.firstRow)) continue;
        const rowsByNumber = new Map(group.rows.map(row => [row.value.horseNumber, row.value]));
        const entries = race.entries.map(entry => { const row = rowsByNumber.get(entry.number)!; return { entryId: entry.id, status: row.status, finishPosition: row.finishPosition, popularity: row.popularity, finalOdds: row.finalOdds }; });
        const revision = race.resultDraft?.revision ?? 0, raceCanceled = canceled === group.rows.length;
        const validated = raceResultInputSchema.safeParse({ revision, raceCanceled, entries, reason: '複数レースCSV取込内容の確認' });
        if (!validated.success) { validated.error.issues.forEach(issue => errors.push({ row: group.firstRow, field: issue.path.join('.'), message: `${race.venue} ${race.number}R：${issue.message}` })); continue; }
        const before = this.currentDraft(race.resultDraft?.content, revision, race.entries);
        prepared.push({ race, raceCanceled, entries, targetRevision: revision + 1, changes: this.resultImportChanges(before, raceCanceled, entries, race.entries) });
      }
      if (errors.length) return { provider, sourceChecksum, bundle, errors, races: [], batchId: null };
      const confirmedImports = await this.confirmedResultImports(tx);
      const duplicate = await this.confirmedResultImportBySource(tx, providerId, sourceChecksum);
      if (duplicate) return {
        provider, sourceChecksum, bundle, duplicateOf: { batchId: duplicate.batch.id, confirmedAt: duplicate.batch.confirmedAt },
        errors: [{ row: 0, field: 'sourceChecksum', message: '同じ取込元・同じ内容のCSVは反映済みです。取込履歴を確認してください。' }], races: [], batchId: null
      };
      const raceIds = prepared.map(item => item.race.id);
      const previous = confirmedImports.find(item => item.stored.providerId === providerId && this.sameRaceIds(item.stored.races.map(race => race.raceId), raceIds));
      const sourceDisposition = previous ? 'CORRECTION' as const : 'NEW' as const;
      const stored = { providerId, providerFormatVersion: parsed.provider.formatVersion, sourceChecksum, sourceDisposition, previousImportBatchId: previous?.batch.id ?? null, bundle, races: prepared.map(item => ({ raceId: item.race.id, targetRevision: item.targetRevision, raceCanceled: item.raceCanceled, entries: item.entries })) };
      const batch = await tx.importBatch.create({ data: { actorId: actor.id, kind: 'results-batch', rows: json(stored), baselineHash: this.batchResultImportBaseline(prepared.map(item => item.race)), expiresAt: new Date(Date.now() + 15 * 60000) } });
      return { provider, sourceChecksum, bundle, sourceDisposition, previousImport: previous ? { batchId: previous.batch.id, confirmedAt: previous.batch.confirmedAt, sourceChecksum: previous.stored.sourceChecksum } : null, batchId: batch.id, expiresAt: batch.expiresAt, errors: [], races: prepared.map(item => ({ raceId: item.race.id, key: `${item.race.raceDate} ${item.race.venue} ${item.race.number}R ${item.race.name}`, targetRevision: item.targetRevision, changes: item.changes })) };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Get('admin/results/import/providers')
  async resultImportProviders(@Req() req: AppRequest) {
    await this.staff(req);
    return { items: resultDataProviderCatalog.map(provider => ({ id: provider.id, label: provider.label, formatVersion: provider.formatVersion, headers: provider.headers })) };
  }

  @Get('admin/results/import/history')
  async resultImportHistory(@Req() req: AppRequest) {
    await this.staff(req);
    const imports = await this.confirmedResultImports(this.auth.db, 100);
    const actorIds = [...new Set(imports.map(item => item.batch.actorId))], raceIds = [...new Set(imports.flatMap(item => item.stored.races.map(race => race.raceId)))];
    const [actors, races] = await Promise.all([
      this.auth.db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }),
      this.auth.db.race.findMany({ where: { id: { in: raceIds } }, select: { id: true, raceDate: true, venue: true, number: true, name: true } })
    ]);
    const actorById = new Map(actors.map(actor => [actor.id, actor.displayName])), raceById = new Map(races.map(race => [race.id, race]));
    return { items: imports.slice(0, 30).map(item => {
      const provider = resultDataProviderCatalog.find(candidate => candidate.id === item.stored.providerId)!;
      return {
        batchId: item.batch.id, provider: { id: provider.id, label: provider.label, formatVersion: item.stored.providerFormatVersion },
        sourceChecksum: item.stored.sourceChecksum, sourceDisposition: item.stored.sourceDisposition, previousImportBatchId: item.stored.previousImportBatchId, bundle: item.stored.bundle,
        actorDisplayName: actorById.get(item.batch.actorId) ?? '不明な担当者', confirmedAt: item.batch.confirmedAt,
        races: item.stored.races.map(storedRace => { const race = raceById.get(storedRace.raceId); return race ? { raceId: race.id, label: `${race.raceDate} ${race.venue} ${race.number}R ${race.name}`, revision: storedRace.targetRevision } : { raceId: storedRace.raceId, label: '削除済みレース', revision: storedRace.targetRevision }; })
      };
    }) };
  }

  @Post('admin/results/import/:batchId/confirm')
  async batchImportConfirm(@Param('batchId') batchId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req); z.string().uuid().parse(batchId);
    const { reason } = z.object({ reason: importReasonSchema }).strict().parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      await this.ensureCsvEnabled(tx);
      const batch = await tx.importBatch.findUnique({ where: { id: batchId } });
      if (!batch || batch.actorId !== actor.id || batch.kind !== 'results-batch' || batch.raceId !== null) throw new NotFoundException();
      const stored = batchImportRowsSchema.parse(batch.rows);
      const revisions = stored.races.map(race => ({ raceId: race.raceId, revision: race.targetRevision }));
      if (batch.confirmedAt) return { imported: true, count: revisions.length, races: revisions, batchId, providerId: stored.providerId, sourceChecksum: stored.sourceChecksum, alreadyConfirmed: true };
      if (batch.expiresAt <= new Date()) throw new ConflictException({ code: 'PREVIEW_EXPIRED', message: 'プレビューの有効期限が切れました。再確認してください。' });
      const duplicate = await this.confirmedResultImportBySource(tx, stored.providerId, stored.sourceChecksum);
      if (duplicate) throw new ConflictException({ code: 'DUPLICATE_RESULT_IMPORT', message: '同じ取込元・同じ内容のCSVが反映済みです。取込履歴を確認してください。', previousBatchId: duplicate.batch.id, confirmedAt: duplicate.batch.confirmedAt });
      const importedRaces = await tx.race.findMany({ where: { id: { in: stored.races.map(race => race.raceId) } }, include: { entries: { orderBy: { number: 'asc' } }, resultDraft: true } });
      const raceById = new Map(importedRaces.map(race => [race.id, race]));
      const ordered = stored.races.map(item => raceById.get(item.raceId));
      if (ordered.some(race => !race) || this.batchResultImportBaseline(ordered as typeof importedRaces) !== batch.baselineHash) throw new ConflictException({ code: 'STALE_PREVIEW', message: 'プレビュー後に対象データが変更されました。CSVを再確認してください。' });
      for (const item of stored.races) {
        const race = raceById.get(item.raceId)!;
        if (new Date() < race.startsAt) throw new BadRequestException({ code: 'RESULT_BEFORE_START', message: `${race.venue} ${race.number}Rは発走時刻前です。` });
        const currentRevision = race.resultDraft?.revision ?? 0;
        if (item.targetRevision !== currentRevision + 1) throw new ConflictException({ code: 'STALE_PREVIEW', message: '結果下書きが変更されました。CSVを再確認してください。' });
        const input = raceResultInputSchema.parse({ revision: currentRevision, raceCanceled: item.raceCanceled, entries: item.entries, reason });
        const expected = new Set(race.entries.map(entry => entry.id));
        if (input.entries.length !== expected.size || input.entries.some(entry => !expected.has(entry.entryId))) throw new ConflictException({ code: 'STALE_PREVIEW', message: '出走馬が変更されました。CSVを再確認してください。' });
      }
      try {
        for (const item of stored.races) {
          const race = raceById.get(item.raceId)!, currentRevision = race.resultDraft?.revision ?? 0;
          const content = json({ raceCanceled: item.raceCanceled, entries: item.entries, reason, source: 'CSV_BATCH', sourceProvider: stored.providerId, sourceFormatVersion: stored.providerFormatVersion, sourceChecksum: stored.sourceChecksum, sourceDisposition: stored.sourceDisposition, sourceImportBatchId: batchId, previousImportBatchId: stored.previousImportBatchId, sourceBundle: stored.bundle });
          if (currentRevision === 0) await tx.raceResultDraft.create({ data: { raceId: item.raceId, revision: item.targetRevision, content, updatedBy: actor.id } });
          else {
            const updated = await tx.raceResultDraft.updateMany({ where: { raceId: item.raceId, revision: currentRevision }, data: { content, revision: item.targetRevision, updatedBy: actor.id, updatedAt: new Date() } });
            if (updated.count !== 1) throw new ConflictException({ code: 'STALE_PREVIEW', message: '結果下書きが変更されました。CSVを再確認してください。' });
          }
          await this.auth.audit(tx, req, 'RACE_RESULT_BATCH_CSV_IMPORT_CONFIRMED', item.raceId, reason, json({ batchId, revision: item.targetRevision, entries: item.entries.length, raceCanceled: item.raceCanceled, providerId: stored.providerId, providerFormatVersion: stored.providerFormatVersion, sourceChecksum: stored.sourceChecksum, sourceDisposition: stored.sourceDisposition, previousImportBatchId: stored.previousImportBatchId, bundle: stored.bundle }));
        }
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'STALE_PREVIEW', message: '結果下書きが変更されました。CSVを再確認してください。' });
        throw error;
      }
      try { await tx.importBatch.update({ where: { id: batchId }, data: { confirmedAt: new Date() } }); }
      catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'DUPLICATE_RESULT_IMPORT', message: '同じ取込元・同じ内容のCSVが反映済みです。取込履歴を確認してください。' });
        throw error;
      }
      return { imported: true, count: revisions.length, races: revisions, batchId, providerId: stored.providerId, sourceChecksum: stored.sourceChecksum, alreadyConfirmed: false };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Get('admin/results/races/:raceId')
  async get(@Param('raceId') raceId: string, @Req() req: AppRequest) {
    await this.staff(req);
    const race = await this.race(raceId);
    return {
      race: { id: race.id, raceDate: race.raceDate, venue: race.venue, number: race.number, name: race.name, startsAt: race.startsAt, status: race.status },
      entries: race.entries.map(entry => ({ id: entry.id, number: entry.number, horseName: entry.horseName })),
      draft: this.currentDraft(race.resultDraft?.content, race.resultDraft?.revision ?? 0, race.entries),
      versions: race.resultVersions
    };
  }

  @Post('admin/results/races/:raceId/import/preview')
  async importPreview(@Param('raceId') raceId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req);
    z.string().uuid().parse(raceId);
    const input = z.object({ csv: z.string().max(90000), raceCanceled: z.boolean() }).strict().parse(body);
    const parsed = parseResultCsv(input.csv);
    if (parsed.errors.length) return { errors: parsed.errors, changes: [], batchId: null };
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      await this.ensureCsvEnabled(tx);
      const race = await tx.race.findUnique({ where: { id: raceId }, include: { entries: { orderBy: { number: 'asc' } }, resultDraft: true } });
      if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
      if (new Date() < race.startsAt) throw new BadRequestException({ code: 'RESULT_BEFORE_START', message: '発走時刻前に結果は取り込めません。' });
      const registered = new Map(race.entries.map(entry => [entry.number, entry]));
      const errors = parsed.rows.flatMap((row, index) => registered.has(row.number) ? [] : [{ row: index + 2, field: 'number', message: `${row.number}番は対象レースに登録されていません。` }]);
      const imported = new Set(parsed.rows.map(row => row.number));
      for (const entry of race.entries) if (!imported.has(entry.number)) errors.push({ row: 0, field: 'number', message: `${entry.number}番 ${entry.horseName}の結果がありません。` });
      if (errors.length) return { errors, changes: [], batchId: null };
      const rowsByNumber = new Map(parsed.rows.map(row => [row.number, row]));
      const entries = race.entries.map(entry => { const row = rowsByNumber.get(entry.number)!; return { entryId: entry.id, status: row.status, finishPosition: row.finishPosition, popularity: row.popularity, finalOdds: row.finalOdds }; });
      const revision = race.resultDraft?.revision ?? 0;
      const validated = raceResultInputSchema.safeParse({ revision, raceCanceled: input.raceCanceled, entries, reason: 'CSV取込内容の確認' });
      if (!validated.success) return { errors: validated.error.issues.map(issue => ({ row: 0, field: issue.path.join('.'), message: issue.message })), changes: [], batchId: null };
      const before = this.currentDraft(race.resultDraft?.content, revision, race.entries);
      const changes = this.resultImportChanges(before, input.raceCanceled, entries, race.entries);
      const batch = await tx.importBatch.create({ data: {
        actorId: actor.id, kind: 'results', raceId, rows: json({ targetRevision: revision + 1, raceCanceled: input.raceCanceled, entries }),
        baselineHash: this.resultImportBaseline(race), expiresAt: new Date(Date.now() + 15 * 60000)
      } });
      return { batchId: batch.id, expiresAt: batch.expiresAt, changes, errors: [] };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Post('admin/results/races/:raceId/import/:batchId/confirm')
  async importConfirm(@Param('raceId') raceId: string, @Param('batchId') batchId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req);
    z.string().uuid().parse(raceId); z.string().uuid().parse(batchId);
    const { reason } = z.object({ reason: importReasonSchema }).strict().parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      await this.ensureCsvEnabled(tx);
      const batch = await tx.importBatch.findUnique({ where: { id: batchId } });
      if (!batch || batch.actorId !== actor.id || batch.kind !== 'results' || batch.raceId !== raceId) throw new NotFoundException();
      const stored = importBatchRowsSchema.parse(batch.rows);
      if (batch.confirmedAt) return { imported: true, revision: stored.targetRevision, batchId, alreadyConfirmed: true };
      if (batch.expiresAt <= new Date()) throw new ConflictException({ code: 'PREVIEW_EXPIRED', message: 'プレビューの有効期限が切れました。再確認してください。' });
      const race = await tx.race.findUnique({ where: { id: raceId }, include: { entries: { orderBy: { number: 'asc' } }, resultDraft: true } });
      if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
      if (this.resultImportBaseline(race) !== batch.baselineHash) throw new ConflictException({ code: 'STALE_PREVIEW', message: 'プレビュー後に対象データが変更されました。CSVを再確認してください。' });
      if (new Date() < race.startsAt) throw new BadRequestException({ code: 'RESULT_BEFORE_START', message: '発走時刻前に結果は取り込めません。' });
      const input = raceResultInputSchema.parse({ revision: race.resultDraft?.revision ?? 0, raceCanceled: stored.raceCanceled, entries: stored.entries, reason });
      const expected = new Set(race.entries.map(entry => entry.id));
      if (input.entries.length !== expected.size || input.entries.some(entry => !expected.has(entry.entryId))) throw new ConflictException({ code: 'STALE_PREVIEW', message: '出走馬が変更されました。CSVを再確認してください。' });
      const content = json({ raceCanceled: input.raceCanceled, entries: input.entries, reason, source: 'CSV_SINGLE' });
      if (input.revision === 0) {
        try { await tx.raceResultDraft.create({ data: { raceId, revision: stored.targetRevision, content, updatedBy: actor.id } }); }
        catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'STALE_PREVIEW', message: '結果下書きが変更されました。CSVを再確認してください。' });
          throw error;
        }
      } else {
        const updated = await tx.raceResultDraft.updateMany({ where: { raceId, revision: input.revision }, data: { content, revision: stored.targetRevision, updatedBy: actor.id, updatedAt: new Date() } });
        if (updated.count !== 1) throw new ConflictException({ code: 'STALE_PREVIEW', message: '結果下書きが変更されました。CSVを再確認してください。' });
      }
      await tx.importBatch.update({ where: { id: batchId }, data: { confirmedAt: new Date() } });
      await this.auth.audit(tx, req, 'RACE_RESULT_CSV_IMPORT_CONFIRMED', raceId, reason, { batchId, revision: stored.targetRevision, entries: stored.entries.length, raceCanceled: stored.raceCanceled });
      return { imported: true, revision: stored.targetRevision, batchId, alreadyConfirmed: false };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Patch('admin/results/races/:raceId')
  async save(@Param('raceId') raceId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req);
    const input = raceResultInputSchema.parse(body);
    const race = await this.race(raceId);
    this.validateEntries(input, race);
    if (new Date() < race.startsAt) throw new BadRequestException({ code: 'RESULT_BEFORE_START', message: '発走時刻前に結果は保存できません。' });
    const content = { raceCanceled: input.raceCanceled, entries: input.entries, reason: input.reason } as Prisma.InputJsonValue;
    return this.auth.db.$transaction(async tx => {
      if (input.revision === 0) {
        try {
          const created = await tx.raceResultDraft.create({ data: { raceId, revision: 1, content, updatedBy: actor.id } });
          await this.auth.audit(tx, req, 'RACE_RESULT_DRAFT_SAVE', raceId, input.reason, { revision: 1, ruleVersion: evaluationRuleVersion });
          return { revision: created.revision };
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'RESULT_REVISION_CONFLICT', message: '別の担当者が結果を保存しました。再読み込みしてください。' });
          throw error;
        }
      }
      const changed = await tx.raceResultDraft.updateMany({ where: { raceId, revision: input.revision }, data: { content, revision: { increment: 1 }, updatedBy: actor.id, updatedAt: new Date() } });
      if (changed.count !== 1) throw new ConflictException({ code: 'RESULT_REVISION_CONFLICT', message: '別の担当者が結果を保存しました。再読み込みしてください。' });
      await this.auth.audit(tx, req, 'RACE_RESULT_DRAFT_SAVE', raceId, input.reason, { revision: input.revision + 1, ruleVersion: evaluationRuleVersion });
      return { revision: input.revision + 1 };
    });
  }

  @Post('admin/results/races/:raceId/confirm')
  async confirm(@Param('raceId') raceId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req);
    z.string().uuid().parse(raceId);
    const { revision, reason } = z.object({ revision: z.number().int().positive(), reason: z.string().trim().min(1).max(500) }).strict().parse(body);
    return this.auth.db.$transaction(async tx => {
      const already = await tx.raceResultVersion.findUnique({ where: { raceId_sourceRevision: { raceId, sourceRevision: revision } }, select: { id: true, version: true } });
      if (already) return { versionId: already.id, version: already.version, alreadyConfirmed: true };
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM race_result_drafts WHERE "raceId" = ${raceId}::uuid AND revision = ${revision} FOR UPDATE`;
      if (!locked.length) {
        const existing = await tx.raceResultVersion.findUnique({ where: { raceId_sourceRevision: { raceId, sourceRevision: revision } }, select: { id: true, version: true } });
        if (existing) return { versionId: existing.id, version: existing.version, alreadyConfirmed: true };
        throw new ConflictException({ code: 'RESULT_REVISION_CONFLICT', message: '結果を再読み込みしてください。' });
      }
      const draft = await tx.raceResultDraft.findUniqueOrThrow({ where: { raceId } });
      const input = raceResultInputSchema.parse({ ...(draft.content as object), revision: draft.revision, reason });
      const race = await tx.race.findUniqueOrThrow({ where: { id: raceId }, include: { entries: true, prediction: { include: { versions: { include: { marks: true }, orderBy: { version: 'asc' } } } } } });
      if (new Date() < race.startsAt) throw new BadRequestException({ code: 'RESULT_BEFORE_START', message: '発走時刻前に結果を確定できません。' });
      const expected = new Set(race.entries.map(entry => entry.id));
      if (input.entries.length !== expected.size || input.entries.some(entry => !expected.has(entry.entryId))) throw new BadRequestException({ code: 'RESULT_ENTRIES_INCOMPLETE', message: '全出走馬の結果を入力してください。' });
      const currentPredictions = (race.prediction?.versions ?? []).filter(prediction => prediction.formatVersion === 'HORSE_EVALUATION_V1');
      const evaluations = currentPredictions.map(prediction => ({
        prediction,
        evaluation: evaluatePrediction({
          confidence: z.enum(['S', 'A', 'B', 'C', 'SKIP']).parse(prediction.confidence),
          horses: prediction.marks.map(mark => ({ entryId: mark.entryId, evaluationType: mark.mark === 'HONMEI' ? 'PRIMARY' as const : mark.mark === 'DANGER' ? 'RISK' as const : 'SECONDARY' as const })),
          resultEntries: input.entries,
          raceCanceled: input.raceCanceled
        })
      }));
      const latest = await tx.raceResultVersion.findFirst({ where: { raceId }, orderBy: { version: 'desc' }, select: { version: true } });
      const result = await tx.raceResultVersion.create({
        data: {
          raceId,
          version: (latest?.version ?? 0) + 1,
          sourceRevision: revision,
          ruleVersion: evaluationRuleVersion,
          raceCanceled: input.raceCanceled,
          entriesSnapshot: input.entries,
          payoutsSnapshot: [],
          reason,
          confirmedBy: actor.id,
          predictionEvaluations: { create: evaluations.map(({ prediction, evaluation }) => ({ predictionVersionId: prediction.id, raceId, ...evaluation, confirmedBy: actor.id, calculationRuleVersion: evaluationRuleVersion })) }
        },
        select: { id: true, version: true }
      });
      const latestEvaluation = evaluations.at(-1)?.evaluation;
      if (latestEvaluation && latestEvaluation.status !== 'REVIEW_REQUIRED') await tx.notificationEvent.create({ data: { raceResultVersionId: result.id, eventType: 'RACE_EVALUATION_CONFIRMED', status: 'QUEUED', payload: { raceResultVersionId: result.id, raceId } } });
      await tx.race.update({ where: { id: raceId }, data: { status: input.raceCanceled ? 'CANCELED' : 'FINISHED', revision: { increment: 1 } } });
      await this.auth.audit(tx, req, 'RACE_RESULT_CONFIRM', raceId, reason, { resultVersionId: result.id, version: result.version, sourceRevision: revision, ruleVersion: evaluationRuleVersion, predictionVersions: evaluations.length });
      return { versionId: result.id, version: result.version, alreadyConfirmed: false };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Get('races/:raceId/result')
  async publicResult(@Param('raceId') raceId: string) {
    z.string().uuid().parse(raceId);
    const value = await this.auth.db.raceResultVersion.findFirst({
      where: { raceId },
      orderBy: { version: 'desc' },
      include: {
        race: { include: { entries: { select: { id: true, number: true, horseName: true } } } },
        predictionEvaluations: { select: { status: true, primaryFinishedFirst: true, primaryFinishedTop2: true, primaryFinishedTop3: true, winnerInRecommended: true, predictionVersion: { select: { version: true, confidence: true, publishedAt: true } } } }
      }
    });
    if (!value) return { confirmed: false };
    const entries = z.array(z.object({ entryId: z.string(), status: z.string(), finishPosition: z.number().nullable(), popularity: z.number().nullable(), finalOdds: z.string().nullable() })).parse(value.entriesSnapshot);
    const names = new Map(value.race.entries.map(entry => [entry.id, entry]));
    return { confirmed: true, version: value.version, ruleVersion: value.ruleVersion, raceCanceled: value.raceCanceled, confirmedAt: value.confirmedAt, entries: entries.map(entry => ({ ...entry, number: names.get(entry.entryId)?.number, horseName: names.get(entry.entryId)?.horseName })), evaluations: value.predictionEvaluations };
  }

  @Get('results/stats')
  async stats() {
    const versions = await this.auth.db.raceResultVersion.findMany({ orderBy: [{ raceId: 'asc' }, { version: 'desc' }], include: { race: { select: { venue: true, surface: true, raceDate: true } }, predictionEvaluations: { include: { predictionVersion: { select: { confidence: true } } } } } });
    const latestByRace = new Map<string, typeof versions[number]>();
    for (const value of versions) if (!latestByRace.has(value.raceId)) latestByRace.set(value.raceId, value);
    const items = [...latestByRace.values()].flatMap(value => value.predictionEvaluations.map(evaluation => ({ ...evaluation, status: z.enum(['PRIMARY_WIN', 'PRIMARY_TOP2', 'PRIMARY_TOP3', 'WINNER_IN_RECOMMENDED', 'WINNER_NOT_RECOMMENDED', 'SKIPPED', 'EXCLUDED', 'CANCELED', 'REVIEW_REQUIRED']).parse(evaluation.status), venue: value.race.venue, surface: value.race.surface, month: value.race.raceDate.slice(0, 7), confidence: evaluation.predictionVersion.confidence })));
    const groups = (key: 'venue' | 'surface' | 'month' | 'confidence') => {
      const grouped = new Map<string, typeof items>();
      for (const item of items) { const value = item[key] ?? '未設定'; grouped.set(value, [...(grouped.get(value) ?? []), item]); }
      return [...grouped].map(([value, rows]) => ({ value, ...aggregatePredictionEvaluations(rows) }));
    };
    return { ruleVersion: evaluationRuleVersion, scope: '公開版別の馬評価集計', overall: aggregatePredictionEvaluations(items), byConfidence: groups('confidence'), byVenue: groups('venue'), bySurface: groups('surface'), byMonth: groups('month') };
  }
}
