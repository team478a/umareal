import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import { aggregatePerformances, canManage, payoutKey, raceResultInputSchema, requiresMfa, resultRuleVersion, settlePrediction } from '@keiba/domain';
import type { RaceResultInput, Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

@Controller()
export class ResultsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  private async staff(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN', 'OPERATOR'] as Role[])) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '結果管理の権限と二段階認証を確認してください。' });
    return actor;
  }
  private async race(raceId: string) {
    z.string().uuid().parse(raceId);
    const race = await this.auth.db.race.findUnique({ where: { id: raceId }, include: { entries: { orderBy: { number: 'asc' } }, resultDraft: true, resultVersions: { orderBy: { version: 'desc' }, select: { id: true, version: true, sourceRevision: true, ruleVersion: true, raceCanceled: true, reason: true, confirmedAt: true, confirmedBy: true } } } });
    if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
    return race;
  }
  private validateEntries(input: RaceResultInput, race: Awaited<ReturnType<ResultsController['race']>>) {
    const expected = new Set(race.entries.map(entry => entry.id));
    if (input.entries.length !== expected.size || input.entries.some(entry => !expected.has(entry.entryId))) throw new BadRequestException({ code: 'RESULT_ENTRIES_INCOMPLETE', message: '全出走馬の結果を重複なく入力してください。' });
  }

  @Get('admin/results/races')
  async races(@Req() req: AppRequest) {
    await this.staff(req);
    const items = await this.auth.db.race.findMany({ where: { startsAt: { lte: new Date() }, prediction: { versions: { some: {} } } }, orderBy: [{ startsAt: 'desc' }, { id: 'asc' }], take: 100, include: { resultDraft: { select: { revision: true, updatedAt: true } }, resultVersions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, confirmedAt: true, raceCanceled: true } } } });
    return { items: items.map(item => ({ id: item.id, raceDate: item.raceDate, venue: item.venue, number: item.number, name: item.name, startsAt: item.startsAt, status: item.status, draftRevision: item.resultDraft?.revision ?? 0, latestResult: item.resultVersions[0] ?? null })) };
  }

  @Get('admin/results/races/:raceId')
  async get(@Param('raceId') raceId: string, @Req() req: AppRequest) {
    await this.staff(req); const race = await this.race(raceId);
    const blank = { revision: 0, raceCanceled: false, reason: '', entries: race.entries.map(entry => ({ entryId: entry.id, status: 'FINISHED', finishPosition: null, popularity: entry.popularity, finalOdds: entry.winOdds?.toString() ?? null })), payouts: [] };
    return { race: { id: race.id, raceDate: race.raceDate, venue: race.venue, number: race.number, name: race.name, startsAt: race.startsAt, status: race.status }, entries: race.entries.map(entry => ({ id: entry.id, number: entry.number, horseName: entry.horseName })), draft: race.resultDraft ? { ...(race.resultDraft.content as object), revision: race.resultDraft.revision } : blank, versions: race.resultVersions };
  }

  @Patch('admin/results/races/:raceId')
  async save(@Param('raceId') raceId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req), input = raceResultInputSchema.parse(body), race = await this.race(raceId); this.validateEntries(input, race);
    if (new Date() < race.startsAt) throw new BadRequestException({ code: 'RESULT_BEFORE_START', message: '発走時刻前に結果は保存できません。' });
    const content = { raceCanceled: input.raceCanceled, entries: input.entries, payouts: input.payouts, reason: input.reason } as Prisma.InputJsonValue;
    return this.auth.db.$transaction(async tx => {
      if (input.revision === 0) {
        try { const created = await tx.raceResultDraft.create({ data: { raceId, revision: 1, content, updatedBy: actor.id } }); await this.auth.audit(tx, req, 'RACE_RESULT_DRAFT_SAVE', raceId, input.reason, { revision: 1 }); return { revision: created.revision }; }
        catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'RESULT_REVISION_CONFLICT', message: '別の担当者が結果を保存しました。再読み込みしてください。' }); throw error; }
      }
      const changed = await tx.raceResultDraft.updateMany({ where: { raceId, revision: input.revision }, data: { content, revision: { increment: 1 }, updatedBy: actor.id, updatedAt: new Date() } });
      if (changed.count !== 1) throw new ConflictException({ code: 'RESULT_REVISION_CONFLICT', message: '別の担当者が結果を保存しました。再読み込みしてください。' });
      await this.auth.audit(tx, req, 'RACE_RESULT_DRAFT_SAVE', raceId, input.reason, { revision: input.revision + 1 }); return { revision: input.revision + 1 };
    });
  }

  @Post('admin/results/races/:raceId/confirm')
  async confirm(@Param('raceId') raceId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req); z.string().uuid().parse(raceId);
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
      const race = await tx.race.findUniqueOrThrow({ where: { id: raceId }, include: { entries: true, prediction: { include: { versions: { include: { marks: true, bets: true }, orderBy: { version: 'asc' } } } } } });
      if (new Date() < race.startsAt) throw new BadRequestException({ code: 'RESULT_BEFORE_START', message: '発走時刻前に結果を確定できません。' });
      const expected = new Set(race.entries.map(entry => entry.id)); if (input.entries.length !== expected.size || input.entries.some(entry => !expected.has(entry.entryId))) throw new BadRequestException({ code: 'RESULT_ENTRIES_INCOMPLETE', message: '全出走馬の結果を入力してください。' });
      const withdrawnNumbers = new Set(race.entries.filter(entry => ['WITHDRAWN', 'EXCLUDED'].includes(input.entries.find(item => item.entryId === entry.id)?.status ?? '')).map(entry => entry.number));
      const refundKeys = new Set(input.payouts.filter(payout => payout.refund).map(payout => payoutKey(payout.betType, payout.combination)));
      if (!input.raceCanceled) for (const prediction of race.prediction?.versions ?? []) for (const bet of prediction.bets) for (const combination of z.array(z.array(z.number())).parse(bet.combination)) if (combination.some(number => withdrawnNumbers.has(number)) && !refundKeys.has(payoutKey(bet.betType, combination))) throw new BadRequestException({ code: 'REFUND_REQUIRED', message: `${bet.betType} ${combination.join('-')} の返還を明示してください。` });
      const latest = await tx.raceResultVersion.findFirst({ where: { raceId }, orderBy: { version: 'desc' }, select: { version: true } });
      const performances = (race.prediction?.versions ?? []).map(prediction => ({ prediction, settled: settlePrediction({ stance: prediction.stance, marks: prediction.marks, bets: prediction.bets, result: input }) }));
      if (performances.some(({ settled }) => [settled.stakeYen, settled.refundYen, settled.payoutYen, settled.returnYen, ...settled.bets.flatMap(bet => [bet.stakeYen, bet.refundYen, bet.payoutYen, bet.returnYen])].some(value => value > 2_147_483_647))) throw new BadRequestException({ code: 'RESULT_AMOUNT_OVERFLOW', message: '払戻額が保存上限を超えています。入力内容を確認してください。' });
      const result = await tx.raceResultVersion.create({ data: { raceId, version: (latest?.version ?? 0) + 1, sourceRevision: revision, ruleVersion: resultRuleVersion, raceCanceled: input.raceCanceled, entriesSnapshot: input.entries, payoutsSnapshot: input.payouts, reason, confirmedBy: actor.id, performances: { create: performances.map(({ prediction, settled }) => ({ predictionVersionId: prediction.id, excluded: settled.excluded, hit: settled.hit, stakeYen: settled.stakeYen, refundYen: settled.refundYen, payoutYen: settled.payoutYen, returnYen: settled.returnYen, honmeiPosition: settled.honmeiPosition, betPerformances: { create: settled.bets.map(bet => ({ predictionBetId: bet.predictionBetId, hit: bet.hit, stakeYen: bet.stakeYen, refundYen: bet.refundYen, payoutYen: bet.payoutYen, returnYen: bet.returnYen, settlement: bet.settlement })) } })) } }, select: { id: true, version: true } });
      await tx.race.update({ where: { id: raceId }, data: { status: input.raceCanceled ? 'CANCELED' : 'FINISHED', revision: { increment: 1 } } });
      await this.auth.audit(tx, req, 'RACE_RESULT_CONFIRM', raceId, reason, { resultVersionId: result.id, version: result.version, sourceRevision: revision, ruleVersion: resultRuleVersion, predictionVersions: performances.length });
      return { versionId: result.id, version: result.version, alreadyConfirmed: false };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Get('races/:raceId/result')
  async publicResult(@Param('raceId') raceId: string) {
    z.string().uuid().parse(raceId);
    const value = await this.auth.db.raceResultVersion.findFirst({ where: { raceId }, orderBy: { version: 'desc' }, include: { race: { include: { entries: { select: { id: true, number: true, horseName: true } } } }, performances: { select: { id: true, excluded: true, hit: true, stakeYen: true, refundYen: true, payoutYen: true, returnYen: true, honmeiPosition: true, predictionVersion: { select: { version: true, confidence: true, stance: true, publishedAt: true } }, betPerformances: { select: { predictionBet: { select: { betType: true, combination: true } }, hit: true, stakeYen: true, refundYen: true, payoutYen: true, returnYen: true, settlement: true } } } } } });
    if (!value) return { confirmed: false };
    const entries = z.array(z.object({ entryId: z.string(), status: z.string(), finishPosition: z.number().nullable(), popularity: z.number().nullable(), finalOdds: z.string().nullable() })).parse(value.entriesSnapshot);
    const names = new Map(value.race.entries.map(entry => [entry.id, entry]));
    return { confirmed: true, version: value.version, ruleVersion: value.ruleVersion, raceCanceled: value.raceCanceled, confirmedAt: value.confirmedAt, entries: entries.map(entry => ({ ...entry, number: names.get(entry.entryId)?.number, horseName: names.get(entry.entryId)?.horseName })), performances: value.performances };
  }

  @Get('results/stats')
  async stats() {
    const versions = await this.auth.db.raceResultVersion.findMany({ orderBy: [{ raceId: 'asc' }, { version: 'desc' }], include: { race: { select: { venue: true, surface: true, raceDate: true } }, performances: { include: { predictionVersion: { select: { confidence: true } } } } } });
    const latestByRace = new Map<string, typeof versions[number]>();
    for (const value of versions) if (!latestByRace.has(value.raceId)) latestByRace.set(value.raceId, value);
    const latest = [...latestByRace.values()];
    const items = latest.flatMap(value => value.performances.map(performance => ({ ...performance, venue: value.race.venue, surface: value.race.surface, month: value.race.raceDate.slice(0, 7), confidence: performance.predictionVersion.confidence })));
    const groups = (key: 'venue' | 'surface' | 'month' | 'confidence') => {
      const grouped = new Map<string, typeof items>();
      for (const item of items) { const value = item[key] ?? '未設定'; grouped.set(value, [...(grouped.get(value) ?? []), item]); }
      return [...grouped].map(([value, rows]) => ({ value, ...aggregatePerformances(rows) }));
    };
    return { ruleVersion: resultRuleVersion, scope: '公開版別の参考集計', overall: aggregatePerformances(items), byConfidence: groups('confidence'), byVenue: groups('venue'), bySurface: groups('surface'), byMonth: groups('month') };
  }
}
