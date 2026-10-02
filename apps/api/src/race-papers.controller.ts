import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, Body } from '@nestjs/common';
import { Prisma } from '@keiba/db';
import { buildRacePaperNotice, canEditRace, canReadPrediction, paperNameKey, parseRacePaper, racePaperDraftSchema, racePaperImportSchema, racePaperListSchema, racePaperMetadataSchema, racePaperPreviewInputSchema, racePaperPreviewSchema, racePaperReadSchema, racePaperSaveSchema, racePaperSnapshotSchema, racePaperWorkspaceSchema } from '@keiba/domain';
import type { RacePaperDraft, RacePaperSnapshot } from '@keiba/domain';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest, AuthContext } from './context';
import { hashToken } from './security';

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const metadata = (v: { id: string; version: number; publishedAt: Date; targetDate: string; title: string; accessScope: string; correctionReason: string | null }) => racePaperMetadataSchema.parse({ id: v.id, version: v.version, publishedAt: v.publishedAt, targetDate: v.targetDate, title: v.title, accessScope: v.accessScope, correctionReason: v.correctionReason });
const metadataSelect = { id: true, version: true, publishedAt: true, targetDate: true, title: true, accessScope: true, correctionReason: true } as const;

@Controller()
export class RacePapersController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  private locked<T>(work: (tx: Tx) => Promise<T>) {
    return this.auth.db.$transaction(async tx => { await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`; return work(tx); }, { timeout: 20000, maxWait: 10000 });
  }
  private async staff(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!['ADMIN', 'OPERATOR', 'EXPERT'].includes(actor.role) || actor.aal !== 2) throw new ForbiddenException({ code: 'PAPER_ACCESS_DENIED', message: '予想権限と二段階認証が必要です。' });
    return actor;
  }
  private async state(tx: Tx, draft: RacePaperDraft, actor: AuthContext, activeRequired = false) {
    const races = await tx.race.findMany({ where: { id: { in: draft.races.map(r => r.raceId) } }, include: { assignments: true, entries: true } });
    if (races.length !== draft.races.length) throw new BadRequestException({ code: 'PAPER_RACE_MISSING', message: '対象レースを登録してください。' });
    for (const r of races) if (!canEditRace(actor, r.assignments.map(a => a.userId))) throw new ForbiddenException({ code: 'PAPER_ACCESS_DENIED', message: '担当外のレースは操作できません。' });
    const snapshot: RacePaperSnapshot = { targetDate: draft.targetDate, title: draft.title, accessScope: draft.accessScope, summary: draft.summary, races: draft.races.map(input => {
      const r = races.find(r => r.id === input.raceId)!;
      if (r.raceDate !== draft.targetDate) throw new BadRequestException({ code: 'PAPER_DATE_MISMATCH', message: '対象日とレース開催日が一致しません。' });
      return { raceId: r.id, venue: r.venue, number: r.number, name: r.name, startsAt: r.startsAt.toISOString(), marks: input.marks.map(m => {
        const entry = r.entries.find(e => e.id === m.entryId);
        if (!entry || activeRequired && entry.status !== 'ACTIVE') throw new BadRequestException({ code: 'PAPER_ENTRY_INVALID', message: '出走予定の馬だけに印を設定してください。' });
        return { ...m, number: entry.number, horseName: entry.horseName };
      }) };
    }) };
    return { races, snapshot: racePaperSnapshotSchema.parse(snapshot) };
  }
  private async load(tx: Tx, id: string, actor: AuthContext) {
    const paper = await tx.racePaper.findUnique({ where: { id }, include: { versions: { orderBy: { version: 'desc' } } } });
    if (!paper) throw new NotFoundException();
    const draft = racePaperDraftSchema.parse(paper.draft); const state = await this.state(tx, draft, actor);
    // Authorize prior targets too: removing a race must not remove its assignment boundary.
    const priorIds = [...new Set(paper.versions.flatMap(v => racePaperSnapshotSchema.parse(v.snapshot).races.map(r => r.raceId)))];
    const prior = await tx.race.findMany({ where: { id: { in: priorIds } }, include: { assignments: true } });
    if (prior.length !== priorIds.length || prior.some(r => !canEditRace(actor, r.assignments.map(a => a.userId)))) throw new ForbiddenException();
    return { paper, draft, ...state, prior };
  }
  private fingerprint(state: Awaited<ReturnType<RacePapersController['load']>>) {
    // Relation query order is unspecified. Freeze only the publication inputs in a canonical order.
    const assignments = (rows: { userId: string }[]) => rows.map(a => a.userId).sort();
    const races = state.races.map(r => ({ id: r.id, raceDate: r.raceDate, venue: r.venue, number: r.number, name: r.name, startsAt: r.startsAt.toISOString(), status: r.status, assignments: assignments(r.assignments), entries: r.entries.map(e => ({ id: e.id, number: e.number, horseName: e.horseName, status: e.status })).sort((a, b) => a.id.localeCompare(b.id)) })).sort((a, b) => a.id.localeCompare(b.id));
    const prior = state.prior.map(r => ({ id: r.id, startsAt: r.startsAt.toISOString(), status: r.status, assignments: assignments(r.assignments) })).sort((a, b) => a.id.localeCompare(b.id));
    return hashToken(JSON.stringify({ revision: state.paper.revision, draft: state.draft, latest: state.paper.versions[0]?.id, races, prior }));
  }
  private async publication(tx: Tx, actor: AuthContext, state: Awaited<ReturnType<RacePapersController['load']>>, correctionReason: string) {
    await this.state(tx, state.draft, actor, true);
    const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { predictionPublicationEnabled: true, predictionCorrectionPolicy: true, delayedPublicationPolicy: true } });
    if (!settings.predictionPublicationEnabled) throw new ForbiddenException({ code: 'PREDICTION_PUBLICATION_STOPPED', message: '予想公開は停止中です。' });
    if (state.paper.versions.length) {
      if (actor.role !== 'ADMIN' && !(actor.role === 'EXPERT' && settings.predictionCorrectionPolicy === 'EXPERT_OR_ADMIN')) throw new ForbiddenException({ code: 'CORRECTION_APPROVAL_REQUIRED', message: '訂正版公開の権限を確認してください。' });
      if (!correctionReason) throw new BadRequestException({ code: 'CORRECTION_REASON_REQUIRED', message: '訂正理由を入力してください。' });
      if (state.paper.versions[0].targetDate !== state.draft.targetDate) throw new ConflictException({ code: 'PAPER_DATE_FROZEN', message: '公開済み紙面の対象日は変更できません。' });
    }
    const all = [...state.races, ...state.prior];
    const deadlineAt = new Date(Math.min(...all.map(r => r.startsAt.getTime()), ...state.paper.versions.map(v => v.deadlineAt.getTime())));
    if (new Date() >= deadlineAt || all.some(r => ['FINISHED', 'CANCELLED'].includes(r.status) || r.status === 'DELAYED' && settings.delayedPublicationPolicy !== 'LATEST_STARTS_AT')) throw new ConflictException({ code: 'PUBLICATION_CLOSED', message: '最初の対象レースの締切を過ぎた紙面は公開・訂正できません。' });
    return deadlineAt;
  }

  @Post('expert/papers/import') async importText(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req); const input = racePaperImportSchema.parse(body); const parsed = parseRacePaper(input.text);
    if (parsed.errors.length) throw new BadRequestException({ code: 'PAPER_IMPORT_INVALID', message: parsed.errors.join('\n') });
    return this.locked(async tx => {
      const races = await tx.race.findMany({ where: { raceDate: input.targetDate, OR: parsed.races.map(r => ({ venue: r.venue, number: r.number })) }, include: { entries: true, assignments: true } });
      const draft = racePaperDraftSchema.parse({ targetDate: input.targetDate, title: input.title, accessScope: input.accessScope, summary: input.summary, races: parsed.races.map(source => {
        const r = races.find(r => r.venue === source.venue && r.number === source.number);
        if (!r) throw new BadRequestException({ code: 'PAPER_RACE_MISSING', message: `${source.venue}${source.number}Rをレース管理で登録してください。` });
        if (!canEditRace(actor, r.assignments.map(a => a.userId))) throw new ForbiddenException();
        if (paperNameKey(r.name) !== paperNameKey(source.name)) throw new BadRequestException({ code: 'PAPER_RACE_MISMATCH', message: `${source.venue}${source.number}Rのレース名が一致しません。` });
        return { raceId: r.id, marks: source.marks.map(m => {
          const entry = r.entries.find(e => e.number === m.number);
          if (!entry || paperNameKey(entry.horseName) !== paperNameKey(m.horseName)) throw new BadRequestException({ code: 'PAPER_HORSE_MISMATCH', message: `${source.venue}${source.number}R ${m.number}番の馬名・出走馬登録を確認してください。` });
          return { entryId: entry.id, symbol: m.symbol, reason: '' };
        }) };
      }) });
      return { draft, snapshot: (await this.state(tx, draft, actor, true)).snapshot };
    });
  }
  @Get('expert/papers') async drafts(@Req() req: AppRequest) {
    const actor = await this.staff(req);
    const papers = await this.auth.db.racePaper.findMany({ orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, revision: true, draft: true, versions: { select: { snapshot: true } } } });
    const candidates = papers.map(p => ({ ...p, content: racePaperDraftSchema.parse(p.draft), targets: [...new Set([...racePaperDraftSchema.parse(p.draft).races.map(r => r.raceId), ...p.versions.flatMap(v => racePaperSnapshotSchema.parse(v.snapshot).races.map(r => r.raceId))])] }));
    const targets = actor.role === 'EXPERT' ? await this.auth.db.race.findMany({ where: { id: { in: candidates.flatMap(p => p.targets) } }, select: { id: true, assignments: { select: { userId: true } } } }) : [];
    const allowed = candidates.filter(p => actor.role !== 'EXPERT' || p.targets.every(id => { const r = targets.find(r => r.id === id); return r && canEditRace(actor, r.assignments.map(a => a.userId)); }));
    return { items: allowed.map(p => ({ id: p.id, revision: p.revision, title: p.content.title, targetDate: p.content.targetDate })) };
  }
  @Get('expert/papers/:id') async workspace(@Req() req: AppRequest, @Param('id') id: string) {
    z.string().uuid().parse(id); const actor = await this.staff(req);
    return this.locked(async tx => { const s = await this.load(tx, id, actor); return racePaperWorkspaceSchema.parse({ id, revision: s.paper.revision, draft: s.draft, snapshot: s.snapshot, versions: s.paper.versions.map(v => metadata({ ...v, id: v.id })) }); });
  }
  @Post('expert/papers/draft') async save(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req); const input = racePaperSaveSchema.parse(body);
    return this.locked(async tx => {
      const old = await tx.racePaper.findUnique({ where: { id: input.id } });
      if (old) await this.load(tx, input.id, actor);
      if ((old?.revision ?? 0) !== input.revision) throw new ConflictException({ code: 'PAPER_CONFLICT', message: '別の端末で変更されました。再読み込みしてください。' });
      const state = await this.state(tx, input.draft, actor, true);
      const paper = await tx.racePaper.upsert({ where: { id: input.id }, create: { id: input.id, revision: 1, draft: json(input.draft), updatedBy: actor.id }, update: { revision: input.revision + 1, draft: json(input.draft), updatedBy: actor.id, updatedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: 'RACE_PAPER_DRAFT_SAVED', targetType: 'RACE_PAPER', targetId: paper.id, reason: input.reason, details: { revision: paper.revision }, requestId: req.requestId } });
      return { id: paper.id, revision: paper.revision, draft: input.draft, snapshot: state.snapshot };
    });
  }
  @Post('expert/papers/:id/preview') async preview(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    z.string().uuid().parse(id); const input = racePaperPreviewInputSchema.parse(body); const actor = await this.staff(req);
    return this.locked(async tx => {
      const s = await this.load(tx, id, actor); if (s.paper.revision !== input.revision) throw new ConflictException({ code: 'PAPER_CONFLICT', message: '保存後に内容が変更されました。' });
      const deadlineAt = await this.publication(tx, actor, s, input.correctionReason);
      const version = (s.paper.versions[0]?.version ?? 0) + 1;
      const preview = await tx.racePaperPreview.create({ data: { paperId: id, actorId: actor.id, baselineHash: this.fingerprint(s), version, correctionReason: input.correctionReason, expiresAt: new Date(Date.now() + 15 * 60000) } });
      return racePaperPreviewSchema.parse({ previewId: preview.id, expiresAt: preview.expiresAt, deadlineAt, version, correctionReason: input.correctionReason, snapshot: s.snapshot, notificationText: buildRacePaperNotice({ id, title: s.draft.title, targetDate: s.draft.targetDate, version, appBaseUrl: process.env.APP_BASE_URL! }).text });
    });
  }
  @Post('expert/papers/:id/publish/:previewId') async publish(@Req() req: AppRequest, @Param('id') id: string, @Param('previewId') previewId: string) {
    z.string().uuid().parse(id); z.string().uuid().parse(previewId); const actor = await this.staff(req);
    return this.locked(async tx => {
      const s = await this.load(tx, id, actor); const preview = await tx.racePaperPreview.findUnique({ where: { id: previewId } });
      if (!preview || preview.actorId !== actor.id || preview.paperId !== id) throw new NotFoundException();
      if (preview.confirmedVersionId) return { published: true, versionId: preview.confirmedVersionId, alreadyPublished: true };
      if (preview.expiresAt <= new Date() || this.fingerprint(s) !== preview.baselineHash) throw new ConflictException({ code: 'STALE_PREVIEW', message: '内容変更または確認期限切れです。公開前確認をやり直してください。' });
      const deadlineAt = await this.publication(tx, actor, s, preview.correctionReason);
      const v = await tx.racePaperVersion.create({ data: { paperId: id, version: preview.version, targetDate: s.draft.targetDate, title: s.draft.title, accessScope: s.draft.accessScope, snapshot: json(s.snapshot), deadlineAt, publishedBy: actor.id, correctionReason: preview.version > 1 ? preview.correctionReason : null } });
      await tx.notificationEvent.create({ data: { paperVersionId: v.id, eventType: preview.version > 1 ? 'RACE_PAPER_CORRECTED' : 'RACE_PAPER_PUBLISHED', status: 'QUEUED', payload: { paperVersionId: v.id } } });
      await tx.racePaperPreview.update({ where: { id: previewId }, data: { confirmedVersionId: v.id } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: preview.version > 1 ? 'RACE_PAPER_CORRECTED' : 'RACE_PAPER_PUBLISHED', targetType: 'RACE_PAPER_VERSION', targetId: v.id, reason: preview.correctionReason || '通常レース紙面の公開', details: { paperId: id, version: v.version }, requestId: req.requestId } });
      return { published: true, versionId: v.id, alreadyPublished: false };
    });
  }
  @Get('papers') async list(@Req() req: AppRequest, @Query() query: unknown) {
    await this.auth.authenticate(req); const { page } = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) }).parse(query);
    const where = { versions: { some: {} } };
    const [papers, total] = await this.auth.db.$transaction([this.auth.db.racePaper.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 20, take: 20, select: { id: true, versions: { orderBy: { version: 'desc' }, take: 1, select: metadataSelect } } }), this.auth.db.racePaper.count({ where })]);
    return racePaperListSchema.parse({ items: papers.map(p => metadata({ ...p.versions[0], id: p.id, correctionReason: null })), page, total });
  }
  @Get('papers/:id') async read(@Req() req: AppRequest, @Param('id') id: string) {
    z.string().uuid().parse(id); const actor = await this.auth.authenticate(req);
    const paper = await this.auth.db.racePaper.findUnique({ where: { id }, select: { id: true, versions: { orderBy: { version: 'desc' }, take: 50, select: { ...metadataSelect, snapshot: true } } } });
    if (!paper?.versions.length) throw new NotFoundException();
    const entitlements = actor.role === 'MEMBER' ? await this.auth.db.entitlement.findMany({ where: { userId: actor.id } }) : [];
    const versions = [];
    for (const v of paper.versions) {
      const snapshot = racePaperSnapshotSchema.parse(v.snapshot);
      const races = actor.role !== 'MEMBER' ? await this.auth.db.race.findMany({ where: { id: { in: snapshot.races.map(r => r.raceId) } }, include: { assignments: true } }) : [];
      const staff = races.length === snapshot.races.length && races.every(r => canEditRace(actor, r.assignments.map(a => a.userId)));
      const allowed = v.accessScope === 'MEMBERS' || staff || actor.role === 'MEMBER' && canReadPrediction({ now: new Date(), publishedAt: v.publishedAt, visibility: 'PAID', raceDate: v.targetDate, entitlements });
      const meta = metadata({ ...v, id: v.id });
      versions.push(allowed ? { ...meta, locked: false, snapshot } : { ...meta, locked: true, correctionReason: null });
    }
    return racePaperReadSchema.parse({ id, versions });
  }
}
