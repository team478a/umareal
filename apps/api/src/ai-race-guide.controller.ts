import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, UnauthorizedException } from '@nestjs/common';
import {
  aiRaceGuideAdminResponseSchema,
  aiRaceGuideAdminRaceListResponseSchema,
  aiRaceGuideApprovalSchema,
  aiRaceGuideGenerationRequestSchema,
  aiRaceGuideGeneratedOutputSchema,
  aiRaceGuidePublicResponseSchema,
  aiRaceGuidePublishSchema,
  canManage,
  canReadPrediction,
  parseContentAccessPolicy,
  projectAiRaceGuideSnapshot,
  resolveAiRaceGuideRuntime,
  validateAiRaceGuideGeneratedOutput
} from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AiRaceGuideService } from './ai-race-guide.service';
import { AuthService } from './auth.service';
import type { AppRequest, AuthContext } from './context';
import { hashToken } from './security';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const raceInclude = { entries: { orderBy: { number: 'asc' as const } } };

@Controller()
export class AiRaceGuideController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AiRaceGuideService) private readonly guides: AiRaceGuideService
  ) {}

  private locked<T>(work: (tx: Tx) => Promise<T>) {
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262031)::text`;
      return work(tx);
    }, { timeout: 20000, maxWait: 10000 });
  }

  private runtime() { return resolveAiRaceGuideRuntime(process.env); }

  private ensureVisible() {
    const runtime = this.runtime();
    if (!runtime.enabled) throw new NotFoundException();
    return runtime;
  }

  private async admin(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN'])) throw new ForbiddenException({ code: actor.role === 'ADMIN' ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'AIレースガイドの管理には管理者権限と二段階認証が必要です。' });
    return actor;
  }

  private async race(tx: Tx, raceId: string) {
    const race = await tx.race.findUnique({ where: { id: raceId }, include: raceInclude });
    if (!race) throw new NotFoundException();
    return race;
  }

  private ensureOpen(race: Awaited<ReturnType<AiRaceGuideController['race']>>) {
    if (new Date() >= race.startsAt || ['FINISHED', 'CANCELLED'].includes(race.status)) {
      throw new ConflictException({ code: 'AI_GUIDE_PUBLICATION_CLOSED', message: '発走後または終了・中止レースには公開できません。' });
    }
  }

  private async workspace(tx: Tx, raceId: string) {
    const race = await this.race(tx, raceId);
    const guide = await tx.aiRaceGuide.findUnique({
      where: { raceId },
      include: {
        generations: { orderBy: { attemptNo: 'desc' } },
        versions: { orderBy: { version: 'desc' }, select: { id: true, version: true, publishedAt: true, correctionReason: true } }
      }
    });
    const stale = guide?.latestGenerationId
      ? !this.guides.isFresh(guide.generations.find(item => item.id === guide.latestGenerationId)?.structuredInputSnapshot, race)
      : false;
    return aiRaceGuideAdminResponseSchema.parse({
      race: { id: race.id, raceDate: race.raceDate, venue: race.venue, number: race.number, name: race.name, startsAt: race.startsAt.toISOString() },
      runtime: this.runtime(),
      guide: guide ? { id: guide.id, status: stale ? 'STALE' : guide.status, revision: guide.revision, latestGenerationId: guide.latestGenerationId, updatedAt: guide.updatedAt.toISOString() } : null,
      generations: guide?.generations.map(item => ({
        id: item.id,
        attemptNo: item.attemptNo,
        inputHash: item.inputHash,
        dataCutoffAt: item.dataCutoffAt.toISOString(),
        logicVersion: item.logicVersion,
        promptVersion: item.promptVersion,
        sourceVersion: item.sourceVersion,
        modelProvider: item.modelProvider,
        modelVersion: item.modelVersion,
        validationStatus: item.validationStatus,
        validationErrors: z.array(z.string()).parse(item.validationErrors),
        generatedOutput: item.generatedOutput,
        structuredInputSnapshot: item.structuredInputSnapshot,
        createdAt: item.createdAt.toISOString()
      })) ?? [],
      versions: guide?.versions.map(item => ({ ...item, publishedAt: item.publishedAt.toISOString() })) ?? []
    });
  }

  private async priorIdempotent(tx: Tx, key: string, requestHash: string) {
    const prior = await tx.idempotencyKey.findUnique({ where: { key } });
    if (!prior) return null;
    if (prior.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ操作IDで異なる内容が送信されました。' });
    return aiRaceGuideAdminResponseSchema.parse(prior.response);
  }

  private async saveIdempotent(tx: Tx, key: string, requestHash: string, response: unknown) {
    await tx.idempotencyKey.create({ data: { key, requestHash, response: json(response) } });
  }

  private async generate(tx: Tx, req: AppRequest, actor: AuthContext, raceId: string, input: z.infer<typeof aiRaceGuideGenerationRequestSchema>, correction: boolean) {
    const runtime = this.ensureVisible();
    if (!runtime.generationEnabled) throw new ForbiddenException({ code: 'AI_GUIDE_GENERATION_DISABLED', message: 'AIレースガイド生成は停止中です。' });
    if (runtime.transport !== 'test' || process.env.NODE_ENV === 'production') throw new ForbiddenException({ code: 'AI_GUIDE_TEST_PROVIDER_UNAVAILABLE', message: 'synthetic test providerはこの環境では使用できません。' });
    const key = `ai-guide:${correction ? 'correction' : 'generation'}:${actor.id}:${raceId}:${input.mutationId}`;
    const requestHash = hashToken(JSON.stringify(input));
    const prior = await this.priorIdempotent(tx, key, requestHash);
    if (prior) return prior;
    const race = await this.race(tx, raceId);
    this.ensureOpen(race);
    let guide = await tx.aiRaceGuide.findUnique({ where: { raceId }, include: { versions: { take: 1 } } });
    if ((guide?.revision ?? 0) !== input.revision) throw new ConflictException({ code: 'AI_GUIDE_CONFLICT', message: '状態が変更されました。再読み込みしてください。' });
    if (correction && !guide?.versions.length) throw new ConflictException({ code: 'AI_GUIDE_CORRECTION_NOT_AVAILABLE', message: '公開済みガイドがありません。' });
    if (!guide) guide = await tx.aiRaceGuide.create({ data: { raceId, status: 'DATA_PENDING', revision: 1 }, include: { versions: { take: 1 } } });
    const attemptNo = (await tx.aiRaceGuideGeneration.aggregate({ where: { guideId: guide.id }, _max: { attemptNo: true } }))._max.attemptNo ?? 0;
    const structuredInput = this.guides.buildInput(race);
    let output: unknown = null;
    let validationStatus = 'FAILED';
    let validationErrors: string[] = [];
    let failureCode: string | null = null;
    const provider = runtime.transport;
    const modelVersion = 'deterministic-test-v1';
    try {
      output = await this.guides.generate(provider, structuredInput);
      const result = validateAiRaceGuideGeneratedOutput(structuredInput, output);
      if (result.valid) { output = result.output; validationStatus = 'VALID'; }
      else { validationStatus = 'INVALID'; validationErrors = result.issues; }
    } catch {
      failureCode = 'TEST_PROVIDER_FAILED';
      validationErrors = ['synthetic test providerで生成できませんでした。'];
    }
    const generation = await tx.aiRaceGuideGeneration.create({ data: {
      guideId: guide.id,
      attemptNo: attemptNo + 1,
      structuredInputSnapshot: json(structuredInput),
      inputHash: this.guides.hashInput(structuredInput),
      dataCutoffAt: new Date(structuredInput.dataCutoffAt),
      logicVersion: structuredInput.logicVersion,
      promptVersion: structuredInput.promptVersion,
      sourceVersion: structuredInput.sourceVersion,
      modelProvider: provider,
      modelVersion,
      generatedOutput: output ? json(output) : Prisma.JsonNull,
      validationStatus,
      validationErrors: json(validationErrors),
      failureCode
    } });
    await tx.aiRaceGuide.update({ where: { id: guide.id }, data: { latestGenerationId: generation.id, status: validationStatus === 'VALID' ? 'REVIEW_REQUIRED' : 'FAILED', revision: { increment: 1 }, updatedAt: new Date() } });
    await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: correction ? 'AI_GUIDE_CORRECTION_START' : 'AI_GUIDE_GENERATION_REQUEST', targetType: 'AI_RACE_GUIDE_GENERATION', targetId: generation.id, reason: input.reason, details: json({ raceId, guideId: guide.id, attemptNo: generation.attemptNo, inputHash: generation.inputHash, validationStatus }), requestId: req.requestId } });
    const response = await this.workspace(tx, raceId);
    await this.saveIdempotent(tx, key, requestHash, response);
    return response;
  }

  @Get('admin/races/:raceId/ai-guide')
  async adminState(@Req() req: AppRequest, @Param('raceId') raceId: string) {
    z.string().uuid().parse(raceId); this.ensureVisible(); await this.admin(req);
    return this.locked(tx => this.workspace(tx, raceId));
  }

  @Get('admin/ai-guide/races')
  async adminRaces(@Req() req: AppRequest) {
    this.ensureVisible(); await this.admin(req);
    const items = await this.auth.db.race.findMany({ orderBy: [{ raceDate: 'desc' }, { venue: 'asc' }, { number: 'asc' }], take: 500, select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, status: true } });
    return aiRaceGuideAdminRaceListResponseSchema.parse({ items: items.map(item => ({ ...item, startsAt: item.startsAt.toISOString() })) });
  }

  @Get('admin/ai-guide/generations/:generationId')
  async generationState(@Req() req: AppRequest, @Param('generationId') generationId: string) {
    z.string().uuid().parse(generationId); this.ensureVisible(); await this.admin(req);
    return this.locked(async tx => {
      const generation = await tx.aiRaceGuideGeneration.findUnique({ where: { id: generationId }, include: { guide: true } });
      if (!generation) throw new NotFoundException();
      return this.workspace(tx, generation.guide.raceId);
    });
  }

  @Post('admin/races/:raceId/ai-guide/generations')
  async createGeneration(@Req() req: AppRequest, @Param('raceId') raceId: string, @Body() body: unknown) {
    z.string().uuid().parse(raceId); const input = aiRaceGuideGenerationRequestSchema.parse(body); const actor = await this.admin(req);
    return this.locked(tx => this.generate(tx, req, actor, raceId, input, false));
  }

  @Post('admin/races/:raceId/ai-guide/corrections')
  async startCorrection(@Req() req: AppRequest, @Param('raceId') raceId: string, @Body() body: unknown) {
    z.string().uuid().parse(raceId); const input = aiRaceGuideGenerationRequestSchema.parse(body); const actor = await this.admin(req);
    return this.locked(tx => this.generate(tx, req, actor, raceId, input, true));
  }

  @Post('admin/races/:raceId/ai-guide/approve')
  async approve(@Req() req: AppRequest, @Param('raceId') raceId: string, @Body() body: unknown) {
    z.string().uuid().parse(raceId); const input = aiRaceGuideApprovalSchema.parse(body); const actor = await this.admin(req); this.ensureVisible();
    return this.locked(async tx => {
      const key = `ai-guide:approve:${actor.id}:${raceId}:${input.mutationId}`; const requestHash = hashToken(JSON.stringify(input));
      const prior = await this.priorIdempotent(tx, key, requestHash); if (prior) return prior;
      const race = await this.race(tx, raceId); this.ensureOpen(race);
      const guide = await tx.aiRaceGuide.findUnique({ where: { raceId } });
      if (!guide || guide.revision !== input.revision || guide.latestGenerationId !== input.generationId) throw new ConflictException({ code: 'AI_GUIDE_CONFLICT', message: '状態が変更されました。再読み込みしてください。' });
      const generation = await tx.aiRaceGuideGeneration.findUnique({ where: { id: input.generationId } });
      if (!generation || generation.validationStatus !== 'VALID' || !generation.generatedOutput) throw new BadRequestException({ code: 'AI_GUIDE_VALIDATION_FAILED', message: '検証済みの生成結果だけ承認できます。' });
      if (!this.guides.isFresh(generation.structuredInputSnapshot, race)) throw new ConflictException({ code: 'AI_GUIDE_STALE', message: '入力後にレース情報が変更されました。再生成してください。' });
      const validation = validateAiRaceGuideGeneratedOutput(generation.structuredInputSnapshot, generation.generatedOutput);
      if (!validation.valid) throw new BadRequestException({ code: 'AI_GUIDE_VALIDATION_FAILED', message: '再検証に失敗しました。' });
      await tx.aiRaceGuide.update({ where: { id: guide.id }, data: { status: 'READY', revision: { increment: 1 }, updatedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: 'AI_GUIDE_APPROVE', targetType: 'AI_RACE_GUIDE_GENERATION', targetId: generation.id, reason: input.reason, details: json({ raceId, guideId: guide.id }), requestId: req.requestId } });
      const response = await this.workspace(tx, raceId); await this.saveIdempotent(tx, key, requestHash, response); return response;
    });
  }

  @Post('admin/races/:raceId/ai-guide/publish')
  async publish(@Req() req: AppRequest, @Param('raceId') raceId: string, @Body() body: unknown) {
    z.string().uuid().parse(raceId); const input = aiRaceGuidePublishSchema.parse(body); const actor = await this.admin(req);
    const runtime = this.ensureVisible();
    if (!runtime.publicationEnabled) throw new ForbiddenException({ code: 'AI_GUIDE_PUBLICATION_DISABLED', message: 'AIレースガイド公開は停止中です。' });
    return this.locked(async tx => {
      const key = `ai-guide:publish:${actor.id}:${raceId}:${input.mutationId}`; const requestHash = hashToken(JSON.stringify(input));
      const prior = await this.priorIdempotent(tx, key, requestHash); if (prior) return prior;
      const race = await this.race(tx, raceId); this.ensureOpen(race);
      const guide = await tx.aiRaceGuide.findUnique({ where: { raceId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
      if (!guide || guide.status !== 'READY' || guide.revision !== input.revision || guide.latestGenerationId !== input.generationId) throw new ConflictException({ code: 'AI_GUIDE_NOT_READY', message: '承認済みの最新生成結果だけ公開できます。' });
      const previous = guide.versions[0] ?? null;
      if (previous && !input.correctionReason) throw new BadRequestException({ code: 'CORRECTION_REASON_REQUIRED', message: '訂正版には訂正理由が必要です。' });
      const generation = await tx.aiRaceGuideGeneration.findUniqueOrThrow({ where: { id: input.generationId } });
      if (generation.validationStatus !== 'VALID' || !generation.generatedOutput || !this.guides.isFresh(generation.structuredInputSnapshot, race)) throw new ConflictException({ code: 'AI_GUIDE_NOT_PUBLISHABLE', message: '再生成または再検証が必要です。' });
      const validation = validateAiRaceGuideGeneratedOutput(generation.structuredInputSnapshot, generation.generatedOutput);
      if (!validation.valid) throw new BadRequestException({ code: 'AI_GUIDE_VALIDATION_FAILED', message: '公開前検証に失敗しました。' });
      const full = aiRaceGuideGeneratedOutputSchema.parse(generation.generatedOutput);
      const preview = this.guides.preview(full);
      const version = await tx.aiRaceGuideVersion.create({ data: {
        guideId: guide.id, generationId: generation.id, version: (previous?.version ?? 0) + 1,
        scope: 'FREE_PREVIEW_PAID_FULL', previewSnapshot: json(preview), fullSnapshot: json(full),
        dataCutoffAt: generation.dataCutoffAt, generatedAt: generation.createdAt, modelVersion: generation.modelVersion,
        logicVersion: generation.logicVersion, promptVersion: generation.promptVersion, sourceVersion: generation.sourceVersion,
        publishedBy: actor.id, correctionReason: previous ? input.correctionReason : null
      } });
      const entryById = new Map(race.entries.map(entry => [entry.id, entry]));
      const relationKinds = new Map<string, Set<'ATTENTION' | 'POSITIVE' | 'CAUTION' | 'PADDOCK_CHECK'>>();
      for (const section of full.sections) for (const statement of section.statements) for (const entryId of statement.entryIds) {
        const relation = section.kind === 'POSITIVE_FACTORS' ? 'POSITIVE' : section.kind === 'CAUTION_FACTORS' ? 'CAUTION' : section.kind === 'PADDOCK_CHECK_POINTS' ? 'PADDOCK_CHECK' : 'ATTENTION';
        const values = relationKinds.get(entryId) ?? new Set(); values.add(relation); relationKinds.set(entryId, values);
      }
      const links = [...relationKinds].flatMap(([entryId, kinds]) => [...kinds].map(relationKind => ({ versionId: version.id, horseId: entryById.get(entryId)!.horseId, raceEntryId: entryId, relationKind })));
      if (links.length) await tx.aiRaceGuideVersionHorse.createMany({ data: links });
      await tx.aiRaceGuide.update({ where: { id: guide.id }, data: { status: 'PUBLISHED', revision: { increment: 1 }, updatedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: previous ? 'AI_GUIDE_CORRECTION_PUBLISH' : 'AI_GUIDE_PUBLISH', targetType: 'AI_RACE_GUIDE_VERSION', targetId: version.id, reason: previous ? input.correctionReason : input.reason, details: json({ raceId, guideId: guide.id, generationId: generation.id, version: version.version }), requestId: req.requestId } });
      const response = await this.workspace(tx, raceId); await this.saveIdempotent(tx, key, requestHash, response); return response;
    });
  }

  @Get('races/:raceId/ai-guide')
  async publicGuide(@Req() req: AppRequest, @Param('raceId') raceId: string) {
    z.string().uuid().parse(raceId); this.ensureVisible();
    const race = await this.auth.db.race.findUnique({ where: { id: raceId }, include: { aiRaceGuide: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } } });
    if (!race) throw new NotFoundException();
    const version = race.aiRaceGuide?.versions[0];
    if (!version) return aiRaceGuidePublicResponseSchema.parse({ available: false });
    let identity: AuthContext | null = null;
    try { identity = await this.auth.authenticate(req); } catch (error) { if (!(error instanceof UnauthorizedException)) throw error; }
    const staff = !!identity && ['ADMIN', 'OPERATOR', 'EDITOR', 'EXPERT'].includes(identity.role);
    const [entitlements, settings] = await Promise.all([
      identity?.role === 'MEMBER' ? this.auth.db.entitlement.findMany({ where: { userId: identity.id } }) : Promise.resolve([]),
      this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { contentAccessPolicy: true } })
    ]);
    const fullAccess = staff || canReadPrediction({ now: new Date(), publishedAt: version.publishedAt, visibility: 'PAID', raceDate: race.raceDate, entitlements, contentKind: 'AI_RACE_GUIDE', contentAccessPolicy: parseContentAccessPolicy(settings.contentAccessPolicy) });
    return aiRaceGuidePublicResponseSchema.parse(projectAiRaceGuideSnapshot({
      raceId: race.id, raceDate: race.raceDate, version: version.version,
      dataCutoffAt: version.dataCutoffAt.toISOString(), generatedAt: version.generatedAt.toISOString(), publishedAt: version.publishedAt.toISOString(),
      modelVersion: version.modelVersion, logicVersion: version.logicVersion, promptVersion: version.promptVersion, sourceVersion: version.sourceVersion,
      preview: version.previewSnapshot, full: version.fullSnapshot
    }, fullAccess));
  }
}
