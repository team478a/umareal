import { describe, expect, it } from 'vitest';
import { publicWin5ListResponseSchema, win5AssumedPurchaseAmount, win5CombinationCount, win5LegUpdateSchema } from './win5';

describe('WIN5 domain', () => {
  it('accepts the existing public WIN5 list response and normalizes dates', () => {
    const publishedAt = new Date('2026-09-27T01:00:00.000Z');
    const response = {
      items: [{
        id: '11111111-1111-4111-8111-111111111111', type: 'WIN5_PREVIEW', targetDate: '2026-09-27', title: 'WIN5紙面予想', status: 'PUBLISHED',
        scheduledPublishAt: new Date('2026-09-27T00:00:00.000Z'), publishedAt, confidence: 'A',
        races: [{ legNumber: 1, race: { id: '22222222-2222-4222-8222-222222222222', venue: '中山', number: 9, startsAt: new Date('2026-09-27T05:00:00.000Z'), status: 'SCHEDULED' } }],
        latestVersion: { id: '33333333-3333-4333-8333-333333333333', version: 1, status: 'PUBLISHED', publishedAt, previousVersionId: null }
      }],
      total: 1, page: 1, limit: 20
    };
    const parsed = publicWin5ListResponseSchema.parse(response);
    expect(parsed.items[0]?.publishedAt).toBe(publishedAt.toISOString());
    expect(parsed.items[0]?.races[0]?.race.startsAt).toBe('2026-09-27T05:00:00.000Z');
  });

  it('keeps unpublished confidence nullable and rejects private WIN5 data', () => {
    const product = {
      id: '11111111-1111-4111-8111-111111111111', type: 'WIN5_PREVIEW', targetDate: '2026-09-27', title: '公開予定', status: 'SCHEDULED',
      scheduledPublishAt: '2026-09-27T00:00:00.000Z', publishedAt: null, confidence: null, races: [], latestVersion: null
    };
    const response = { items: [product], total: 1, page: 1, limit: 20 };
    expect(publicWin5ListResponseSchema.safeParse(response).success).toBe(true);
    for (const privateField of [
      { expertId: '22222222-2222-4222-8222-222222222222' },
      { summary: '非公開の全体総評' },
      { contentSnapshot: { horseNumber: 6, reason: '非公開の選定理由' } }
    ]) {
      expect(publicWin5ListResponseSchema.safeParse({ ...response, items: [{ ...product, ...privateField }] }).success).toBe(false);
    }
  });

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
