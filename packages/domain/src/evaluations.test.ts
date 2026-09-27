import { describe, expect, it } from 'vitest';
import { aggregatePredictionEvaluations, aggregateWin5Evaluations, evaluatePrediction, evaluateWin5, evaluatedHorsesSchema, publicWin5PerformanceResponseSchema } from './evaluations';

const ids = Array.from({ length: 6 }, (_, index) => `${index + 1}1111111-1111-4111-8111-111111111111`);
const horses = [
  { entryId: ids[0], evaluationType: 'PRIMARY' as const, reason: '中心馬の理由', displayOrder: 1 },
  { entryId: ids[1], evaluationType: 'SECONDARY' as const, reason: '相手候補の理由', displayOrder: 1 },
  { entryId: ids[2], evaluationType: 'WATCH' as const, reason: '注目馬の理由', displayOrder: 1 },
  { entryId: ids[3], evaluationType: 'RISK' as const, reason: '危険馬の理由', displayOrder: 1 }
];

describe('horse evaluation domain', () => {
  it('accepts center, secondary, watch and risk horses as exclusive categories', () => {
    expect(evaluatedHorsesSchema.parse(horses)).toEqual(horses);
    expect(evaluatedHorsesSchema.safeParse([...horses, { ...horses[1], evaluationType: 'WATCH' }]).success).toBe(false);
    expect(evaluatedHorsesSchema.safeParse([...horses, { ...horses[0], entryId: ids[4] }]).success).toBe(false);
  });

  it.each([
    [1, 'PRIMARY_WIN', true, true, true],
    [2, 'PRIMARY_TOP2', false, true, true],
    [3, 'PRIMARY_TOP3', false, false, true],
    [4, 'WINNER_IN_RECOMMENDED', false, false, false]
  ] as const)('classifies a primary finishing %i', (position, status, first, top2, top3) => {
    const winnerId = position === 1 ? ids[0] : ids[1];
    const resultEntries = [{ entryId: ids[0], status: 'FINISHED' as const, finishPosition: position }];
    if (winnerId !== ids[0]) resultEntries.push({ entryId: winnerId, status: 'FINISHED', finishPosition: 1 });
    const value = evaluatePrediction({ confidence: 'A', horses, raceCanceled: false, resultEntries });
    expect(value).toMatchObject({ status, primaryFinishedFirst: first, primaryFinishedTop2: top2, primaryFinishedTop3: top3, winnerInRecommended: true });
  });

  it('keeps losing and skipped predictions in the evaluation population', () => {
    const missed = evaluatePrediction({ confidence: 'B', horses, raceCanceled: false, resultEntries: [
      { entryId: ids[0], status: 'FINISHED', finishPosition: 4 },
      { entryId: ids[5], status: 'FINISHED', finishPosition: 1 }
    ] });
    const skipped = evaluatePrediction({ confidence: 'SKIP', horses: [], raceCanceled: false, resultEntries: [] });
    expect(missed.status).toBe('WINNER_NOT_RECOMMENDED');
    expect(skipped.status).toBe('SKIPPED');
    expect(aggregatePredictionEvaluations([missed, skipped])).toMatchObject({ publishedRaces: 2, primaryWins: 0, skipped: 1, skipRatePercent: 50 });
  });

  it('classifies all five WIN5 winners by recommended candidates', () => {
    const all = evaluateWin5(Array.from({ length: 5 }, (_, index) => ({ legNumber: index + 1, status: 'PRIMARY_WIN' as const, winnerInRecommended: true })));
    const partial = evaluateWin5(Array.from({ length: 5 }, (_, index) => ({ legNumber: index + 1, status: index < 3 ? 'PRIMARY_WIN' as const : 'WINNER_NOT_RECOMMENDED' as const, winnerInRecommended: index < 3 })));
    expect(all).toEqual({ status: 'WIN5_ALL_WINNERS_RECOMMENDED', recommendedLegs: 5, allWinnersRecommended: true });
    expect(partial).toMatchObject({ status: 'WIN5_PARTIAL', recommendedLegs: 3 });
    expect(aggregateWin5Evaluations([{ ...all, legs: Array.from({ length: 5 }, () => ({ primaryFinishedFirst: true, primaryFinishedTop2: true, primaryFinishedTop3: true, winnerInRecommended: true })) }])).toMatchObject({ publications: 1, targetRaces: 5, winnersRecommended: 5, winnersRecommendedRatePercent: 100, allWinnersRecommended: 1 });
  });

  it('keeps the public WIN5 performance response strict and free of evaluation internals', () => {
    const empty = {
      ruleVersion: 'WIN5_HORSE_EVALUATION_V1',
      scope: '各WIN5公開の最新評価結果',
      overall: {
        publications: 0, targetRaces: 0, winnersRecommended: 0, winnersRecommendedRatePercent: null,
        allWinnersRecommended: 0, primaryWins: 0, primaryWinRatePercent: null,
        primaryTop2RatePercent: null, primaryTop3RatePercent: null
      }
    } as const;
    expect(publicWin5PerformanceResponseSchema.parse(empty)).toEqual(empty);
    expect(publicWin5PerformanceResponseSchema.safeParse({ ...empty, confirmedBy: ids[0] }).success).toBe(false);
    expect(publicWin5PerformanceResponseSchema.safeParse({ ...empty, overall: { ...empty.overall, horseName: '非公開馬' } }).success).toBe(false);
    expect(publicWin5PerformanceResponseSchema.safeParse({ ...empty, overall: { ...empty.overall, assumedPayout: 10000 } }).success).toBe(false);
  });
});
