import { describe, expect, it } from 'vitest';
import { aggregatePerformances, raceResultInputSchema, settlePrediction } from './results';

const entry = (entryId: string, finishPosition: number) => ({ entryId, status: 'FINISHED' as const, finishPosition, popularity: finishPosition, finalOdds: '2.5' });
describe('result settlement', () => {
  it('settles hits, losses and explicit refunds from frozen bets', () => {
    const one = crypto.randomUUID(), two = crypto.randomUUID();
    const result = raceResultInputSchema.parse({ revision: 1, raceCanceled: false, reason: '公式結果を確認', entries: [entry(one, 1), entry(two, 2)], payouts: [
      { betType: 'EXACTA', combination: [1, 2], payoutPer100Yen: 640, refund: false }, { betType: 'WIN', combination: [2], payoutPer100Yen: 100, refund: true }
    ] });
    const settled = settlePrediction({ stance: 'BET', marks: [{ mark: 'HONMEI', entryId: one }], bets: [
      { id: crypto.randomUUID(), betType: 'EXACTA', combination: [[1, 2], [2, 1]], amountPerPointYen: 500, totalYen: 1000 },
      { id: crypto.randomUUID(), betType: 'WIN', combination: [[2]], amountPerPointYen: 300, totalYen: 300 }
    ], result });
    expect(settled).toMatchObject({ excluded: false, hit: true, stakeYen: 1300, payoutYen: 3200, refundYen: 300, returnYen: 3500, honmeiPosition: 1 });
  });
  it('excludes skips and canceled races from rates while retaining version counts', () => {
    expect(aggregatePerformances([{ excluded: false, hit: false, stakeYen: 1000, returnYen: 0, honmeiPosition: 4 }, { excluded: true, hit: false, stakeYen: 0, returnYen: 0, honmeiPosition: null }])).toMatchObject({ publishedVersions: 2, skippedOrCanceled: 1, eligiblePredictions: 1, hits: 0, hitRatePercent: 0, recoveryRatePercent: 0, honmeiPlaceRatePercent: 0 });
  });
});
