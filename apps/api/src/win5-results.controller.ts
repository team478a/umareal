import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { calculateWin5Result, win5ResultConfirmSchema, win5ResultImportSchema, win5ResultRuleVersion } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const frozenProductSchema = z.object({
  races: z.array(z.object({
    legNumber: z.number().int().min(1).max(5),
    race: z.object({ id: z.string().uuid() }).passthrough(),
    selections: z.array(z.object({ entryId: z.string().uuid() }).passthrough()).min(1)
  }).passthrough()).length(5)
}).passthrough();
const resultEntriesSchema = z.array(z.object({
  entryId: z.string().uuid(), status: z.string(), finishPosition: z.number().int().nullable()
}).passthrough());
const resultPayoutsSchema = z.array(z.object({ refund: z.boolean() }).passthrough());

@Controller()
export class Win5ResultsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async staff(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!['ADMIN', 'OPERATOR'].includes(actor.role) || actor.aal !== 2) throw new ForbiddenException({ code: actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'WIN5結果管理の権限と二段階認証を確認してください。' });
    return actor;
  }

  private async calculate(tx: Tx, productId: string, officialPayoutYen: number) {
    const product = await tx.predictionProduct.findUnique({ where: { id: productId }, select: { id: true, versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true, version: true, combinationCount: true, assumedPurchaseAmountYen: true, contentSnapshot: true, publishedAt: true, deadlineAt: true } } } });
    if (!product) throw new NotFoundException({ code: 'WIN5_NOT_FOUND', message: 'WIN5予想が見つかりません。' });
    const productVersion = product.versions[0];
    if (!productVersion) throw new ConflictException({ code: 'WIN5_NOT_PUBLISHED', message: '公開済みのWIN5予想がありません。' });
    const snapshot = frozenProductSchema.parse(productVersion.contentSnapshot);
    const ordered = [...snapshot.races].sort((a, b) => a.legNumber - b.legNumber);
    if (ordered.some((leg, index) => leg.legNumber !== index + 1)) throw new ConflictException({ code: 'WIN5_FROZEN_LEGS_INVALID', message: '公開版の対象レースを確認してください。' });

    const legs = [];
    const reviewReasons: string[] = [];
    for (const frozen of ordered) {
      const raceResult = await tx.raceResultVersion.findFirst({
        where: { raceId: frozen.race.id }, orderBy: { version: 'desc' },
        select: { id: true, version: true, raceId: true, raceCanceled: true, entriesSnapshot: true, payoutsSnapshot: true, race: { select: { entries: { select: { id: true, number: true, horseName: true } } } } }
      });
      if (!raceResult) throw new ConflictException({ code: 'WIN5_RESULTS_INCOMPLETE', message: `第${frozen.legNumber}レースの確定結果がありません。` });
      const entries = resultEntriesSchema.parse(raceResult.entriesSnapshot);
      const payouts = resultPayoutsSchema.parse(raceResult.payoutsSnapshot);
      const exceptional = raceResult.raceCanceled || entries.some(entry => ['WITHDRAWN', 'EXCLUDED', 'CANCELED'].includes(entry.status)) || payouts.some(payout => payout.refund);
      const winners = entries.filter(entry => entry.status === 'FINISHED' && entry.finishPosition === 1);
      if (exceptional) reviewReasons.push(`第${frozen.legNumber}レースに中止・取消・除外・返還があります。`);
      if (winners.length !== 1) reviewReasons.push(`第${frozen.legNumber}レースの1着馬を一意に確定できません。`);
      const winner = winners[0];
      const entry = winner ? raceResult.race.entries.find(item => item.id === winner.entryId) : null;
      if (winner && !entry) reviewReasons.push(`第${frozen.legNumber}レースの1着馬が出走表と一致しません。`);
      legs.push({
        legNumber: frozen.legNumber,
        raceId: frozen.race.id,
        raceResultVersionId: raceResult.id,
        raceResultVersion: raceResult.version,
        winnerEntryId: winner?.entryId ?? null,
        winnerNumber: entry?.number ?? null,
        winnerHorseName: entry?.horseName ?? null,
        hit: winner ? frozen.selections.some(selection => selection.entryId === winner.entryId) : false
      });
    }
    const readyLegs = legs.every(leg => leg.winnerEntryId && leg.winnerNumber && leg.winnerHorseName);
    const status = reviewReasons.length || !readyLegs ? 'REVIEW_REQUIRED' : 'READY';
    const result = readyLegs ? calculateWin5Result({ combinationCount: productVersion.combinationCount, assumedPurchaseAmountYen: productVersion.assumedPurchaseAmountYen, officialPayoutYen, legs: legs.map(leg => ({ ...leg, winnerEntryId: leg.winnerEntryId!, winnerNumber: leg.winnerNumber!, winnerHorseName: leg.winnerHorseName! })) }) : null;
    const sourceHash = hashToken(JSON.stringify({ productVersionId: productVersion.id, officialPayoutYen, ruleVersion: win5ResultRuleVersion, legs: legs.map(leg => ({ raceResultVersionId: leg.raceResultVersionId, winnerEntryId: leg.winnerEntryId })) }));
    return { productVersion, legs, reviewReasons, status, result, sourceHash };
  }

  private async view(tx: Tx, productId: string) {
    const product = await tx.predictionProduct.findUnique({
      where: { id: productId },
      select: {
        id: true,
        resultDraft: { select: { revision: true, status: true, officialPayoutYen: true, legsSnapshot: true, ruleVersion: true, updatedAt: true } },
        resultVersions: { orderBy: { version: 'desc' }, select: { id: true, version: true, sourceRevision: true, status: true, ruleVersion: true, hitLegs: true, perfectHit: true, combinationCount: true, assumedPurchaseAmountYen: true, officialPayoutYen: true, assumedPayoutYen: true, recoveryRateTenthsPercent: true, reason: true, confirmedAt: true, productVersion: { select: { version: true } }, legs: { orderBy: { legNumber: 'asc' }, select: { legNumber: true, raceId: true, raceResultVersionId: true, winnerEntryId: true, winnerNumber: true, winnerHorseName: true, hit: true } } } }
      }
    });
    if (!product) throw new NotFoundException({ code: 'WIN5_NOT_FOUND', message: 'WIN5予想が見つかりません。' });
    const draft = product.resultDraft ? { ...product.resultDraft, ...(product.resultDraft.legsSnapshot as object) } : null;
    return { draft, versions: product.resultVersions };
  }

  @Get('admin/win5/:productId/result')
  async get(@Req() req: AppRequest, @Param('productId') productId: string) {
    await this.staff(req); z.string().uuid().parse(productId);
    return this.view(this.auth.db, productId);
  }

  @Post('admin/win5/:productId/results/import')
  async import(@Req() req: AppRequest, @Param('productId') productId: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().uuid().parse(productId); const input = win5ResultImportSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262028)::text`;
      const calculated = await this.calculate(tx, productId, input.officialPayoutYen);
      const legsSnapshot = json({ legs: calculated.legs, reviewReasons: calculated.reviewReasons, calculation: calculated.result });
      let revision: number;
      if (input.revision === 0) {
        try {
          const created = await tx.win5ResultDraft.create({ data: { productId, productVersionId: calculated.productVersion.id, status: calculated.status, officialPayoutYen: input.officialPayoutYen, sourceHash: calculated.sourceHash, legsSnapshot, ruleVersion: win5ResultRuleVersion, updatedBy: actor.id } });
          revision = created.revision;
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'WIN5_RESULT_REVISION_CONFLICT', message: '別の担当者が結果を取り込みました。再読み込みしてください。' });
          throw error;
        }
      } else {
        const changed = await tx.win5ResultDraft.updateMany({ where: { productId, revision: input.revision }, data: { productVersionId: calculated.productVersion.id, status: calculated.status, officialPayoutYen: input.officialPayoutYen, sourceHash: calculated.sourceHash, legsSnapshot, ruleVersion: win5ResultRuleVersion, revision: { increment: 1 }, updatedBy: actor.id, updatedAt: new Date() } });
        if (changed.count !== 1) throw new ConflictException({ code: 'WIN5_RESULT_REVISION_CONFLICT', message: '別の担当者が結果を取り込みました。再読み込みしてください。' });
        revision = input.revision + 1;
      }
      await this.auth.audit(tx, req, 'WIN5_RESULT_IMPORT', productId, input.reason, { revision, status: calculated.status, productVersionId: calculated.productVersion.id, raceResultVersionIds: calculated.legs.map(leg => leg.raceResultVersionId), ruleVersion: win5ResultRuleVersion });
      return { revision, status: calculated.status, reviewReasons: calculated.reviewReasons, calculation: calculated.result, legs: calculated.legs };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Post('admin/win5/:productId/results/confirm')
  async confirm(@Req() req: AppRequest, @Param('productId') productId: string, @Body() body: unknown) {
    const actor = await this.staff(req); z.string().uuid().parse(productId); const input = win5ResultConfirmSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      const existing = await tx.win5ResultVersion.findUnique({ where: { productId_sourceRevision: { productId, sourceRevision: input.revision } }, select: { id: true, version: true } });
      if (existing) return { versionId: existing.id, version: existing.version, alreadyConfirmed: true };
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM win5_result_drafts WHERE "productId" = ${productId}::uuid AND revision = ${input.revision} FOR UPDATE`;
      if (!locked.length) throw new ConflictException({ code: 'WIN5_RESULT_REVISION_CONFLICT', message: '結果を再読み込みしてください。' });
      const draft = await tx.win5ResultDraft.findUniqueOrThrow({ where: { productId } });
      if (draft.status !== 'READY') throw new BadRequestException({ code: 'WIN5_RESULT_REVIEW_REQUIRED', message: '例外状態があるため結果を確定できません。運用ルール確定後に対応してください。' });
      const calculated = await this.calculate(tx, productId, draft.officialPayoutYen);
      if (calculated.status !== 'READY' || calculated.sourceHash !== draft.sourceHash || !calculated.result) throw new ConflictException({ code: 'WIN5_RESULT_SOURCE_CHANGED', message: '公開版またはレース結果版が変わりました。結果を再取込してください。' });
      const latest = await tx.win5ResultVersion.findFirst({ where: { productId }, orderBy: { version: 'desc' }, select: { version: true } });
      const value = await tx.win5ResultVersion.create({
        data: {
          productId, productVersionId: calculated.productVersion.id, version: (latest?.version ?? 0) + 1, sourceRevision: input.revision, ruleVersion: win5ResultRuleVersion,
          hitLegs: calculated.result.hitLegs, perfectHit: calculated.result.perfectHit, combinationCount: calculated.productVersion.combinationCount,
          assumedPurchaseAmountYen: calculated.productVersion.assumedPurchaseAmountYen, officialPayoutYen: draft.officialPayoutYen,
          assumedPayoutYen: calculated.result.assumedPayoutYen, recoveryRateTenthsPercent: calculated.result.recoveryRateTenthsPercent,
          reason: input.reason, confirmedBy: actor.id,
          legs: { create: calculated.legs.map(leg => ({ legNumber: leg.legNumber, raceId: leg.raceId, raceResultVersionId: leg.raceResultVersionId, winnerEntryId: leg.winnerEntryId!, winnerNumber: leg.winnerNumber!, winnerHorseName: leg.winnerHorseName!, hit: leg.hit })) }
        }, select: { id: true, version: true, hitLegs: true, perfectHit: true, assumedPayoutYen: true, recoveryRateTenthsPercent: true }
      });
      await this.auth.audit(tx, req, 'WIN5_RESULT_CONFIRM', productId, input.reason, { resultVersionId: value.id, version: value.version, sourceRevision: input.revision, productVersionId: calculated.productVersion.id, raceResultVersionIds: calculated.legs.map(leg => leg.raceResultVersionId), ruleVersion: win5ResultRuleVersion });
      return { versionId: value.id, version: value.version, alreadyConfirmed: false, hitLegs: value.hitLegs, perfectHit: value.perfectHit, assumedPayoutYen: value.assumedPayoutYen, recoveryRatePercent: value.recoveryRateTenthsPercent / 10 };
    }, { timeout: 20000, maxWait: 10000 });
  }
}
