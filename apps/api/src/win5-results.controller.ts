import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { evaluatePrediction, evaluateWin5, win5ResultConfirmSchema } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const ruleVersion = 'WIN5_HORSE_EVALUATION_V1';
const importSchema = z.object({ revision: z.number().int().min(0), reason: z.string().trim().min(1).max(500) }).strict();
const frozenProductSchema = z.object({
  races: z.array(z.object({
    legNumber: z.number().int().min(1).max(5),
    confidence: z.enum(['S', 'A', 'B', 'C']),
    race: z.object({ id: z.string().uuid() }).passthrough(),
    evaluations: z.array(z.object({ entryId: z.string().uuid(), evaluationType: z.enum(['PRIMARY', 'SECONDARY', 'WATCH', 'RISK']) }).passthrough()).min(1)
  }).passthrough()).length(5)
}).passthrough();
const resultEntriesSchema = z.array(z.object({ entryId: z.string().uuid(), status: z.enum(['FINISHED', 'WITHDRAWN', 'EXCLUDED', 'DNF', 'CANCELED']), finishPosition: z.number().int().nullable() }).passthrough());

@Controller()
export class Win5ResultsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async staff(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!['ADMIN', 'OPERATOR'].includes(actor.role) || actor.aal !== 2) throw new ForbiddenException({ code: actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'WIN5結果管理の権限と二段階認証を確認してください。' });
    return actor;
  }

  private async calculate(tx: Tx, productId: string) {
    const product = await tx.predictionProduct.findUnique({ where: { id: productId }, select: { id: true, versions: { where: { formatVersion: 'HORSE_EVALUATION_V1' }, orderBy: { version: 'desc' }, take: 1, select: { id: true, version: true, formatVersion: true, contentSnapshot: true } } } });
    if (!product) throw new NotFoundException({ code: 'WIN5_NOT_FOUND', message: 'WIN5予想が見つかりません。' });
    const productVersion = product.versions[0];
    if (!productVersion) throw new ConflictException({ code: 'WIN5_EVALUATION_NOT_PUBLISHED', message: '馬評価方式で公開済みのWIN5予想がありません。' });
    const snapshot = frozenProductSchema.parse(productVersion.contentSnapshot);
    const ordered = [...snapshot.races].sort((a, b) => a.legNumber - b.legNumber);
    if (ordered.some((leg, index) => leg.legNumber !== index + 1)) throw new ConflictException({ code: 'WIN5_FROZEN_LEGS_INVALID', message: '公開版の対象レースを確認してください。' });

    const legs = [];
    const reviewReasons: string[] = [];
    for (const frozen of ordered) {
      const raceResult = await tx.raceResultVersion.findFirst({ where: { raceId: frozen.race.id }, orderBy: { version: 'desc' }, select: { id: true, version: true, raceId: true, raceCanceled: true, entriesSnapshot: true, race: { select: { entries: { select: { id: true, number: true, horseName: true } } } } } });
      if (!raceResult) throw new ConflictException({ code: 'WIN5_RESULTS_INCOMPLETE', message: `第${frozen.legNumber}対象レースの確定結果がありません。` });
      const entries = resultEntriesSchema.parse(raceResult.entriesSnapshot);
      const winners = entries.filter(entry => entry.status === 'FINISHED' && entry.finishPosition === 1);
      const winner = winners[0];
      const winnerEntry = winner ? raceResult.race.entries.find(entry => entry.id === winner.entryId) : null;
      const evaluation = evaluatePrediction({ confidence: frozen.confidence, horses: frozen.evaluations, resultEntries: entries, raceCanceled: raceResult.raceCanceled });
      if (evaluation.status === 'REVIEW_REQUIRED' || !winnerEntry) reviewReasons.push(`第${frozen.legNumber}対象レースの勝ち馬または評価結果を確定できません。`);
      legs.push({ legNumber: frozen.legNumber, raceId: frozen.race.id, raceResultVersionId: raceResult.id, raceResultVersion: raceResult.version, winnerEntryId: winner?.entryId ?? null, winnerNumber: winnerEntry?.number ?? null, winnerHorseName: winnerEntry?.horseName ?? null, ...evaluation });
    }
    const summary = evaluateWin5(legs.map(leg => ({ legNumber: leg.legNumber, status: leg.status, winnerInRecommended: leg.winnerInRecommended })));
    const sourceHash = hashToken(JSON.stringify({ productVersionId: productVersion.id, ruleVersion, legs: legs.map(leg => ({ raceResultVersionId: leg.raceResultVersionId, winnerEntryId: leg.winnerEntryId })) }));
    return { productVersion, legs, reviewReasons, status: reviewReasons.length ? 'REVIEW_REQUIRED' : 'READY', summary, sourceHash };
  }

  private async view(tx: Tx, productId: string) {
    const product = await tx.predictionProduct.findUnique({ where: { id: productId }, select: {
      id: true,
      evaluationDraft: { select: { revision: true, status: true, legsSnapshot: true, ruleVersion: true, updatedAt: true } },
      evaluationVersions: { orderBy: { version: 'desc' }, select: { id: true, version: true, sourceRevision: true, status: true, recommendedLegs: true, allWinnersRecommended: true, reason: true, confirmedAt: true, calculationRuleVersion: true, productVersion: { select: { version: true } }, legs: { orderBy: { legNumber: 'asc' }, select: { legNumber: true, raceId: true, raceResultVersionId: true, winnerEntryId: true, winnerNumber: true, winnerHorseName: true, primaryFinishedFirst: true, primaryFinishedTop2: true, primaryFinishedTop3: true, winnerInRecommended: true, status: true } } } }
    } });
    if (!product) throw new NotFoundException({ code: 'WIN5_NOT_FOUND', message: 'WIN5予想が見つかりません。' });
    return { draft: product.evaluationDraft ? { ...product.evaluationDraft, ...(product.evaluationDraft.legsSnapshot as object) } : null, versions: product.evaluationVersions };
  }

  @Get('admin/win5/:productId/result')
  async get(@Req() req: AppRequest, @Param('productId') productId: string) { await this.staff(req); z.string().uuid().parse(productId); return this.view(this.auth.db, productId); }

  @Post('admin/win5/:productId/results/import')
  async import(@Req() req: AppRequest, @Param('productId') productId: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().uuid().parse(productId); const input = importSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262028)::text`;
      const calculated = await this.calculate(tx, productId);
      const legsSnapshot = json({ legs: calculated.legs, reviewReasons: calculated.reviewReasons, summary: calculated.summary });
      let revision: number;
      if (input.revision === 0) {
        try { revision = (await tx.win5EvaluationDraft.create({ data: { productId, productVersionId: calculated.productVersion.id, status: calculated.status, sourceHash: calculated.sourceHash, legsSnapshot, ruleVersion, updatedBy: actor.id } })).revision; }
        catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'WIN5_EVALUATION_REVISION_CONFLICT', message: '別の担当者が結果を取り込みました。再読み込みしてください。' }); throw error; }
      } else {
        const changed = await tx.win5EvaluationDraft.updateMany({ where: { productId, revision: input.revision }, data: { productVersionId: calculated.productVersion.id, status: calculated.status, sourceHash: calculated.sourceHash, legsSnapshot, ruleVersion, revision: { increment: 1 }, updatedBy: actor.id, updatedAt: new Date() } });
        if (changed.count !== 1) throw new ConflictException({ code: 'WIN5_EVALUATION_REVISION_CONFLICT', message: '別の担当者が結果を取り込みました。再読み込みしてください。' });
        revision = input.revision + 1;
      }
      await this.auth.audit(tx, req, 'WIN5_EVALUATION_IMPORT', productId, input.reason, { revision, status: calculated.status, productVersionId: calculated.productVersion.id, raceResultVersionIds: calculated.legs.map(leg => leg.raceResultVersionId), ruleVersion });
      return { revision, status: calculated.status, reviewReasons: calculated.reviewReasons, summary: calculated.summary, legs: calculated.legs };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Post('admin/win5/:productId/results/confirm')
  async confirm(@Req() req: AppRequest, @Param('productId') productId: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().uuid().parse(productId); const input = win5ResultConfirmSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      const existing = await tx.win5EvaluationVersion.findUnique({ where: { productId_sourceRevision: { productId, sourceRevision: input.revision } }, select: { id: true, version: true } });
      if (existing) return { versionId: existing.id, version: existing.version, alreadyConfirmed: true };
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM win5_evaluation_drafts WHERE "productId" = ${productId}::uuid AND revision = ${input.revision} FOR UPDATE`;
      if (!locked.length) throw new ConflictException({ code: 'WIN5_EVALUATION_REVISION_CONFLICT', message: '結果を再読み込みしてください。' });
      const draft = await tx.win5EvaluationDraft.findUniqueOrThrow({ where: { productId } });
      const calculated = await this.calculate(tx, productId);
      if (calculated.sourceHash !== draft.sourceHash) throw new ConflictException({ code: 'WIN5_EVALUATION_SOURCE_CHANGED', message: '公開版またはレース結果版が変わりました。結果を再取込してください。' });
      if (calculated.reviewReasons.length || calculated.legs.some(leg => !leg.winnerEntryId || !leg.winnerNumber || !leg.winnerHorseName)) throw new BadRequestException({ code: 'WIN5_EVALUATION_REVIEW_REQUIRED', message: '要確認の対象レースがあるため、結果を確定できません。' });
      const latest = await tx.win5EvaluationVersion.findFirst({ where: { productId }, orderBy: { version: 'desc' }, select: { version: true } });
      const value = await tx.win5EvaluationVersion.create({ data: {
        productId, productVersionId: calculated.productVersion.id, version: (latest?.version ?? 0) + 1, sourceRevision: input.revision, status: calculated.summary.status, recommendedLegs: calculated.summary.recommendedLegs, allWinnersRecommended: calculated.summary.allWinnersRecommended, reason: input.reason, confirmedBy: actor.id, calculationRuleVersion: ruleVersion,
        legs: { create: calculated.legs.map(leg => ({ legNumber: leg.legNumber, raceId: leg.raceId, raceResultVersionId: leg.raceResultVersionId, winnerEntryId: leg.winnerEntryId!, winnerNumber: leg.winnerNumber!, winnerHorseName: leg.winnerHorseName!, primaryFinishedFirst: leg.primaryFinishedFirst, primaryFinishedTop2: leg.primaryFinishedTop2, primaryFinishedTop3: leg.primaryFinishedTop3, winnerInRecommended: leg.winnerInRecommended, status: leg.status })) }
      }, select: { id: true, version: true, status: true, recommendedLegs: true, allWinnersRecommended: true } });
      if (value.status !== 'REVIEW_REQUIRED') await tx.notificationEvent.create({ data: { win5EvaluationVersionId: value.id, eventType: 'WIN5_EVALUATION_CONFIRMED', status: 'QUEUED', payload: { win5EvaluationVersionId: value.id, productId } } });
      await this.auth.audit(tx, req, 'WIN5_EVALUATION_CONFIRM', productId, input.reason, { resultVersionId: value.id, version: value.version, sourceRevision: input.revision, productVersionId: calculated.productVersion.id, raceResultVersionIds: calculated.legs.map(leg => leg.raceResultVersionId), ruleVersion });
      return { versionId: value.id, version: value.version, alreadyConfirmed: false, status: value.status, recommendedLegs: value.recommendedLegs, allWinnersRecommended: value.allWinnersRecommended };
    }, { timeout: 20000, maxWait: 10000 });
  }

}
