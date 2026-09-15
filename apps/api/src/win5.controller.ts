import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, UnauthorizedException } from '@nestjs/common';
import { win5AssumedPurchaseAmount, win5CombinationCount, win5LegUpdateSchema, win5PreviewSchema, win5ProductCreateSchema, win5ProductUpdateSchema } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest, AuthContext } from './context';
import { hashToken } from './security';
import { activatePendingDayPasses } from './day-pass-access';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const previewDetailsSchema = z.object({ correctionReason: z.string(), nextVersion: z.number().int().positive() });

@Controller()
export class Win5Controller {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private locked<T>(work: (tx: Tx) => Promise<T>) {
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262027)::text`;
      return work(tx);
    }, { timeout: 20000, maxWait: 10000 });
  }

  private async actor(req: AppRequest, roles: AuthContext['role'][]) {
    const actor = await this.auth.authenticate(req);
    if (!roles.includes(actor.role) || actor.aal !== 2) throw new ForbiddenException({ code: actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'WIN5編集権限と二段階認証を確認してください。' });
    return actor;
  }

  private async state(tx: Tx, productId: string) {
    const product = await tx.predictionProduct.findUnique({
      where: { id: productId },
      include: {
        expert: { select: { id: true, displayName: true, disabledAt: true } },
        races: { orderBy: { legNumber: 'asc' }, include: { race: { include: { entries: { orderBy: { number: 'asc' } } } }, selections: { orderBy: { displayOrder: 'asc' }, include: { entry: true } } } },
        versions: { orderBy: { version: 'desc' }, select: { id: true, version: true, status: true, accessScope: true, confidence: true, combinationCount: true, amountPerPointYen: true, assumedPurchaseAmountYen: true, contentSnapshot: true, publisherId: true, publishedAt: true, deadlineAt: true, correctionReason: true, previousVersionId: true } }
      }
    });
    if (!product) throw new NotFoundException();
    return product;
  }

  private async access(tx: Tx, req: AppRequest, productId: string) {
    const actor = await this.actor(req, ['ADMIN', 'OPERATOR', 'EXPERT']);
    const product = await this.state(tx, productId);
    if (actor.role === 'EXPERT' && product.expertId !== actor.id) throw new ForbiddenException({ code: 'WIN5_ACCESS_DENIED', message: '担当するWIN5予想だけを編集できます。' });
    return { actor, product };
  }

  private fingerprint(product: Awaited<ReturnType<Win5Controller['state']>>) {
    return hashToken(JSON.stringify({
      product: { id: product.id, type: product.type, targetDate: product.targetDate, title: product.title, expertId: product.expertId, accessScope: product.accessScope, scheduledPublishAt: product.scheduledPublishAt, confidence: product.confidence, summary: product.summary, showFreeConfidence: product.showFreeConfidence, amountPerPointYen: product.amountPerPointYen, revision: product.revision },
      races: product.races.map(item => ({ legNumber: item.legNumber, confidence: item.confidence, strategyType: item.strategyType, comment: item.comment, race: { id: item.race.id, revision: item.race.revision, raceDate: item.race.raceDate, startsAt: item.race.startsAt, status: item.race.status }, selections: item.selections.map(selection => ({ entryId: selection.entryId, selectionType: selection.selectionType, displayOrder: selection.displayOrder, horseId: selection.entry.horseId, number: selection.entry.number, horseName: selection.entry.horseName, status: selection.entry.status })) })),
      latestVersion: product.versions[0] ? { id: product.versions[0].id, version: product.versions[0].version } : null
    }));
  }

  private publishable(product: Awaited<ReturnType<Win5Controller['state']>>) {
    if (!product.summary.trim()) throw new BadRequestException({ code: 'SUMMARY_REQUIRED', message: 'WIN5全体総評を入力してください。' });
    if (product.races.length !== 5 || product.races.some((item, index) => item.legNumber !== index + 1)) throw new BadRequestException({ code: 'WIN5_LEGS_INCOMPLETE', message: '対象5レースを第1〜第5レースとして設定してください。' });
    const dates = new Set(product.races.map(item => item.race.raceDate));
    if (dates.size !== 1 || !dates.has(product.targetDate)) throw new BadRequestException({ code: 'RACE_DATE_MISMATCH', message: '5レースの開催日を対象日に揃えてください。' });
    if (product.races.some(item => ['FINISHED', 'CANCELLED', 'DELAYED'].includes(item.race.status))) throw new ConflictException({ code: 'WIN5_RACE_UNAVAILABLE', message: '終了・中止・延期レースが含まれるため公開できません。' });
    for (const item of product.races) {
      if (!item.selections.length || item.selections.filter(selection => selection.selectionType === 'CENTER').length !== 1) throw new BadRequestException({ code: 'WIN5_SELECTION_REQUIRED', message: `第${item.legNumber}レースの選択馬と中心馬を設定してください。` });
    }
    const deadlineAt = new Date(Math.min(...product.races.map(item => item.race.startsAt.getTime())));
    if (new Date() >= deadlineAt) throw new ConflictException({ code: 'WIN5_PUBLICATION_CLOSED', message: '対象レースの最も早い発走時刻を過ぎたため公開できません。' });
    let combinationCount: number;
    let assumedPurchaseAmountYen: number;
    try {
      combinationCount = win5CombinationCount(product.races.map(item => item.selections.length));
      assumedPurchaseAmountYen = win5AssumedPurchaseAmount(combinationCount, product.amountPerPointYen);
    } catch {
      throw new BadRequestException({ code: 'WIN5_AMOUNT_LIMIT', message: '組合せ数または想定購入額が保存上限を超えています。' });
    }
    const contentSnapshot = {
      product: { type: product.type, targetDate: product.targetDate, title: product.title, expertId: product.expertId, expertName: product.expert.displayName, accessScope: product.accessScope, scheduledPublishAt: product.scheduledPublishAt, confidence: product.confidence, summary: product.summary, showFreeConfidence: product.showFreeConfidence },
      races: product.races.map(item => ({ legNumber: item.legNumber, confidence: item.confidence, strategyType: item.strategyType, comment: item.comment, race: { id: item.race.id, raceDate: item.race.raceDate, venue: item.race.venue, number: item.race.number, name: item.race.name, startsAt: item.race.startsAt, status: item.race.status }, selections: item.selections.map(selection => ({ entryId: selection.entryId, horseId: selection.entry.horseId, number: selection.entry.number, horseName: selection.entry.horseName, status: selection.entry.status, selectionType: selection.selectionType })) })),
      combinationCount, amountPerPointYen: product.amountPerPointYen, assumedPurchaseAmountYen
    };
    return { deadlineAt, combinationCount, assumedPurchaseAmountYen, contentSnapshot };
  }

  private async ensurePublicationEnabled(tx: Tx) {
    const settings = await tx.systemSetting.findUnique({ where: { id: 'global' }, select: { predictionPublicationEnabled: true } });
    if (settings && !settings.predictionPublicationEnabled) throw new ForbiddenException({ code: 'PREDICTION_PUBLICATION_STOPPED', message: '管理設定により予想公開を停止しています。' });
  }

  private view(product: Awaited<ReturnType<Win5Controller['state']>>) {
    return { ...product, currentCombinationCount: product.races.length === 5 && product.races.every(item => item.selections.length) ? win5CombinationCount(product.races.map(item => item.selections.length)) : null };
  }

  private freeProduct(product: {
    id: string; type: string; targetDate: string; title: string; status: string; scheduledPublishAt: Date; publishedAt: Date | null;
    showFreeConfidence: boolean; confidence: string;
    races: Array<{ legNumber: number; race: { id: string; venue: string; number: number; startsAt: Date; status: string } }>;
    versions: Array<{ id: string; version: number; status: string; publishedAt: Date; previousVersionId: string | null }>;
  }) {
    const latest = product.versions[0] ?? null;
    return {
      id: product.id,
      type: product.type,
      targetDate: product.targetDate,
      title: product.title,
      status: latest ? product.status : 'SCHEDULED',
      scheduledPublishAt: product.scheduledPublishAt,
      publishedAt: latest?.publishedAt ?? null,
      confidence: latest && product.showFreeConfidence ? product.confidence : null,
      races: product.races.map(item => ({ legNumber: item.legNumber, race: item.race })),
      latestVersion: latest
    } as const;
  }

  private freeSelect(now: Date) {
    return {
      id: true, type: true, targetDate: true, title: true, status: true, scheduledPublishAt: true, publishedAt: true, showFreeConfidence: true, confidence: true,
      races: { orderBy: { legNumber: 'asc' as const }, select: { legNumber: true, race: { select: { id: true, venue: true, number: true, startsAt: true, status: true } } } },
      versions: { where: { publishedAt: { lte: now } }, orderBy: { version: 'desc' as const }, take: 1, select: { id: true, version: true, status: true, publishedAt: true, previousVersionId: true } }
    } as const;
  }

  @Get('win5')
  async memberList(@Query() query: unknown) {
    const input = z.object({ targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), page: z.coerce.number().int().min(1).max(10000).default(1) }).parse(query);
    const now = new Date(); const limit = 20;
    const where = input.targetDate ? { targetDate: input.targetDate } : {};
    const [products, total] = await this.auth.db.$transaction([
      this.auth.db.predictionProduct.findMany({ where, orderBy: [{ targetDate: 'desc' }, { createdAt: 'desc' }], take: limit, skip: (input.page - 1) * limit, select: this.freeSelect(now) }),
      this.auth.db.predictionProduct.count({ where })
    ]);
    return { items: products.map(product => this.freeProduct(product)), total, page: input.page, limit };
  }

  @Get('win5/:productId')
  async memberDetail(@Req() req: AppRequest, @Param('productId') productId: string, @Query() query: unknown) {
    z.string().uuid().parse(productId);
    const input = z.object({ version: z.coerce.number().int().positive().optional() }).parse(query);
    const now = new Date();
    const product = await this.auth.db.predictionProduct.findUnique({ where: { id: productId }, select: { ...this.freeSelect(now), expertId: true } });
    if (!product) throw new NotFoundException();
    const safeProduct = this.freeProduct(product);
    const versions = await this.auth.db.predictionProductVersion.findMany({
      where: { productId, publishedAt: { lte: now } }, orderBy: { version: 'desc' },
      select: { id: true, version: true, status: true, publishedAt: true, previousVersionId: true }
    });
    let identity: AuthContext | null = null;
    try { identity = await this.auth.authenticate(req); } catch (error) { if (!(error instanceof UnauthorizedException)) throw error; }
    const staffAccess = !!identity && identity.aal === 2 && (['ADMIN', 'OPERATOR'].includes(identity.role) || (identity.role === 'EXPERT' && product.expertId === identity.id));
    const entitlement = identity?.role === 'MEMBER' ? await this.auth.db.entitlement.findFirst({
      where: { userId: identity.id, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now }, OR: [{ raceDate: null }, { raceDate: product.targetDate }] },
      select: { id: true }
    }) : null;
    const fullAccess = staffAccess || !!entitlement;
    const selectedNumber = input.version ?? versions[0]?.version;
    if (input.version && !versions.some(version => version.version === input.version)) throw new NotFoundException();
    if (!fullAccess || !selectedNumber) return { access: 'METADATA', product: safeProduct, version: null, versions, locked: !!versions.length };
    const selected = await this.auth.db.predictionProductVersion.findFirst({
      where: { productId, version: selectedNumber, publishedAt: { lte: now } },
      select: { id: true, version: true, status: true, confidence: true, combinationCount: true, amountPerPointYen: true, assumedPurchaseAmountYen: true, contentSnapshot: true, publishedAt: true, deadlineAt: true, correctionReason: true, previousVersionId: true }
    });
    if (!selected) throw new NotFoundException();
    const fullHistory = await this.auth.db.predictionProductVersion.findMany({ where: { productId, publishedAt: { lte: now } }, orderBy: { version: 'desc' }, select: { id: true, version: true, status: true, publishedAt: true, previousVersionId: true, correctionReason: true } });
    return { access: 'FULL', product: safeProduct, version: selected, versions: fullHistory, locked: false };
  }

  @Get('admin/win5')
  async adminList(@Req() req: AppRequest, @Query() query: unknown) {
    await this.actor(req, ['ADMIN', 'OPERATOR']);
    const input = z.object({ targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(query);
    return this.auth.db.predictionProduct.findMany({ where: input.targetDate ? { targetDate: input.targetDate } : {}, orderBy: [{ targetDate: 'desc' }, { createdAt: 'desc' }], include: { expert: { select: { id: true, displayName: true } }, _count: { select: { races: true, versions: true } } } });
  }

  @Get('expert/win5')
  async expertList(@Req() req: AppRequest) {
    const actor = await this.actor(req, ['EXPERT']);
    return this.auth.db.predictionProduct.findMany({ where: { expertId: actor.id }, orderBy: [{ targetDate: 'desc' }, { createdAt: 'desc' }], include: { expert: { select: { id: true, displayName: true } }, _count: { select: { races: true, versions: true } } } });
  }

  @Post('admin/win5')
  async create(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.actor(req, ['ADMIN', 'OPERATOR']);
    const input = win5ProductCreateSchema.parse(body);
    return this.locked(async tx => {
      const requestKey = z.string().uuid().parse(req.headers['idempotency-key']);
      const key = `win5:create:${actor.id}:${requestKey}`; const requestHash = hashToken(JSON.stringify(input));
      const prior = await tx.idempotencyKey.findUnique({ where: { key } });
      if (prior) { if (prior.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '再送の内容が変わっています。' }); return prior.response; }
      const expert = await tx.user.findUnique({ where: { id: input.expertId }, select: { role: true, disabledAt: true } });
      if (!expert || expert.role !== 'EXPERT' || expert.disabledAt) throw new BadRequestException({ code: 'INVALID_EXPERT', message: '有効な専門家を指定してください。' });
      const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { win5DefaultAmountPerPointYen: true } });
      if (await tx.predictionProduct.findUnique({ where: { type_targetDate: { type: input.type, targetDate: input.targetDate } }, select: { id: true } })) throw new ConflictException({ code: 'WIN5_DUPLICATE_TARGET_DATE', message: '同じ対象日のWIN5予想はすでに作成されています。' });
      const product = await tx.predictionProduct.create({ data: { type: input.type, targetDate: input.targetDate, title: input.title, expertId: input.expertId, scheduledPublishAt: new Date(input.scheduledPublishAt), accessScope: input.accessScope, confidence: input.confidence, summary: input.summary, showFreeConfidence: input.showFreeConfidence, amountPerPointYen: input.amountPerPointYen ?? settings.win5DefaultAmountPerPointYen, updatedBy: actor.id } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: 'WIN5_PRODUCT_CREATE', targetType: 'PREDICTION_PRODUCT', targetId: product.id, reason: input.reason, details: json({ type: product.type, targetDate: product.targetDate, expertId: product.expertId }), requestId: req.requestId } });
      const response = json(product); await tx.idempotencyKey.create({ data: { key, requestHash, response } }); return response;
    });
  }

  @Patch('admin/win5/:productId')
  async update(@Req() req: AppRequest, @Param('productId') productId: string, @Body() body: unknown) {
    z.string().uuid().parse(productId); const actor = await this.actor(req, ['ADMIN', 'OPERATOR']); const input = win5ProductUpdateSchema.parse(body);
    return this.locked(async tx => {
      const before = await tx.predictionProduct.findUnique({ where: { id: productId } });
      if (!before) throw new NotFoundException();
      if (before.revision !== input.revision) throw new ConflictException({ code: 'WIN5_DRAFT_CONFLICT', message: '別の端末でWIN5予想が変更されました。再読み込みしてください。' });
      const expert = await tx.user.findUnique({ where: { id: input.expertId }, select: { role: true, disabledAt: true } });
      if (!expert || expert.role !== 'EXPERT' || expert.disabledAt) throw new BadRequestException({ code: 'INVALID_EXPERT', message: '有効な専門家を指定してください。' });
      const product = await tx.predictionProduct.update({ where: { id: productId }, data: { title: input.title, expertId: input.expertId, scheduledPublishAt: new Date(input.scheduledPublishAt), accessScope: input.accessScope, confidence: input.confidence, summary: input.summary, showFreeConfidence: input.showFreeConfidence, amountPerPointYen: input.amountPerPointYen, revision: { increment: 1 }, updatedBy: actor.id, updatedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: 'WIN5_PRODUCT_UPDATE', targetType: 'PREDICTION_PRODUCT', targetId: product.id, reason: input.reason, details: json({ fromRevision: before.revision, toRevision: product.revision }), requestId: req.requestId } });
      return product;
    });
  }

  @Get(['admin/win5/:productId', 'expert/win5/:productId'])
  async detail(@Req() req: AppRequest, @Param('productId') productId: string) {
    z.string().uuid().parse(productId);
    return this.locked(async tx => { const { product } = await this.access(tx, req, productId); return this.view(product); });
  }

  @Get(['admin/win5/:productId/options', 'expert/win5/:productId/options'])
  async options(@Req() req: AppRequest, @Param('productId') productId: string) {
    z.string().uuid().parse(productId);
    return this.locked(async tx => {
      const { product } = await this.access(tx, req, productId);
      return tx.race.findMany({ where: { raceDate: product.targetDate }, orderBy: [{ startsAt: 'asc' }, { venue: 'asc' }, { number: 'asc' }], include: { entries: { orderBy: { number: 'asc' } } } });
    });
  }

  @Put(['admin/win5/:productId/races/:legNumber', 'expert/win5/:productId/races/:legNumber'])
  async saveLeg(@Req() req: AppRequest, @Param('productId') productId: string, @Param('legNumber') legParam: string, @Body() body: unknown) {
    z.string().uuid().parse(productId); const legNumber = z.coerce.number().int().min(1).max(5).parse(legParam); const input = win5LegUpdateSchema.parse({ ...(body as object), legNumber });
    return this.locked(async tx => {
      const { actor, product } = await this.access(tx, req, productId);
      if (product.revision !== input.productRevision) throw new ConflictException({ code: 'WIN5_DRAFT_CONFLICT', message: '別の端末でWIN5予想が変更されました。再読み込みしてください。' });
      const race = await tx.race.findUnique({ where: { id: input.raceId }, include: { entries: true } });
      if (!race || race.raceDate !== product.targetDate) throw new BadRequestException({ code: 'RACE_DATE_MISMATCH', message: '対象日と同じ開催日のレースを指定してください。' });
      const entries = new Set(race.entries.map(entry => entry.id));
      if (input.selectionEntryIds.some(id => !entries.has(id))) throw new BadRequestException({ code: 'INVALID_SELECTION_ENTRY', message: '選択馬は指定レースの出走馬から選んでください。' });
      const existing = await tx.predictionProductRace.findUnique({ where: { productId_legNumber: { productId, legNumber } } });
      if (product.races.some(item => item.legNumber !== legNumber && item.raceId === input.raceId)) throw new ConflictException({ code: 'WIN5_DUPLICATE_RACE', message: '同じレースを複数の対象順には設定できません。' });
      if (existing) await tx.predictionProductRace.delete({ where: { id: existing.id } });
      const saved = await tx.predictionProductRace.create({ data: { productId, raceId: input.raceId, legNumber, confidence: input.confidence, strategyType: input.strategyType, comment: input.comment, selections: { create: input.selectionEntryIds.map((entryId, index) => ({ entryId, selectionType: entryId === input.centerEntryId ? 'CENTER' : 'SELECTED', displayOrder: index + 1 })) } }, include: { selections: { orderBy: { displayOrder: 'asc' } } } });
      const updated = await tx.predictionProduct.update({ where: { id: productId }, data: { revision: { increment: 1 }, updatedBy: actor.id, updatedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: 'WIN5_LEG_SAVE', targetType: 'PREDICTION_PRODUCT_RACE', targetId: saved.id, reason: input.reason, details: json({ productId, legNumber, raceId: input.raceId, selectionEntryIds: input.selectionEntryIds, centerEntryId: input.centerEntryId, revision: updated.revision }), requestId: req.requestId } });
      return { ...saved, productRevision: updated.revision };
    });
  }

  @Post(['admin/win5/:productId/preview', 'expert/win5/:productId/preview'])
  async preview(@Req() req: AppRequest, @Param('productId') productId: string, @Body() body: unknown) {
    z.string().uuid().parse(productId); const input = win5PreviewSchema.parse(body);
    return this.locked(async tx => {
      const { actor, product } = await this.access(tx, req, productId); await this.ensurePublicationEnabled(tx);
      if (product.revision !== input.productRevision) throw new ConflictException({ code: 'WIN5_DRAFT_CONFLICT', message: '保存後にWIN5予想が変更されました。再読み込みしてください。' });
      const correcting = product.versions.length > 0;
      if (correcting && actor.role !== 'ADMIN') throw new ForbiddenException({ code: 'CORRECTION_APPROVAL_REQUIRED', message: 'WIN5の訂正公開には管理者の確認が必要です。' });
      if (correcting && !input.correctionReason) throw new BadRequestException({ code: 'CORRECTION_REASON_REQUIRED', message: '訂正理由を入力してください。' });
      const calculated = this.publishable(product);
      const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { win5CombinationWarningLimit: true } });
      const warnings = [
        ...(calculated.combinationCount > settings.win5CombinationWarningLimit ? [`組合せ数が警告値${settings.win5CombinationWarningLimit}点を超えています。`] : []),
        ...(product.scheduledPublishAt < new Date() ? ['公開予定時刻を過ぎています。'] : []),
        ...(product.races.some(item => item.selections.some(selection => selection.entry.status !== 'ACTIVE')) ? ['出走予定以外の選択馬が含まれています。'] : [])
      ];
      const snapshot = { correctionReason: input.correctionReason, nextVersion: (product.versions[0]?.version ?? 0) + 1 };
      const created = await tx.predictionProductPreview.create({ data: { actorId: actor.id, productId, baselineHash: this.fingerprint(product), snapshot, expiresAt: new Date(Date.now() + 15 * 60000) } });
      return { previewId: created.id, expiresAt: created.expiresAt, version: snapshot.nextVersion, correction: correcting, correctionReason: input.correctionReason, warnings, deadlineAt: calculated.deadlineAt, combinationCount: calculated.combinationCount, amountPerPointYen: product.amountPerPointYen, assumedPurchaseAmountYen: calculated.assumedPurchaseAmountYen, content: calculated.contentSnapshot };
    });
  }

  @Post(['admin/win5/:productId/publish/:previewId', 'expert/win5/:productId/publish/:previewId'])
  async publish(@Req() req: AppRequest, @Param('productId') productId: string, @Param('previewId') previewId: string) {
    z.string().uuid().parse(productId); z.string().uuid().parse(previewId);
    return this.locked(async tx => {
      const { actor, product } = await this.access(tx, req, productId); await this.ensurePublicationEnabled(tx);
      const preview = await tx.predictionProductPreview.findUnique({ where: { id: previewId } });
      if (!preview || preview.productId !== productId || preview.actorId !== actor.id) throw new NotFoundException();
      if (preview.confirmedVersionId) return { published: true, versionId: preview.confirmedVersionId, alreadyPublished: true };
      if (preview.expiresAt <= new Date()) throw new ConflictException({ code: 'PREVIEW_EXPIRED', message: '公開前確認の有効期限が切れました。再確認してください。' });
      if (preview.baselineHash !== this.fingerprint(product)) throw new ConflictException({ code: 'WIN5_STALE_PREVIEW', message: '確認後にレースまたは予想が変わりました。再確認してください。' });
      const details = previewDetailsSchema.parse(preview.snapshot); const previous = product.versions[0] ?? null; const correcting = !!previous;
      if (details.nextVersion !== (previous?.version ?? 0) + 1) throw new ConflictException({ code: 'WIN5_STALE_PREVIEW', message: '別の公開版が追加されました。再確認してください。' });
      if (correcting && actor.role !== 'ADMIN') throw new ForbiddenException({ code: 'CORRECTION_APPROVAL_REQUIRED', message: 'WIN5の訂正公開には管理者の確認が必要です。' });
      const calculated = this.publishable(product);
      const version = await tx.predictionProductVersion.create({ data: { productId, version: details.nextVersion, status: correcting ? 'CORRECTED' : 'PUBLISHED', accessScope: product.accessScope, confidence: product.confidence, combinationCount: calculated.combinationCount, amountPerPointYen: product.amountPerPointYen, assumedPurchaseAmountYen: calculated.assumedPurchaseAmountYen, contentSnapshot: json(calculated.contentSnapshot), publisherId: actor.id, deadlineAt: calculated.deadlineAt, correctionReason: correcting ? details.correctionReason : null, previousVersionId: previous?.id } });
      await tx.predictionProduct.update({ where: { id: productId }, data: { status: correcting ? 'CORRECTED' : 'PUBLISHED', publishedAt: product.publishedAt ?? version.publishedAt, closeAt: calculated.deadlineAt, updatedBy: actor.id, updatedAt: new Date() } });
      const activatedDayPasses = correcting ? 0 : await activatePendingDayPasses(tx, product.targetDate, version.publishedAt, actor.id);
      await tx.predictionProductPreview.update({ where: { id: preview.id }, data: { confirmedVersionId: version.id } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: correcting ? 'WIN5_PRODUCT_CORRECT' : 'WIN5_PRODUCT_PUBLISH', targetType: 'PREDICTION_PRODUCT_VERSION', targetId: version.id, reason: correcting ? details.correctionReason : 'WIN5予想の公開', details: json({ productId, version: version.version, previousVersionId: previous?.id ?? null, combinationCount: calculated.combinationCount, assumedPurchaseAmountYen: calculated.assumedPurchaseAmountYen, activatedDayPasses }), requestId: req.requestId } });
      return { published: true, versionId: version.id, version: version.version, alreadyPublished: false, publishedAt: version.publishedAt };
    });
  }
}
