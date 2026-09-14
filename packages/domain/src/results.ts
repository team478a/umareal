import { z } from 'zod';
import { betTypes } from './predictions';

export const resultRuleVersion = 'VERSION_AUDIT_V1';
export const runnerResultStatuses = ['FINISHED', 'WITHDRAWN', 'EXCLUDED', 'DNF', 'CANCELED'] as const;
const resultEntrySchema = z.object({ entryId: z.string().uuid(), status: z.enum(runnerResultStatuses), finishPosition: z.number().int().min(1).max(18).nullable(), popularity: z.number().int().min(1).max(18).nullable(), finalOdds: z.string().regex(/^\d{1,7}(\.\d)?$/).nullable() }).strict();
const payoutSchema = z.object({ betType: z.enum(betTypes), combination: z.array(z.number().int().min(1).max(18)).min(1).max(3), payoutPer100Yen: z.number().int().min(0).max(100_000_000), refund: z.boolean() }).strict();
export const raceResultInputSchema = z.object({ revision: z.number().int().min(0), raceCanceled: z.boolean(), entries: z.array(resultEntrySchema).max(18), payouts: z.array(payoutSchema).max(500), reason: z.string().trim().min(1).max(500) }).strict().superRefine((value, context) => {
  const entries = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (entries.has(entry.entryId)) context.addIssue({ code: 'custom', path: ['entries', index, 'entryId'], message: '同じ出走馬が重複しています。' });
    entries.add(entry.entryId);
    if (entry.status === 'FINISHED' && entry.finishPosition === null) context.addIssue({ code: 'custom', path: ['entries', index, 'finishPosition'], message: '完走馬には着順が必要です。' });
    if (entry.status !== 'FINISHED' && entry.finishPosition !== null) context.addIssue({ code: 'custom', path: ['entries', index, 'finishPosition'], message: '完走以外には着順を設定できません。' });
    if (value.raceCanceled && entry.status !== 'CANCELED') context.addIssue({ code: 'custom', path: ['entries', index, 'status'], message: 'レース中止時は全馬を中止にしてください。' });
    if (!value.raceCanceled && entry.status === 'CANCELED') context.addIssue({ code: 'custom', path: ['entries', index, 'status'], message: 'レース中止を有効にしてください。' });
  });
  const payouts = new Set<string>();
  value.payouts.forEach((payout, index) => {
    const arity = ['WIN', 'PLACE'].includes(payout.betType) ? 1 : ['QUINELLA', 'EXACTA', 'WIDE'].includes(payout.betType) ? 2 : 3;
    if (payout.combination.length !== arity || new Set(payout.combination).size !== payout.combination.length) context.addIssue({ code: 'custom', path: ['payouts', index, 'combination'], message: '券種と組合せを確認してください。' });
    if (payout.refund && payout.payoutPer100Yen !== 100) context.addIssue({ code: 'custom', path: ['payouts', index, 'payoutPer100Yen'], message: '返還は100円あたり100円で入力してください。' });
    if (!payout.refund && payout.payoutPer100Yen === 0) context.addIssue({ code: 'custom', path: ['payouts', index, 'payoutPer100Yen'], message: '払戻金は1円以上で入力してください。' });
    const key = payoutKey(payout.betType, payout.combination);
    if (payouts.has(key)) context.addIssue({ code: 'custom', path: ['payouts', index], message: '同じ払戻組合せが重複しています。' });
    payouts.add(key);
  });
  if (value.raceCanceled && value.payouts.length) context.addIssue({ code: 'custom', path: ['payouts'], message: 'レース中止時は払戻を個別入力しません。' });
});
export type RaceResultInput = z.infer<typeof raceResultInputSchema>;

export function payoutKey(type: string, combination: number[]) {
  const normalized = ['EXACTA', 'TRIFECTA'].includes(type) ? combination : [...combination].sort((a, b) => a - b);
  return `${type}:${normalized.join('-')}`;
}

export type SettlementBet = { id: string; betType: string; combination: unknown; amountPerPointYen: number; totalYen: number };
export function settlePrediction(input: { stance: string; marks: { mark: string; entryId: string }[]; bets: SettlementBet[]; result: RaceResultInput }) {
  const positions = new Map(input.result.entries.map(entry => [entry.entryId, entry.finishPosition]));
  const payoutMap = new Map(input.result.payouts.map(payout => [payoutKey(payout.betType, payout.combination), payout]));
  const excluded = input.result.raceCanceled || input.stance === 'SKIP';
  const bets = input.bets.map(bet => {
    const combinations = z.array(z.array(z.number().int())).parse(bet.combination);
    let refundYen = 0, payoutYen = 0, hit = false;
    const settlement = combinations.map(combination => {
      const payout = payoutMap.get(payoutKey(bet.betType, combination));
      const returned = payout ? Math.floor(bet.amountPerPointYen * payout.payoutPer100Yen / 100) : input.result.raceCanceled ? bet.amountPerPointYen : 0;
      const refund = input.result.raceCanceled || payout?.refund === true;
      if (refund) refundYen += returned; else { payoutYen += returned; if (returned > 0) hit = true; }
      return { combination, outcome: refund ? 'REFUND' : returned > 0 ? 'HIT' : 'LOSS', returnYen: returned };
    });
    return { predictionBetId: bet.id, hit, stakeYen: bet.totalYen, refundYen, payoutYen, returnYen: refundYen + payoutYen, settlement };
  });
  const honmei = input.marks.find(mark => mark.mark === 'HONMEI');
  return { excluded, hit: !excluded && bets.some(bet => bet.hit), stakeYen: bets.reduce((sum, bet) => sum + bet.stakeYen, 0), refundYen: bets.reduce((sum, bet) => sum + bet.refundYen, 0), payoutYen: bets.reduce((sum, bet) => sum + bet.payoutYen, 0), returnYen: bets.reduce((sum, bet) => sum + bet.returnYen, 0), honmeiPosition: honmei ? positions.get(honmei.entryId) ?? null : null, bets };
}

export function aggregatePerformances(items: { excluded: boolean; hit: boolean; stakeYen: number; returnYen: number; honmeiPosition: number | null }[]) {
  const eligible = items.filter(item => !item.excluded), betEligible = eligible.filter(item => item.stakeYen > 0), honmei = eligible.filter(item => item.honmeiPosition !== null);
  const stakeYen = betEligible.reduce((sum, item) => sum + item.stakeYen, 0), returnYen = betEligible.reduce((sum, item) => sum + item.returnYen, 0);
  const percent = (numerator: number, denominator: number) => denominator ? Math.round(numerator / denominator * 1000) / 10 : null;
  return { publishedVersions: items.length, skippedOrCanceled: items.length - eligible.length, eligiblePredictions: eligible.length, hits: eligible.filter(item => item.hit).length, hitRatePercent: percent(eligible.filter(item => item.hit).length, eligible.length), stakeYen, returnYen, recoveryRatePercent: percent(returnYen, stakeYen), honmeiCount: honmei.length, honmeiPlaceRatePercent: percent(honmei.filter(item => item.honmeiPosition! <= 3).length, honmei.length), honmeiQuinellaRatePercent: percent(honmei.filter(item => item.honmeiPosition! <= 2).length, honmei.length) };
}
