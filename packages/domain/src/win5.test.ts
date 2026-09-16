import { describe, expect, it } from 'vitest';
import { win5AssumedPurchaseAmount, win5CombinationCount, win5LegUpdateSchema } from './win5';

describe('WIN5 domain', () => {
  it('calculates cartesian combinations and the assumed purchase amount', () => {
    expect(win5CombinationCount([1, 2, 3, 2, 1])).toBe(12);
    expect(win5AssumedPurchaseAmount(12, 100)).toBe(1200);
  });

  it('requires five positive legs', () => {
    expect(() => win5CombinationCount([1, 2, 3, 4])).toThrow();
    expect(() => win5CombinationCount([1, 2, 0, 4, 5])).toThrow();
  });

  it('requires one center and exclusive evaluation categories', () => {
    const entry = '11111111-1111-4111-8111-111111111111';
    const other = '22222222-2222-4222-8222-222222222222';
    const base = { productRevision: 1, legNumber: 1, raceId: '33333333-3333-4333-8333-333333333333', confidence: 'A', paceView: '先行馬を重視', shortComment: '展開と適性を評価', reason: '入力試験' };
    const primary = { entryId: entry, evaluationType: 'PRIMARY', reason: '中心馬の理由', displayOrder: 1 };
    expect(win5LegUpdateSchema.safeParse({ ...base, evaluations: [primary] }).success).toBe(true);
    expect(win5LegUpdateSchema.safeParse({ ...base, evaluations: [primary, { ...primary, evaluationType: 'WATCH' }] }).success).toBe(false);
    expect(win5LegUpdateSchema.safeParse({ ...base, evaluations: [primary, { ...primary, entryId: other }] }).success).toBe(false);
  });
});
