import { describe, expect, it } from 'vitest';
import { publicWin5DetailResponseSchema, publicWin5ListResponseSchema, win5AssumedPurchaseAmount, win5CombinationCount, win5LegUpdateSchema } from './win5';

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

  it('keeps the metadata detail response free of paid WIN5 content', () => {
    const publishedAt = new Date('2026-09-27T01:00:00.000Z');
    const product = {
      id: '11111111-1111-4111-8111-111111111111', type: 'WIN5_PREVIEW', targetDate: '2026-09-27', title: 'WIN5紙面予想', status: 'PUBLISHED',
      scheduledPublishAt: new Date('2026-09-27T00:00:00.000Z'), publishedAt, confidence: 'A', races: [],
      latestVersion: { id: '22222222-2222-4222-8222-222222222222', version: 1, status: 'PUBLISHED', publishedAt, previousVersionId: null }
    };
    const version = { id: '22222222-2222-4222-8222-222222222222', version: 1, status: 'PUBLISHED', publishedAt, previousVersionId: null };
    const response = { access: 'METADATA', product, version: null, versions: [version], locked: true };
    const parsed = publicWin5DetailResponseSchema.parse(response);
    expect(parsed.access).toBe('METADATA');
    expect(parsed.product.publishedAt).toBe(publishedAt.toISOString());
    expect(publicWin5DetailResponseSchema.safeParse({ ...response, version: { contentSnapshot: { summary: '非公開本文' } } }).success).toBe(false);
    expect(publicWin5DetailResponseSchema.safeParse({ ...response, versions: [{ ...version, correctionReason: '非公開の訂正理由' }] }).success).toBe(false);
    expect(publicWin5DetailResponseSchema.safeParse({ ...response, product: { ...product, expertId: '33333333-3333-4333-8333-333333333333' } }).success).toBe(false);
  });

  it('accepts the paid WIN5 paper while rejecting dormant betting fields and secrets', () => {
    const publishedAt = new Date('2026-09-27T01:00:00.000Z');
    const deadlineAt = new Date('2026-09-27T05:00:00.000Z');
    const versionId = '22222222-2222-4222-8222-222222222222';
    const product = {
      id: '11111111-1111-4111-8111-111111111111', type: 'WIN5_PREVIEW', targetDate: '2026-09-27', title: 'WIN5紙面予想', status: 'PUBLISHED',
      scheduledPublishAt: '2026-09-27T00:00:00.000Z', publishedAt, confidence: null, races: [],
      latestVersion: { id: versionId, version: 1, status: 'PUBLISHED', publishedAt, previousVersionId: null }
    };
    const contentSnapshot = {
      product: { expertName: '担当者', confidence: 'A', summary: '全体総評' },
      races: [{
        legNumber: 1, confidence: 'A', paceView: '先行馬を重視', shortComment: '展開と適性を評価',
        race: { id: '44444444-4444-4444-8444-444444444444', raceDate: '2026-09-27', venue: '中山', number: 9, name: '第9競走', startsAt: deadlineAt, status: 'SCHEDULED' },
        evaluations: [{ entryId: '55555555-5555-4555-8555-555555555555', horseId: '66666666-6666-4666-8666-666666666666', number: 6, horseName: '試験馬', status: 'ACTIVE', evaluationType: 'PRIMARY', reason: '中心馬の理由', displayOrder: 1 }]
      }]
    };
    const version = { id: versionId, version: 1, status: 'PUBLISHED', publishedAt, previousVersionId: null, correctionReason: null, confidence: 'A', formatVersion: 'HORSE_EVALUATION_V1', contentSnapshot, deadlineAt };
    const response = { access: 'FULL', product, version, versions: [{ id: versionId, version: 1, status: 'PUBLISHED', publishedAt, previousVersionId: null, correctionReason: null }], locked: false };
    const parsed = publicWin5DetailResponseSchema.parse(response);
    expect(parsed.access).toBe('FULL');
    expect(parsed.version.deadlineAt).toBe(deadlineAt.toISOString());
    expect(publicWin5DetailResponseSchema.safeParse({ ...response, version: { ...version, combinationCount: 4 } }).success).toBe(false);
    expect(publicWin5DetailResponseSchema.safeParse({ ...response, version: { ...version, contentSnapshot: { ...contentSnapshot, assumedPurchaseAmountYen: 400 } } }).success).toBe(false);
    expect(publicWin5DetailResponseSchema.safeParse({ ...response, accessToken: 'secret' }).success).toBe(false);
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

  it('allows an official target race to be saved before the prediction is entered', () => {
    expect(win5LegUpdateSchema.safeParse({
      productRevision: 1,
      legNumber: 1,
      raceId: '33333333-3333-4333-8333-333333333333',
      confidence: 'C',
      paceView: '',
      shortComment: '',
      evaluations: [],
      reason: '公式WIN5対象レースの事前登録'
    }).success).toBe(true);
  });
});
