import { describe, expect, it } from 'vitest';
import { emptyPredictionDraft, legacyPredictionDraftSchema, predictionDraftSchema, publishablePredictionSchema, totalYenFor } from './predictions';

const entryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const current = { ...emptyPredictionDraft, visibility: 'PAID' as const, confidence: 'A' as const, summary: '展開と適性を評価', marks: [{ entryId, mark: 'HONMEI' as const, reason: '最終本命として評価' }] };
const legacy = { visibility: 'PAID' as const, confidence: 'A' as const, stance: 'NORMAL' as const, summary: '旧総評', marks: current.marks, bets: [{ type: 'EXACTA' as const, combinations: [[1, 2], [1, 3]], amountPerPointYen: 500 }] };

describe('current horse-evaluation prediction validation', () => {
  it('keeps drafts partial and requires final opinion and one main horse', () => {
    expect(predictionDraftSchema.safeParse(emptyPredictionDraft).success).toBe(true);
    expect(publishablePredictionSchema.safeParse(emptyPredictionDraft).success).toBe(false);
    expect(publishablePredictionSchema.safeParse(current).success).toBe(true);
    expect(publishablePredictionSchema.safeParse({ ...current, marks: [] }).success).toBe(false);
  });

  it('allows a formal skip only without horse evaluations', () => {
    expect(publishablePredictionSchema.safeParse({ ...current, confidence: 'SKIP', marks: [] }).success).toBe(true);
    expect(publishablePredictionSchema.safeParse({ ...current, confidence: 'SKIP' }).success).toBe(false);
  });

  it('rejects duplicate horses and requires every selected horse reason', () => {
    expect(predictionDraftSchema.safeParse({ ...current, marks: [current.marks[0], { ...current.marks[0], mark: 'TAIKO' }] }).success).toBe(false);
    expect(predictionDraftSchema.safeParse({ ...current, marks: [{ ...current.marks[0], reason: '' }] }).success).toBe(false);
  });
});

describe('dormant legacy betting validation', () => {
  it('keeps old snapshots verifiable without using them in the current schema', () => {
    expect(legacyPredictionDraftSchema.safeParse(legacy).success).toBe(true);
    expect(totalYenFor(legacy)).toBe(1000);
    expect(predictionDraftSchema.safeParse(legacy).success).toBe(false);
  });
});
