import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { assessmentSchema, canEditRace, canReadPrediction, paddockComplete, predictionDraftSchema, predictionSaveSchema, publishablePredictionSchema, publishPreviewSchema, totalYenFor } from '@keiba/domain';
import type { PredictionDraft } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest, AuthContext } from './context';
import { hashToken } from './security';
type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const previewSnapshotSchema = z.object({ correctionReason: z.string(), nextVersion: z.number().int().positive() });
const versionSelect = { id: true, version: true, status: true, visibility: true, confidence: true, stance: true, summary: true, estimatedTotalYen: true, contentSnapshot: true, assessmentSnapshot: true, publisherId: true, publishedAt: true, deadlineAt: true, correctionReason: true, previousVersionId: true, marks: { orderBy: { horseNumber: 'asc' as const } }, bets: { orderBy: { id: 'asc' as const } } };
@Controller()
export class PredictionsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  private locked<T>(work: (tx: Tx) => Promise<T>) {
    return this.auth.db.$transaction(async tx => { await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`; return work(tx); }, { timeout: 20000, maxWait: 10000 });
  }
  private async access(tx: Tx, req: AppRequest, raceId: string) {
    const actor = await this.auth.authenticate(req);
    const race = await tx.race.findUnique({ where: { id: raceId }, include: { assignments: true } });
    if (!race) throw new NotFoundException();
    if (!canEditRace(actor, race.assignments.map(item => item.userId))) throw new ForbiddenException({ code: 'RACE_ACCESS_DENIED', message: '担当レースと二段階認証を確認してください。' });
    return { actor, race };
  }
  private async state(tx: Tx, raceId: string) {
    const race = await tx.race.findUnique({ where: { id: raceId }, include: { assignments: true, entries: { orderBy: { number: 'asc' }, include: { assessment: true } }, prediction: { include: { versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true, version: true } } } } } });
    if (!race) throw new NotFoundException();
    return race;
  }
  private fingerprint(state: Awaited<ReturnType<PredictionsController['state']>>) {
    return hashToken(JSON.stringify({ race: { id: state.id, revision: state.revision, startsAt: state.startsAt, status: state.status, assignments: state.assignments.map(a => a.userId).sort() }, entries: state.entries.map(e => ({ id: e.id, horseId: e.horseId, number: e.number, horseName: e.horseName, status: e.status, assessment: e.assessment ? { revision: e.assessment.revision, content: e.assessment.content } : null })), prediction: state.prediction ? { id: state.prediction.id, revision: state.prediction.revision, draft: state.prediction.draft, latest: state.prediction.versions[0] ?? null } : null }));
  }
  private validateDraft(draft: PredictionDraft, state: Awaited<ReturnType<PredictionsController['state']>>) {
    const valid = publishablePredictionSchema.parse(draft);
    const byId = new Map(state.entries.map(entry => [entry.id, entry])); const activeNumbers = new Set(state.entries.filter(e => e.status === 'ACTIVE').map(e => e.number));
    for (const mark of valid.marks) {
      const entry = byId.get(mark.entryId);
      if (!entry || entry.status !== 'ACTIVE') throw new BadRequestException({ code: 'INVALID_MARK_ENTRY', message: '最終印には出走予定の馬だけを指定してください。' });
    }
    for (const bet of valid.bets) for (const combination of bet.combinations) for (const number of combination) if (!activeNumbers.has(number)) throw new BadRequestException({ code: 'INVALID_BET_NUMBER', message: `買い目の馬番${number}は出走予定ではありません。` });
    return valid;
  }
  private ensureOpen(state: Awaited<ReturnType<PredictionsController['state']>>) {
    if (state.status === 'DELAYED' && (process.env.DELAYED_PUBLICATION_POLICY ?? 'CLOSED') !== 'LATEST_STARTS_AT') throw new ConflictException({ code: 'DELAYED_PUBLICATION_CLOSED', message: '延期レースの公開は運用確認が必要です。' });
    if (['FINISHED', 'CANCELLED'].includes(state.status) || new Date() >= state.startsAt) throw new ConflictException({ code: 'PUBLICATION_CLOSED', message: '発走時刻以降または終了・中止レースには公開できません。' });
  }
  private async ensurePublicationEnabled(tx: Tx) {
    const settings = await tx.systemSetting.findUnique({ where: { id: 'global' }, select: { predictionPublicationEnabled: true } });
    if (settings && !settings.predictionPublicationEnabled) throw new ForbiddenException({ code: 'PREDICTION_PUBLICATION_STOPPED', message: '管理設定により予想公開を停止しています。' });
  }
  private ensureCorrectionActor(actor: AuthContext, correcting: boolean) {
    const policy = process.env.CORRECTION_POLICY ?? 'ADMIN_ONLY';
    if (correcting && policy === 'ADMIN_ONLY' && actor.role !== 'ADMIN') throw new ForbiddenException({ code: 'CORRECTION_APPROVAL_REQUIRED', message: 'この開発設定では訂正公開に管理者の確認が必要です。' });
  }
  @Get('expert/races/:raceId/prediction') async edit(@Req() req: AppRequest, @Param('raceId') raceId: string) {
    z.string().uuid().parse(raceId);
    return this.locked(async tx => {
      await this.access(tx, req, raceId); const state = await this.state(tx, raceId);
      const versions = state.prediction ? await tx.predictionVersion.findMany({ where: { predictionId: state.prediction.id }, orderBy: { version: 'desc' }, select: versionSelect }) : [];
      return { race: { id: state.id, name: state.name, venue: state.venue, number: state.number, startsAt: state.startsAt, status: state.status, revision: state.revision }, entries: state.entries, prediction: state.prediction ? { id: state.prediction.id, draft: state.prediction.draft, revision: state.prediction.revision } : null, versions, correctionPolicy: process.env.CORRECTION_POLICY ?? 'ADMIN_ONLY' };
    });
  }
  @Post('expert/races/:raceId/prediction/draft') async save(@Req() req: AppRequest, @Param('raceId') raceId: string, @Body() body: unknown) {
    z.string().uuid().parse(raceId); const input = predictionSaveSchema.parse(body);
    return this.locked(async tx => {
      const { actor } = await this.access(tx, req, raceId); const state = await this.state(tx, raceId);
      const key = `prediction:${actor.id}:${raceId}:${input.mutationId}`; const requestHash = hashToken(JSON.stringify(input));
      const prior = await tx.idempotencyKey.findUnique({ where: { key } });
      if (prior) { if (prior.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '再送の内容が変わっています。' }); return prior.response; }
      if (state.revision !== input.raceRevision) throw new ConflictException({ code: 'RACE_CHANGED', message: 'レース・出走馬・担当が変更されました。再読み込みしてください。' });
      if ((state.prediction?.revision ?? 0) !== input.revision) throw new ConflictException({ code: 'PREDICTION_CONFLICT', message: '別の端末で最終予想が変更されました。再読み込みしてください。' });
      const revision = input.revision + 1;
      const saved = await tx.prediction.upsert({ where: { raceId }, create: { raceId, draft: json(input.draft), revision, updatedBy: actor.id }, update: { draft: json(input.draft), revision, updatedBy: actor.id, updatedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: 'PREDICTION_DRAFT_SAVE', targetType: 'PREDICTION', targetId: saved.id, reason: input.reason, details: json({ revision, raceId }), requestId: req.requestId } });
      const response = json({ id: saved.id, revision: saved.revision, draft: saved.draft, updatedAt: saved.updatedAt });
      await tx.idempotencyKey.create({ data: { key, requestHash, response } }); return response;
    });
  }
  @Post('expert/races/:raceId/prediction/preview') async preview(@Req() req: AppRequest, @Param('raceId') raceId: string, @Body() body: unknown) {
    z.string().uuid().parse(raceId); const input = publishPreviewSchema.parse(body);
    return this.locked(async tx => {
      const { actor } = await this.access(tx, req, raceId); await this.ensurePublicationEnabled(tx); const state = await this.state(tx, raceId); this.ensureOpen(state);
      if (!state.prediction || state.prediction.revision !== input.predictionRevision || state.revision !== input.raceRevision) throw new ConflictException({ code: 'PREDICTION_CHANGED', message: '保存後に内容が変わりました。再読み込みしてください。' });
      const correcting = !!state.prediction.versions[0]; this.ensureCorrectionActor(actor, correcting);
      if (correcting && !input.correctionReason) throw new BadRequestException({ code: 'CORRECTION_REASON_REQUIRED', message: '訂正理由を入力してください。' });
      const draft = this.validateDraft(predictionDraftSchema.parse(state.prediction.draft), state); const totalYen = totalYenFor(draft);
      const missing = state.entries.filter(entry => entry.status === 'ACTIVE' && (!entry.assessment || !paddockComplete(assessmentSchema.parse(entry.assessment.content)))).map(entry => entry.number);
      const warnings = [...(missing.length ? [`パドック未入力：${missing.join('、')}番`] : []), ...(!draft.bets.length && draft.stance !== 'SKIP' ? ['参考買い目がありません。'] : [])];
      const snapshot = { correctionReason: input.correctionReason, nextVersion: (state.prediction.versions[0]?.version ?? 0) + 1 };
      const created = await tx.publicationPreview.create({ data: { actorId: actor.id, predictionId: state.prediction.id, baselineHash: this.fingerprint(state), snapshot, expiresAt: new Date(Date.now() + 15 * 60000) } });
      return { previewId: created.id, expiresAt: created.expiresAt, version: snapshot.nextVersion, correction: correcting, correctionReason: input.correctionReason, warnings, totalYen, points: draft.bets.reduce((sum, bet) => sum + bet.combinations.length, 0), deadlineAt: state.startsAt, draft, entries: state.entries.map(e => ({ id: e.id, horseId: e.horseId, number: e.number, horseName: e.horseName, status: e.status, assessment: e.assessment?.content ?? null })) };
    });
  }
  @Post('expert/races/:raceId/prediction/publish/:previewId') async publish(@Req() req: AppRequest, @Param('raceId') raceId: string, @Param('previewId') previewId: string) {
    z.string().uuid().parse(raceId); z.string().uuid().parse(previewId);
    return this.locked(async tx => {
      const { actor } = await this.access(tx, req, raceId); await this.ensurePublicationEnabled(tx);
      const preview = await tx.publicationPreview.findUnique({ where: { id: previewId } });
      if (!preview || preview.actorId !== actor.id) throw new NotFoundException();
      if (preview.confirmedVersionId) return { published: true, versionId: preview.confirmedVersionId, alreadyPublished: true };
      if (preview.expiresAt <= new Date()) throw new ConflictException({ code: 'PREVIEW_EXPIRED', message: '公開前確認の有効期限が切れました。再確認してください。' });
      const state = await this.state(tx, raceId); this.ensureOpen(state);
      if (!state.prediction || preview.predictionId !== state.prediction.id || preview.baselineHash !== this.fingerprint(state)) throw new ConflictException({ code: 'STALE_PREVIEW', message: '確認後にレース・評価・予想が変わりました。再確認してください。' });
      const details = previewSnapshotSchema.parse(preview.snapshot); const previous = state.prediction.versions[0] ?? null; const correcting = !!previous;
      if (details.nextVersion !== (previous?.version ?? 0) + 1) throw new ConflictException({ code: 'STALE_PREVIEW', message: '別の公開版が追加されました。再確認してください。' });
      this.ensureCorrectionActor(actor, correcting);
      const draft = this.validateDraft(predictionDraftSchema.parse(state.prediction.draft), state); const totalYen = totalYenFor(draft);
      const version = await tx.predictionVersion.create({ data: { predictionId: state.prediction.id, version: details.nextVersion, status: correcting ? 'CORRECTED' : 'PUBLISHED', visibility: draft.visibility!, confidence: draft.confidence!, stance: draft.stance!, summary: draft.summary, estimatedTotalYen: totalYen, contentSnapshot: json({ ...draft, race: { id: state.id, raceDate: state.raceDate, venue: state.venue, number: state.number, name: state.name, startsAt: state.startsAt, status: state.status }, entries: state.entries.map(e => ({ id: e.id, horseId: e.horseId, number: e.number, horseName: e.horseName, status: e.status })) }), assessmentSnapshot: json(state.entries.map(e => ({ entryId: e.id, horseId: e.horseId, number: e.number, horseName: e.horseName, assessment: e.assessment?.content ?? null }))), publisherId: actor.id, deadlineAt: state.startsAt, previousVersionId: previous?.id, correctionReason: correcting ? details.correctionReason : null } });
      const entries = new Map(state.entries.map(e => [e.id, e]));
      if (draft.marks.length) await tx.predictionMark.createMany({ data: draft.marks.map(mark => { const entry = entries.get(mark.entryId)!; return { versionId: version.id, entryId: entry.id, horseId: entry.horseId, horseNumber: entry.number, horseName: entry.horseName, mark: mark.mark, reason: mark.reason }; }) });
      if (draft.bets.length) await tx.predictionBet.createMany({ data: draft.bets.map(bet => ({ versionId: version.id, betType: bet.type, combination: json(bet.combinations), amountPerPointYen: bet.amountPerPointYen, points: bet.combinations.length, totalYen: bet.amountPerPointYen * bet.combinations.length })) });
      await tx.notificationEvent.create({ data: { versionId: version.id, eventType: correcting ? 'PREDICTION_CORRECTED' : 'PREDICTION_PUBLISHED', status: 'QUEUED', payload: json({ versionId: version.id, raceId, visibility: draft.visibility }) } });
      await tx.publicationPreview.update({ where: { id: preview.id }, data: { confirmedVersionId: version.id } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: correcting ? 'PREDICTION_CORRECT' : 'PREDICTION_PUBLISH', targetType: 'PREDICTION_VERSION', targetId: version.id, reason: correcting ? details.correctionReason : '最終予想の公開', details: json({ raceId, predictionId: state.prediction.id, version: details.nextVersion, previousVersionId: previous?.id ?? null, totalYen }), requestId: req.requestId } });
      return { published: true, versionId: version.id, version: details.nextVersion, alreadyPublished: false, publishedAt: version.publishedAt };
    });
  }
  @Get('races/:raceId/prediction') async publicPrediction(@Req() req: AppRequest, @Param('raceId') raceId: string, @Query() query: unknown) {
    z.string().uuid().parse(raceId); const { page } = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(query);
    const race = await this.auth.db.race.findUnique({ where: { id: raceId }, include: { assignments: true, prediction: true } });
    if (!race) throw new NotFoundException();
    if (!race.prediction) return { race: { id: race.id, name: race.name, venue: race.venue, number: race.number, startsAt: race.startsAt }, latest: null, versions: [], total: 0, page, limit: 20, locked: false };
    const [latest, pageVersions, total] = await this.auth.db.$transaction([this.auth.db.predictionVersion.findFirst({ where: { predictionId: race.prediction.id }, orderBy: { version: 'desc' }, select: versionSelect }), this.auth.db.predictionVersion.findMany({ where: { predictionId: race.prediction.id }, orderBy: { version: 'desc' }, take: 20, skip: (page - 1) * 20, select: versionSelect }), this.auth.db.predictionVersion.count({ where: { predictionId: race.prediction.id } })]);
    if (!latest) return { latest: null, versions: [], total: 0, page, limit: 20, locked: false };
    let identity: AuthContext | null = null;
    try { identity = await this.auth.authenticate(req); } catch (error) { if (!(error instanceof UnauthorizedException)) throw error; }
    const staffAccess = (identity?.role === 'ADMIN' && identity.aal === 2) || (identity?.role === 'EXPERT' && canEditRace(identity, race.assignments.map(a => a.userId)));
    const entitlements = identity?.role === 'MEMBER' ? await this.auth.db.entitlement.findMany({ where: { userId: identity.id } }) : [];
    const canView = (version: typeof latest) => !!staffAccess || canReadPrediction({ now: new Date(), publishedAt: version.publishedAt, visibility: version.visibility as 'FREE' | 'PAID', raceDate: race.raceDate, entitlements });
    const redact = (version: NonNullable<typeof latest>) => canView(version)
      ? { ...version, locked: false }
      : { id: version.id, version: version.version, status: version.status, visibility: version.visibility, publishedAt: version.publishedAt, previousVersionId: version.previousVersionId, locked: true };
    const visibleLatest = redact(latest);
    return { race: { id: race.id, name: race.name, venue: race.venue, number: race.number, startsAt: race.startsAt }, latest: visibleLatest, versions: pageVersions.map(redact), total, page, limit: 20, locked: visibleLatest.locked };
  }
}
