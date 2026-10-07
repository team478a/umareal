import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { canManage, CsvRaceDataProvider, dateSchema, entryInputSchema, horseIdentityCorrectionInputSchema, horseIdentityCorrectionResponseSchema, horseIdentityHistoryResponseSchema, horseIdentityResolutionInputSchema, horseIdentityResolutionResponseSchema, horseIdentityReviewQuerySchema, horseIdentityReviewResponseSchema, jraVanBundleFormatVersion, jstDate, manualEntryBatchInputSchema, manualEntryInputSchema, parseJraVanRaceBundle, raceDataModeLabels, raceDaySchema, raceExpertListQuerySchema, raceExpertListResponseSchema, raceInputSchema, raceOperationHistoryResponseSchema, requiresMfa, resolveRaceDataMode, venues, type ManualEntryInput } from '@keiba/domain';
import type { EntryInput, ImportKind, RaceInput } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

const reasonSchema = z.string().trim().min(1).max(500);
const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) });
const bundleInputSchema = z.object({
  manifest: z.string().min(1).max(30000), racesCsv: z.string().min(1).max(90000),
  entries: z.array(z.object({ path: z.string().min(1).max(160), csv: z.string().min(1).max(90000) }).strict()).min(1).max(36)
}).strict().refine(value => value.manifest.length + value.racesCsv.length + value.entries.reduce((total, file) => total + file.path.length + file.csv.length, 0) <= 90000, '一括取込データは合計90,000文字以内にしてください。');
const bundleStoredSchema = z.object({
  formatVersion: z.literal(jraVanBundleFormatVersion), targetDate: dateSchema, sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/), resultsIncluded: z.boolean(),
  races: z.array(raceInputSchema).min(1).max(36),
  entryGroups: z.array(z.object({ path: z.string().min(1).max(160), raceDate: dateSchema, venue: z.enum(venues), number: z.number().int().min(1).max(12), entries: z.array(entryInputSchema).min(1).max(18) }).strict()).min(1).max(36)
}).strict();
const fullRace = { entries: { orderBy: { number: 'asc' as const } }, assignments: { orderBy: { userId: 'asc' as const }, include: { user: { select: { displayName: true } } } } };
type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type Rows = { races: RaceInput[]; entries: EntryInput[] };
type Change = { key: string; action: '追加' | '変更' | '変更なし'; fields: { field: string; before: unknown; after: unknown }[] };
function differences(before: Record<string, unknown> | null, after: Record<string, unknown>) {
  return Object.entries(after).filter(([field, value]) => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(value)).map(([field, value]) => ({ field, before: before?.[field] ?? null, after: value }));
}
@Controller('admin')
export class RacesController {
  private provider = new CsvRaceDataProvider();
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  private async staff(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN', 'OPERATOR'])) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'レース管理の権限と二段階認証を確認してください。' });
    return actor;
  }
  private async admin(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN'])) throw new ForbiddenException({ code: actor.role === 'ADMIN' ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'Identityの訂正には管理者権限と二段階認証が必要です。' });
    return actor;
  }
  // One small management transaction at a time; the worker never holds this lock for I/O.
  private async locked<T>(work: (tx: Tx) => Promise<T>) {
    return this.auth.db.$transaction(async tx => { await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`; return work(tx); }, { timeout: 20000, maxWait: 10000 });
  }
  private async ensureCsvEnabled(tx: Tx) {
    const settings = await tx.systemSetting.findUnique({ where: { id: 'global' }, select: { csvImportEnabled: true } });
    if (settings && !settings.csvImportEnabled) throw new ForbiddenException({ code: 'CSV_IMPORT_STOPPED', message: '管理設定によりCSV取込を停止しています。' });
  }
  @Get('horse-identities/review') async horseIdentities(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req); const { page, limit, date, raceId } = horseIdentityReviewQuerySchema.parse(query);
    const entryWhere: Prisma.RaceEntryWhereInput = { ...(raceId ? { raceId } : {}), ...(date ? { race: { raceDate: date } } : {}) };
    const filteredByRace = Boolean(date || raceId);
    const where: Prisma.HorseExternalIdentityWhereInput = {
      provider: 'MANUAL',
      matchStatus: { in: ['POSSIBLE_DUPLICATE', 'UNRESOLVED'] },
      ...(filteredByRace ? { horse: { entries: { some: entryWhere } } } : {})
    };
    const [identities, total] = await this.auth.db.$transaction([
      this.auth.db.horseExternalIdentity.findMany({
        where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
        include: { horse: { include: { _count: { select: { entries: true } }, entries: { where: filteredByRace ? entryWhere : {}, orderBy: [{ race: { startsAt: 'asc' } }, { number: 'asc' }], select: { number: true, race: { select: { id: true, raceDate: true, venue: true, number: true, name: true } } } } } } }
      }),
      this.auth.db.horseExternalIdentity.count({ where })
    ]);
    const items = await Promise.all(identities.map(async identity => {
      if (!identity.horse) throw new ConflictException({ code: 'PROVISIONAL_HORSE_MISSING', message: '暫定馬の参照がありません。データを確認してください。' });
      const candidates = await this.auth.db.horse.findMany({
        where: { name: identity.observedName, id: { not: identity.horse.id } },
        orderBy: { id: 'asc' }, take: 20, include: { _count: { select: { entries: true } } }
      });
      return {
        id: identity.id, provider: identity.provider, observedName: identity.observedName, matchStatus: identity.matchStatus, createdAt: identity.createdAt.toISOString(),
        provisionalHorse: { id: identity.horse.id, name: identity.horse.name, entryCount: identity.horse._count.entries },
        candidates: candidates.map(candidate => ({ id: candidate.id, name: candidate.name, entryCount: candidate._count.entries })),
        races: identity.horse.entries.map(entry => ({ raceId: entry.race.id, raceDate: entry.race.raceDate, venue: entry.race.venue, number: entry.race.number, name: entry.race.name, entryNumber: entry.number }))
      };
    }));
    return horseIdentityReviewResponseSchema.parse({ items, total, page, limit });
  }
  @Post('horse-identities/:id/resolve') async resolveHorseIdentity(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    await this.staff(req); z.string().uuid().parse(id); const input = horseIdentityResolutionInputSchema.parse(body);
    return this.mutate(req, `horse-identity:${id}`, body, async tx => {
      const identity = await tx.horseExternalIdentity.findUnique({ where: { id }, include: { horse: true } });
      if (!identity || identity.provider !== 'MANUAL' || !identity.horse) throw new NotFoundException();
      if (identity.matchStatus === 'MATCHED') throw new ConflictException({ code: 'HORSE_IDENTITY_ALREADY_RESOLVED', message: 'この暫定Identityは確認済みです。' });
      if (input.decision === 'CONFIRM_DISTINCT' && input.resolvedHorseId !== identity.horse.id) throw new BadRequestException({ code: 'INVALID_DISTINCT_HORSE', message: '別馬として確定する場合は暫定馬を選択してください。' });
      const target = await tx.horse.findUnique({ where: { id: input.resolvedHorseId }, select: { id: true, name: true } });
      if (!target) throw new BadRequestException({ code: 'HORSE_NOT_FOUND', message: '紐付け先の馬が見つかりません。' });
      if (input.decision === 'MATCH_EXISTING' && (target.id === identity.horse.id || target.name !== identity.observedName)) throw new BadRequestException({ code: 'INVALID_HORSE_IDENTITY_MATCH', message: '同名の既存馬だけを紐付け先に選択できます。' });
      const updated = await tx.horseExternalIdentity.update({ where: { id }, data: { horseId: target.id, matchStatus: 'MATCHED', lastObservedAt: new Date(), updatedAt: new Date() } });
      await this.log(tx, req, 'HORSE_IDENTITY_RESOLVE', 'HORSE_EXTERNAL_IDENTITY', id, input.reason, {
        decision: input.decision,
        before: { horseId: identity.horse.id, horseName: identity.horse.name, matchStatus: identity.matchStatus },
        after: { horseId: target.id, horseName: target.name, matchStatus: updated.matchStatus },
        raceEntriesRewritten: false
      });
      return horseIdentityResolutionResponseSchema.parse({ id: updated.id, decision: input.decision, horseId: updated.horseId, matchStatus: updated.matchStatus });
    });
  }
  @Get('horse-identities/history') async horseIdentityHistory(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req); const { page, limit } = pageSchema.parse(query);
    const where = { provider: 'MANUAL', matchStatus: 'MATCHED' };
    const [identities, total] = await this.auth.db.$transaction([
      this.auth.db.horseExternalIdentity.findMany({
        where, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
        include: { horse: { include: { _count: { select: { entries: true } } } } }
      }),
      this.auth.db.horseExternalIdentity.count({ where })
    ]);
    const ids = identities.map(identity => identity.id);
    const audits = ids.length ? await this.auth.db.auditLog.findMany({
      where: { targetType: 'HORSE_EXTERNAL_IDENTITY', targetId: { in: ids }, action: { in: ['HORSE_IDENTITY_RESOLVE', 'HORSE_IDENTITY_CORRECT'] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]
    }) : [];
    const actorIds = [...new Set(audits.flatMap(audit => audit.actorId ? [audit.actorId] : []))];
    const actors = actorIds.length ? await this.auth.db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
    const actorNames = new Map(actors.map(actor => [actor.id, actor.displayName]));
    const items = await Promise.all(identities.map(async identity => {
      if (!identity.horse) throw new ConflictException({ code: 'RESOLVED_HORSE_MISSING', message: '確認済みIdentityの参照先がありません。' });
      const candidates = await this.auth.db.horse.findMany({
        where: { name: identity.observedName, id: { not: identity.horse.id } }, orderBy: { id: 'asc' }, take: 20,
        include: { _count: { select: { entries: true } } }
      });
      return {
        id: identity.id, provider: identity.provider, observedName: identity.observedName, matchStatus: 'MATCHED' as const, updatedAt: identity.updatedAt.toISOString(),
        currentHorse: { id: identity.horse.id, name: identity.horse.name, entryCount: identity.horse._count.entries },
        candidates: candidates.map(candidate => ({ id: candidate.id, name: candidate.name, entryCount: candidate._count.entries })),
        history: audits.filter(audit => audit.targetId === identity.id).map(audit => ({
          id: audit.id, action: audit.action as 'HORSE_IDENTITY_RESOLVE' | 'HORSE_IDENTITY_CORRECT', reason: audit.reason,
          actorRole: audit.actorRole, actorDisplayName: audit.actorId ? actorNames.get(audit.actorId) ?? null : null,
          createdAt: audit.createdAt.toISOString(), requestId: audit.requestId
        }))
      };
    }));
    return horseIdentityHistoryResponseSchema.parse({ items, total, page, limit });
  }
  @Post('horse-identities/:id/correct') async correctHorseIdentity(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    await this.admin(req); z.string().uuid().parse(id); const input = horseIdentityCorrectionInputSchema.parse(body);
    return this.mutate(req, `horse-identity-correction:${id}`, body, async tx => {
      const identity = await tx.horseExternalIdentity.findUnique({ where: { id }, include: { horse: true } });
      if (!identity || identity.provider !== 'MANUAL' || !identity.horse) throw new NotFoundException();
      if (identity.matchStatus !== 'MATCHED') throw new ConflictException({ code: 'HORSE_IDENTITY_NOT_RESOLVED', message: '未確認のIdentityは訂正ではなく確認操作を行ってください。' });
      if (identity.horse.id !== input.expectedHorseId || identity.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new ConflictException({ code: 'STALE_HORSE_IDENTITY', message: '別の操作でIdentityが更新されています。再読み込みしてください。' });
      if (input.resolvedHorseId === identity.horse.id) throw new BadRequestException({ code: 'HORSE_IDENTITY_UNCHANGED', message: '現在とは異なる紐付け先を選択してください。' });
      const target = await tx.horse.findUnique({ where: { id: input.resolvedHorseId }, select: { id: true, name: true } });
      if (!target || target.name !== identity.observedName) throw new BadRequestException({ code: 'INVALID_HORSE_IDENTITY_CORRECTION', message: '同名の既存馬だけを訂正先に選択できます。' });
      const updated = await tx.horseExternalIdentity.update({ where: { id }, data: { horseId: target.id, lastObservedAt: new Date(), updatedAt: new Date() } });
      await this.log(tx, req, 'HORSE_IDENTITY_CORRECT', 'HORSE_EXTERNAL_IDENTITY', id, input.reason, {
        before: { horseId: identity.horse.id, horseName: identity.horse.name, matchStatus: identity.matchStatus },
        after: { horseId: target.id, horseName: target.name, matchStatus: updated.matchStatus },
        raceEntriesRewritten: false, previousAuditPreserved: true
      });
      return horseIdentityCorrectionResponseSchema.parse({ id: updated.id, horseId: updated.horseId, matchStatus: updated.matchStatus, updatedAt: updated.updatedAt.toISOString() });
    });
  }
  @Get('race-data-status') async dataStatus(@Req() req: AppRequest) {
    await this.staff(req);
    const mode = resolveRaceDataMode(process.env.RACE_DATA_MODE);
    return { mode, label: raceDataModeLabels[mode], operationalStatus: 'NORMAL' as const, externalIntegration: ['JRA_VAN', 'OTHER_PROVIDER'].includes(mode) ? 'CONFIGURED_EXTERNALLY' as const : 'NOT_USED' as const };
  }
  private log(tx: Tx, req: AppRequest, action: string, targetType: string, targetId: string, reason: string, details: unknown) {
    return tx.auditLog.create({ data: { actorId: req.auth!.id, actorRole: req.auth!.role, action, targetType, targetId, reason, details: json(details), requestId: req.requestId } });
  }
  private async mutate(req: AppRequest, operation: string, input: unknown, work: (tx: Tx) => Promise<unknown>) {
    const key = `races:${req.auth!.id}:${operation}:${z.string().uuid().parse(req.headers['idempotency-key'])}`;
    const requestHash = hashToken(JSON.stringify(input));
    return this.locked(async tx => {
      const previous = await tx.idempotencyKey.findUnique({ where: { key } });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じリクエストキーの内容が変わっています。' });
        return previous.response;
      }
      const response = json(await work(tx));
      await tx.idempotencyKey.create({ data: { key, requestHash, response } });
      return response;
    });
  }
  @Get('race-days') async days(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req); const { page, limit } = pageSchema.parse(query);
    const [items, total] = await this.auth.db.$transaction([
      this.auth.db.raceDay.findMany({ orderBy: [{ raceDate: 'desc' }, { venue: 'asc' }], include: { _count: { select: { races: true } } }, skip: (page - 1) * limit, take: limit }), this.auth.db.raceDay.count()
    ]); return { items, total, page, limit };
  }
  @Post('race-days') async day(@Req() req: AppRequest, @Body() body: unknown) {
    await this.staff(req); const { day, reason } = z.object({ day: raceDaySchema, reason: reasonSchema }).strict().parse(body);
    return this.mutate(req, 'day', body, async tx => {
      const result = await tx.raceDay.create({ data: day });
      await this.log(tx, req, 'RACE_DAY_CREATE', 'RACE_DAY', result.id, reason, { after: result }); return result;
    });
  }
  @Get('race-experts') async experts(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req); const { page, limit, search } = raceExpertListQuerySchema.parse(query);
    const where: Prisma.UserWhereInput = { role: 'EXPERT', disabledAt: null, ...(search ? { displayName: { contains: search, mode: 'insensitive' } } : {}) };
    const [items, total] = await this.auth.db.$transaction([
      this.auth.db.user.findMany({ where, select: { id: true, displayName: true }, orderBy: [{ displayName: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }), this.auth.db.user.count({ where })
    ]); return raceExpertListResponseSchema.parse({ items, total, page, limit, search: search ?? null });
  }
  @Get('races') async races(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req); const { page, limit, date } = pageSchema.extend({ date: dateSchema.default(jstDate(new Date())) }).parse(query);
    const [items, total] = await this.auth.db.$transaction([
      this.auth.db.race.findMany({ where: { raceDate: date }, orderBy: [{ venue: 'asc' }, { number: 'asc' }], include: { assignments: { include: { user: { select: { displayName: true } } } }, announcements: { orderBy: { version: 'desc' }, take: 1, select: { id: true, version: true, publishedAt: true } }, _count: { select: { entries: true } } }, skip: (page - 1) * limit, take: limit }), this.auth.db.race.count({ where: { raceDate: date } })
    ]); return { items, total, page, limit };
  }
  @Get('races/:id') async detail(@Req() req: AppRequest, @Param('id') id: string) {
    await this.staff(req); z.string().uuid().parse(id);
    const race = await this.auth.db.race.findUnique({ where: { id }, include: fullRace });
    if (!race) throw new NotFoundException(); return race;
  }
  @Get('races/:id/history') async raceHistory(@Req() req: AppRequest, @Param('id') id: string, @Query() query: unknown) {
    await this.staff(req); z.string().uuid().parse(id); const { page, limit } = pageSchema.parse(query);
    const race = await this.auth.db.race.findUnique({ where: { id }, select: { id: true, entries: { select: { id: true } }, announcements: { select: { id: true } } } });
    if (!race) throw new NotFoundException();
    const relatedIds = [id, ...race.entries.map(entry => entry.id), ...race.announcements.map(announcement => announcement.id)];
    const where: Prisma.AuditLogWhereInput = { OR: [{ targetId: { in: relatedIds } }, { details: { path: ['raceId'], equals: id } }] };
    const [audits, total] = await this.auth.db.$transaction([
      this.auth.db.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
      this.auth.db.auditLog.count({ where })
    ]);
    const actorIds = [...new Set(audits.flatMap(audit => audit.actorId ? [audit.actorId] : []))];
    const actors = actorIds.length ? await this.auth.db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
    const actorNames = new Map(actors.map(actor => [actor.id, actor.displayName]));
    const sourceType = (action: string) => action.startsWith('JRA_VAN_') ? 'JRA_VAN' as const : action.startsWith('CSV_') ? 'CSV' as const : ['RACE_CREATE', 'RACE_UPDATE', 'ENTRY_SAVE', 'MANUAL_ENTRY_CREATE', 'MANUAL_ENTRY_BATCH_CREATE', 'RACE_ANNOUNCE'].includes(action) ? 'MANUAL' as const : 'UMAREAL' as const;
    return raceOperationHistoryResponseSchema.parse({
      items: audits.map(audit => ({ id: audit.id, action: audit.action, targetType: audit.targetType, targetId: audit.targetId, reason: audit.reason, actorRole: audit.actorRole, actorDisplayName: audit.actorId ? actorNames.get(audit.actorId) ?? null : null, sourceType: sourceType(audit.action), createdAt: audit.createdAt.toISOString(), requestId: audit.requestId })),
      total, page, limit
    });
  }
  @Post('races/:id/announce') async announce(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().uuid().parse(id);
    const { reason } = z.object({ reason: reasonSchema }).strict().parse(body);
    return this.mutate(req, `announce:${id}`, body, async tx => {
      const race = await tx.race.findUnique({ where: { id }, include: { announcements: { orderBy: { version: 'desc' }, take: 1 } } });
      if (!race) throw new NotFoundException();
      if (race.startsAt <= new Date() || ['FINISHED', 'CANCELLED'].includes(race.status)) throw new ConflictException({ code: 'RACE_ANNOUNCEMENT_CLOSED', message: '発走済み・終了・中止のレースは告知できません。' });
      const announcement = await tx.raceAnnouncement.create({ data: { raceId: id, version: (race.announcements[0]?.version ?? 0) + 1, publishedBy: actor.id, reason } });
      await tx.notificationEvent.create({ data: { announcementId: announcement.id, eventType: 'RACE_ANNOUNCED', status: 'QUEUED', payload: json({ announcementId: announcement.id, raceId: id, visibility: 'FREE' }) } });
      await this.log(tx, req, 'RACE_ANNOUNCE', 'RACE_ANNOUNCEMENT', announcement.id, reason, { raceId: id, version: announcement.version });
      return { id: announcement.id, raceId: id, version: announcement.version, publishedAt: announcement.publishedAt };
    });
  }
  private async validateExpert(tx: Tx, id: string | null) {
    if (id && !await tx.user.findFirst({ where: { id, role: 'EXPERT', disabledAt: null } })) throw new BadRequestException({ code: 'INVALID_EXPERT', message: '有効な予想担当を選択してください。' });
  }
  private async saveRace(tx: Tx, input: RaceInput, id?: string) {
    await this.validateExpert(tx, input.expertId);
    const { expertId, ...data } = input;
    const day = await tx.raceDay.upsert({ where: { raceDate_venue: { raceDate: input.raceDate, venue: input.venue } }, create: { raceDate: input.raceDate, venue: input.venue }, update: {} });
    const race = id ? await tx.race.update({ where: { id }, data: { ...data, raceDayId: day.id, revision: { increment: 1 } } }) : await tx.race.create({ data: { ...data, raceDayId: day.id } });
    await tx.expertAssignment.deleteMany({ where: { raceId: race.id } });
    if (expertId) await tx.expertAssignment.create({ data: { raceId: race.id, userId: expertId } });
    return tx.race.findUniqueOrThrow({ where: { id: race.id }, include: fullRace });
  }
  @Post('races') async create(@Req() req: AppRequest, @Body() body: unknown) {
    await this.staff(req); const { race, reason } = z.object({ race: raceInputSchema, reason: reasonSchema }).strict().parse(body);
    return this.mutate(req, 'create', body, async tx => {
      const result = await this.saveRace(tx, race);
      await this.log(tx, req, 'RACE_CREATE', 'RACE', result.id, reason, { after: result }); return result;
    });
  }
  @Patch('races/:id') async update(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    await this.staff(req); z.string().uuid().parse(id);
    const { race, revision, reason } = z.object({ race: raceInputSchema, revision: z.number().int().positive(), reason: reasonSchema }).strict().parse(body);
    return this.mutate(req, `update:${id}`, body, async tx => {
      const before = await tx.race.findUnique({ where: { id }, include: fullRace });
      if (!before) throw new NotFoundException();
      if (before.revision !== revision) throw new ConflictException({ code: 'STALE_REVISION', message: '他の操作で変更されました。再読み込みして確認してください。' });
      if (before.raceDate !== race.raceDate || before.venue !== race.venue || before.number !== race.number) throw new BadRequestException({ code: 'RACE_KEY_LOCKED', message: '開催日・競馬場・レース番号は変更できません。' });
      const after = await this.saveRace(tx, race, id);
      await this.log(tx, req, 'RACE_UPDATE', 'RACE', id, reason, { before, after, startsAtChanged: before.startsAt.toISOString() !== after.startsAt.toISOString() }); return after;
    });
  }
  private async saveEntry(tx: Tx, raceId: string, entry: EntryInput) {
    const existing = await tx.raceEntry.findUnique({ where: { raceId_number: { raceId, number: entry.number } }, include: { assessment: true } });
    if (existing?.assessment && existing.horseId !== entry.horseId) throw new ConflictException({ code: 'ASSESSED_HORSE_LOCKED', message: '評価履歴のある出走馬の馬IDは変更できません。' });
    const sameHorse = await tx.raceEntry.findUnique({ where: { raceId_horseId: { raceId, horseId: entry.horseId } } });
    if (sameHorse && sameHorse.number !== entry.number) throw new ConflictException({ code: 'HORSE_ALREADY_ENTERED', message: 'この馬IDは別の馬番で登録されています。' });
    await tx.horse.upsert({ where: { id: entry.horseId }, create: { id: entry.horseId, name: entry.horseName }, update: {} });
    return tx.raceEntry.upsert({ where: { raceId_number: { raceId, number: entry.number } }, create: { ...entry, raceId }, update: entry });
  }
  @Post('races/:id/entries') async entry(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    await this.staff(req); z.string().uuid().parse(id);
    const { entry, entryId, revision, reason } = z.object({ entry: entryInputSchema, entryId: z.string().uuid().optional(), revision: z.number().int().positive(), reason: reasonSchema }).strict().parse(body);
    return this.mutate(req, `entry:${id}`, body, async tx => {
      const before = await tx.race.findUnique({ where: { id }, include: fullRace });
      if (!before) throw new NotFoundException();
      if (before.revision !== revision) throw new ConflictException({ code: 'STALE_REVISION', message: '他の操作で変更されました。再読み込みしてください。' });
      if (entryId && !before.entries.some(e => e.id === entryId && e.number === entry.number)) throw new BadRequestException({ code: 'ENTRY_KEY_LOCKED', message: '編集対象の馬番は変更できません。' });
      if (!entryId && before.entries.some(e => e.number === entry.number)) throw new ConflictException({ code: 'ENTRY_ALREADY_EXISTS', message: 'この馬番は登録済みです。出走馬一覧の編集から変更してください。' });
      const saved = await this.saveEntry(tx, id, entry);
      await tx.race.update({ where: { id }, data: { revision: { increment: 1 } } });
      await this.log(tx, req, 'ENTRY_SAVE', 'RACE_ENTRY', saved.id, reason, { before: before.entries.find(e => e.number === entry.number) ?? null, after: saved }); return saved;
    });
  }
  @Post('races/:id/entries/manual') async manualEntry(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    await this.staff(req); z.string().uuid().parse(id);
    const { entry, revision, reason } = z.object({ entry: manualEntryInputSchema, revision: z.number().int().positive(), reason: reasonSchema }).strict().parse(body);
    return this.mutate(req, `manual-entry:${id}`, body, async tx => {
      const before = await tx.race.findUnique({ where: { id }, include: fullRace });
      if (!before) throw new NotFoundException();
      if (before.revision !== revision) throw new ConflictException({ code: 'STALE_REVISION', message: '他の操作で変更されました。再読み込みしてください。' });
      if (before.entries.some(item => item.number === entry.number)) throw new ConflictException({ code: 'ENTRY_ALREADY_EXISTS', message: 'この馬番は登録済みです。出走馬一覧の編集から変更してください。' });
      const { saved, identity, duplicateCandidates } = await this.createManualEntry(tx, id, entry);
      await tx.race.update({ where: { id }, data: { revision: { increment: 1 } } });
      await this.log(tx, req, 'MANUAL_ENTRY_CREATE', 'RACE_ENTRY', saved.id, reason, { after: saved, identityId: identity.id, identityProvider: identity.provider, identityStatus: identity.matchStatus, duplicateCandidateHorseIds: duplicateCandidates.map(candidate => candidate.id) });
      return { entry: saved, identity: { id: identity.id, provider: identity.provider, status: identity.matchStatus, duplicateCandidateCount: duplicateCandidates.length } };
    });
  }
  private async createManualEntry(tx: Tx, raceId: string, entry: ManualEntryInput) {
    const duplicateCandidates = await tx.horse.findMany({ where: { name: entry.horseName }, select: { id: true }, take: 20 });
    const horse = await tx.horse.create({ data: { id: randomUUID(), name: entry.horseName } });
    const now = new Date();
    const identity = await tx.horseExternalIdentity.create({ data: {
      horseId: horse.id, provider: 'MANUAL', externalKeyHash: hashToken(`MANUAL\0${randomUUID()}`), sourceVersion: 'MANUAL_OPERATION_V1', observedName: entry.horseName,
      matchStatus: duplicateCandidates.length ? 'POSSIBLE_DUPLICATE' : 'UNRESOLVED', firstObservedAt: now, lastObservedAt: now
    } });
    const saved = await tx.raceEntry.create({ data: { raceId, horseId: horse.id, number: entry.number, horseName: entry.horseName, gate: null, sex: null, age: null, carriedWeight: null, jockey: null, trainer: null, winOdds: null, popularity: null, status: 'ACTIVE' } });
    return { saved, identity, duplicateCandidates };
  }
  @Post('races/:id/entries/manual-batch') async manualEntryBatch(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    await this.staff(req); z.string().uuid().parse(id);
    const { entries, revision, reason } = z.object({ entries: manualEntryBatchInputSchema, revision: z.number().int().positive(), reason: reasonSchema }).strict().parse(body);
    return this.mutate(req, `manual-entry-batch:${id}`, body, async tx => {
      const before = await tx.race.findUnique({ where: { id }, include: fullRace });
      if (!before) throw new NotFoundException();
      if (before.revision !== revision) throw new ConflictException({ code: 'STALE_REVISION', message: '他の操作で変更されました。再読み込みしてください。' });
      const occupied = entries.filter(entry => before.entries.some(item => item.number === entry.number)).map(entry => entry.number);
      if (occupied.length) throw new ConflictException({ code: 'ENTRY_ALREADY_EXISTS', message: `登録済みの馬番があります（${occupied.join('、')}番）。出走馬一覧を確認してください。` });
      const created = [];
      for (const entry of entries) created.push(await this.createManualEntry(tx, id, entry));
      await tx.race.update({ where: { id }, data: { revision: { increment: 1 } } });
      await this.log(tx, req, 'MANUAL_ENTRY_BATCH_CREATE', 'RACE', id, reason, {
        entryCount: created.length,
        entries: created.map(item => ({ entryId: item.saved.id, number: item.saved.number, horseName: item.saved.horseName, identityId: item.identity.id, identityStatus: item.identity.matchStatus, duplicateCandidateHorseIds: item.duplicateCandidates.map(candidate => candidate.id) }))
      });
      return {
        entries: created.map(item => ({ entry: item.saved, identity: { id: item.identity.id, provider: item.identity.provider, status: item.identity.matchStatus, duplicateCandidateCount: item.duplicateCandidates.length } })),
        duplicateNames: created.filter(item => item.duplicateCandidates.length).map(item => item.saved.horseName)
      };
    });
  }
  private async snapshot(tx: Tx, kind: ImportKind, rows: Rows, raceId?: string) {
    if (kind === 'entries') {
      const race = await tx.race.findUnique({ where: { id: raceId! }, include: fullRace });
      if (!race) throw new NotFoundException();
      return [race];
    }
    return Promise.all(rows.races.map(row => tx.race.findUnique({ where: { raceDate_venue_number: { raceDate: row.raceDate, venue: row.venue, number: row.number } }, include: fullRace })));
  }
  private async diff(tx: Tx, kind: ImportKind, rows: Rows, raceId?: string) {
    const before = await this.snapshot(tx, kind, rows, raceId); const changes: Change[] = [];
    if (kind === 'races') {
      for (const [index, row] of rows.races.entries()) {
        await this.validateExpert(tx, row.expertId);
        const old = before[index]; const fields = differences(old ? { ...old, startsAt: old.startsAt.toISOString(), expertId: old.assignments[0]?.userId ?? null } : null, { ...row, startsAt: new Date(row.startsAt).toISOString() });
        changes.push({ key: `${row.raceDate} ${row.venue} ${row.number}R`, action: !old ? '追加' : fields.length ? '変更' : '変更なし', fields });
      }
    } else {
      for (const row of rows.entries) {
        const old = before[0]!.entries.find(e => e.number === row.number);
        const other = before[0]!.entries.find(e => e.horseId === row.horseId && e.number !== row.number);
        if (other) throw new ConflictException({ code: 'HORSE_ALREADY_ENTERED', message: `馬番${row.number}の馬IDは馬番${other.number}で登録済みです。` });
        const fields = differences(old ? { ...old, carriedWeight: Number(old.carriedWeight), winOdds: old.winOdds === null ? null : Number(old.winOdds) } : null, row);
        changes.push({ key: `${row.number}番 ${row.horseName}`, action: !old ? '追加' : fields.length ? '変更' : '変更なし', fields });
      }
    }
    return { baselineHash: hashToken(JSON.stringify(before)), changes };
  }
  private async bundleAnalysis(tx: Tx, races: RaceInput[], entryGroups: z.infer<typeof bundleStoredSchema>['entryGroups']) {
    const before = await Promise.all(races.map(row => tx.race.findUnique({ where: { raceDate_venue_number: { raceDate: row.raceDate, venue: row.venue, number: row.number } }, include: fullRace })));
    const raceChanges: Change[] = [], entryChanges: Change[] = [];
    for (const [index, row] of races.entries()) {
      await this.validateExpert(tx, row.expertId);
      const old = before[index];
      const fields = differences(old ? { ...old, startsAt: old.startsAt.toISOString(), expertId: old.assignments[0]?.userId ?? null } : null, { ...row, startsAt: new Date(row.startsAt).toISOString() });
      raceChanges.push({ key: `レース · ${row.raceDate} ${row.venue} ${row.number}R`, action: !old ? '追加' : fields.length ? '変更' : '変更なし', fields });
    }
    for (const group of entryGroups) {
      const index = races.findIndex(race => race.raceDate === group.raceDate && race.venue === group.venue && race.number === group.number);
      if (index < 0) throw new BadRequestException({ code: 'BUNDLE_RACE_MISMATCH', message: '出走馬ファイルに対応するレースがありません。' });
      const oldRace = before[index];
      for (const row of group.entries) {
        const old = oldRace?.entries.find(entry => entry.number === row.number);
        const other = oldRace?.entries.find(entry => entry.horseId === row.horseId && entry.number !== row.number);
        if (other) throw new ConflictException({ code: 'HORSE_ALREADY_ENTERED', message: `${group.venue} ${group.number}Rの馬番${row.number}の馬IDは馬番${other.number}で登録済みです。` });
        const fields = differences(old ? { ...old, carriedWeight: Number(old.carriedWeight), winOdds: old.winOdds === null ? null : Number(old.winOdds) } : null, row);
        entryChanges.push({ key: `出走馬 · ${group.venue} ${group.number}R ${row.number}番 ${row.horseName}`, action: !old ? '追加' : fields.length ? '変更' : '変更なし', fields });
      }
    }
    return { before, raceChanges, entryChanges, changes: [...raceChanges, ...entryChanges], baselineHash: hashToken(JSON.stringify(before)) };
  }
  private async confirmedBundleByChecksum(tx: Tx, sourceChecksum: string, excludeBatchId?: string) {
    return tx.importBatch.findFirst({ where: { kind: 'race-day-bundle', confirmedAt: { not: null }, rows: { path: ['sourceChecksum'], equals: sourceChecksum }, ...(excludeBatchId ? { id: { not: excludeBatchId } } : {}) }, orderBy: { confirmedAt: 'desc' } });
  }
  @Post('races/import/bundle/preview') async bundlePreview(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req); const input = bundleInputSchema.parse(body);
    const parsed = parseJraVanRaceBundle(input, hashToken);
    const sourceChecksum = hashToken([parsed.manifest ? JSON.stringify(parsed.manifest) : input.manifest, input.racesCsv, ...[...input.entries].sort((a, b) => a.path.localeCompare(b.path)).flatMap(file => [file.path, file.csv])].join('\0'));
    if (parsed.errors.length || !parsed.manifest) return { errors: parsed.errors, changes: [], batchId: null, sourceChecksum };
    return this.locked(async tx => {
      await this.ensureCsvEnabled(tx);
      const duplicate = await this.confirmedBundleByChecksum(tx, sourceChecksum);
      if (duplicate) return { errors: [{ row: 0, field: 'sourceChecksum', message: '同じ開催日一括データは反映済みです。監査履歴を確認してください。' }], changes: [], batchId: null, sourceChecksum, duplicateOf: { batchId: duplicate.id, confirmedAt: duplicate.confirmedAt } };
      const stored = { formatVersion: parsed.manifest!.formatVersion, targetDate: parsed.manifest!.targetDate, sourceChecksum, resultsIncluded: parsed.manifest!.resultsIncluded, races: parsed.races, entryGroups: parsed.entryGroups };
      const analysis = await this.bundleAnalysis(tx, stored.races, stored.entryGroups);
      const batch = await tx.importBatch.create({ data: { actorId: actor.id, kind: 'race-day-bundle', rows: json(stored), baselineHash: analysis.baselineHash, expiresAt: new Date(Date.now() + 15 * 60000) } });
      return { batchId: batch.id, expiresAt: batch.expiresAt, targetDate: stored.targetDate, sourceChecksum, resultsIncluded: stored.resultsIncluded, raceCount: stored.races.length, entryCount: stored.entryGroups.reduce((total, group) => total + group.entries.length, 0), changes: analysis.changes, errors: [] };
    });
  }
  @Post('races/import/bundle/:batchId/confirm') async bundleConfirm(@Req() req: AppRequest, @Param('batchId') batchId: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().uuid().parse(batchId);
    const { reason } = z.object({ reason: reasonSchema }).strict().parse(body);
    return this.locked(async tx => {
      await this.ensureCsvEnabled(tx);
      const batch = await tx.importBatch.findUnique({ where: { id: batchId } });
      if (!batch || batch.actorId !== actor.id || batch.kind !== 'race-day-bundle' || batch.raceId !== null) throw new NotFoundException();
      const stored = bundleStoredSchema.parse(batch.rows);
      if (batch.confirmedAt) return { confirmed: true, batchId, alreadyConfirmed: true, targetDate: stored.targetDate, raceCount: stored.races.length, entryCount: stored.entryGroups.reduce((total, group) => total + group.entries.length, 0), resultsIncluded: stored.resultsIncluded };
      if (batch.expiresAt <= new Date()) throw new ConflictException({ code: 'PREVIEW_EXPIRED', message: 'プレビューの有効期限が切れました。再確認してください。' });
      const duplicate = await this.confirmedBundleByChecksum(tx, stored.sourceChecksum, batchId);
      if (duplicate) throw new ConflictException({ code: 'DUPLICATE_RACE_DAY_BUNDLE', message: '同じ開催日一括データは反映済みです。監査履歴を確認してください。', previousBatchId: duplicate.id });
      const analysis = await this.bundleAnalysis(tx, stored.races, stored.entryGroups);
      if (analysis.baselineHash !== batch.baselineHash) throw new ConflictException({ code: 'STALE_PREVIEW', message: 'プレビュー後に対象データが変更されました。一括データを再確認してください。' });

      const raceIds = new Map<string, string>();
      for (const [index, row] of stored.races.entries()) {
        const old = analysis.before[index];
        const saved = analysis.raceChanges[index].action === '変更なし' ? old! : await this.saveRace(tx, row, old?.id);
        raceIds.set(`${row.raceDate}:${row.venue}:${row.number}`, saved.id);
      }
      let changedEntries = 0;
      for (const group of stored.entryGroups) {
        const raceId = raceIds.get(`${group.raceDate}:${group.venue}:${group.number}`)!;
        const current = await tx.race.findUniqueOrThrow({ where: { id: raceId }, include: { entries: true } });
        let raceChanged = false;
        for (const row of group.entries) {
          const old = current.entries.find(entry => entry.number === row.number);
          const fields = differences(old ? { ...old, carriedWeight: Number(old.carriedWeight), winOdds: old.winOdds === null ? null : Number(old.winOdds) } : null, row);
          if (!old || fields.length) { await this.saveEntry(tx, raceId, row); raceChanged = true; changedEntries++; }
        }
        if (raceChanged) await tx.race.update({ where: { id: raceId }, data: { revision: { increment: 1 } } });
      }
      await tx.importBatch.update({ where: { id: batchId }, data: { confirmedAt: new Date() } });
      await this.log(tx, req, 'JRA_VAN_RACE_DAY_BUNDLE_IMPORT_CONFIRMED', 'IMPORT_BATCH', batchId, reason, { formatVersion: stored.formatVersion, targetDate: stored.targetDate, sourceChecksum: stored.sourceChecksum, raceCount: stored.races.length, entryCount: stored.entryGroups.reduce((total, group) => total + group.entries.length, 0), changedEntries, resultsIncluded: stored.resultsIncluded });
      return { confirmed: true, batchId, alreadyConfirmed: false, targetDate: stored.targetDate, raceCount: stored.races.length, entryCount: stored.entryGroups.reduce((total, group) => total + group.entries.length, 0), resultsIncluded: stored.resultsIncluded };
    });
  }
  @Post('races/import/preview') async preview(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req);
    const input = z.object({ kind: z.enum(['races', 'entries']), csv: z.string().max(90000), raceId: z.string().uuid().optional() }).strict().refine(v => v.kind === 'races' ? !v.raceId : !!v.raceId, '出走馬CSVには対象レースが必要です。').parse(body);
    const parsed = this.provider.parse(input.kind, input.csv);
    if (parsed.errors.length) return { errors: parsed.errors, changes: [], batchId: null };
    return this.locked(async tx => {
      await this.ensureCsvEnabled(tx);
      const rows = { races: parsed.races, entries: parsed.entries };
      const { baselineHash, changes } = await this.diff(tx, input.kind, rows, input.raceId);
      const batch = await tx.importBatch.create({ data: { actorId: actor.id, kind: input.kind, raceId: input.raceId, rows: json(rows), baselineHash, expiresAt: new Date(Date.now() + 15 * 60000) } });
      return { batchId: batch.id, expiresAt: batch.expiresAt, changes, errors: [] };
    });
  }
  @Post('races/import/:batchId/confirm') async confirm(@Req() req: AppRequest, @Param('batchId') batchId: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().uuid().parse(batchId);
    const { reason } = z.object({ reason: reasonSchema }).strict().parse(body);
    return this.locked(async tx => {
      await this.ensureCsvEnabled(tx);
      const batch = await tx.importBatch.findUnique({ where: { id: batchId } });
      if (!batch || batch.actorId !== actor.id) throw new NotFoundException();
      if (batch.confirmedAt) return { confirmed: true, batchId, alreadyConfirmed: true };
      if (batch.expiresAt <= new Date()) throw new ConflictException({ code: 'PREVIEW_EXPIRED', message: 'プレビューの有効期限が切れました。再確認してください。' });
      const rows = z.object({ races: z.array(raceInputSchema), entries: z.array(entryInputSchema) }).parse(batch.rows);
      const kind = z.enum(['races', 'entries']).parse(batch.kind);
      const { baselineHash, changes } = await this.diff(tx, kind, rows, batch.raceId ?? undefined);
      if (baselineHash !== batch.baselineHash) throw new ConflictException({ code: 'STALE_PREVIEW', message: 'プレビュー後に対象データが変更されました。CSVを再確認してください。' });
      const before = await this.snapshot(tx, kind, rows, batch.raceId ?? undefined);
      if (kind === 'races') { for (const [i, row] of rows.races.entries()) if (changes[i].action !== '変更なし') await this.saveRace(tx, row, before[i]?.id); }
      else {
        for (const [i, row] of rows.entries.entries()) if (changes[i].action !== '変更なし') await this.saveEntry(tx, batch.raceId!, row);
        if (changes.some(c => c.action !== '変更なし')) await tx.race.update({ where: { id: batch.raceId! }, data: { revision: { increment: 1 } } });
      }
      await tx.importBatch.update({ where: { id: batchId }, data: { confirmedAt: new Date() } });
      await this.log(tx, req, 'CSV_IMPORT_CONFIRMED', 'IMPORT_BATCH', batchId, reason, { kind, raceId: batch.raceId, changes });
      return { confirmed: true, batchId, alreadyConfirmed: false };
    });
  }
}
