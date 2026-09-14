import { describe, expect, it } from 'vitest';
import { emptyPredictionDraft, predictionDraftSchema, publishablePredictionSchema, totalYenFor } from './predictions';
const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const complete = { ...emptyPredictionDraft, visibility: 'PAID' as const, confidence: 'A' as const, stance: 'NORMAL' as const, summary: '総評', marks: [{ entryId, mark: 'HONMEI' as const, reason: '軸候補' }], bets: [{ type: 'EXACTA' as const, combinations: [[1, 2], [1, 3]], amountPerPointYen: 500 }] };
describe('final prediction and reference bet validation', () => {
  it('keeps drafts partial and requires publication fields and one main pick', () => {
    expect(predictionDraftSchema.safeParse(emptyPredictionDraft).success).toBe(true);
    expect(publishablePredictionSchema.safeParse(emptyPredictionDraft).success).toBe(false);
    expect(publishablePredictionSchema.safeParse(complete).success).toBe(true);
    expect(publishablePredictionSchema.safeParse({ ...complete, marks: [] }).success).toBe(false);
  });
  it('allows a formal skip only without bets', () => {
    expect(publishablePredictionSchema.safeParse({ ...complete, stance: 'SKIP', marks: [], bets: [] }).success).toBe(true);
    expect(publishablePredictionSchema.safeParse({ ...complete, stance: 'SKIP' }).success).toBe(false);
  });
  it('validates ticket arity, unique horses and duplicate combinations', () => {
    expect(predictionDraftSchema.safeParse({ ...complete, bets: [{ ...complete.bets[0], combinations: [[1]] }] }).success).toBe(false);
    expect(predictionDraftSchema.safeParse({ ...complete, bets: [{ type: 'QUINELLA', combinations: [[1, 2], [2, 1]], amountPerPointYen: 100 }] }).success).toBe(false);
    expect(predictionDraftSchema.safeParse({ ...complete, bets: [{ type: 'TRIO', combinations: [[1, 1, 2]], amountPerPointYen: 100 }] }).success).toBe(false);
    expect(predictionDraftSchema.safeParse({ ...complete, marks: [complete.marks[0], { ...complete.marks[0], mark: 'TAIKO' }] }).success).toBe(false);
  });
  it('uses integer yen and calculates points and total from frozen combinations', () => {
    expect(totalYenFor(complete)).toBe(1000);
    expect(predictionDraftSchema.safeParse({ ...complete, bets: [{ ...complete.bets[0], amountPerPointYen: 550 }] }).success).toBe(false);
    expect(predictionDraftSchema.safeParse({ ...complete, bets: [{ ...complete.bets[0], amountPerPointYen: 1_000_000, combinations: Array.from({ length: 100 }, (_, i) => [1, i % 17 + 2]) }].flatMap(b => Array(30).fill(b)) }).success).toBe(false);
  });
});
