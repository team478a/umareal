import { describe, expect, it } from 'vitest';
import { horseIdentityCorrectionInputSchema, horseIdentityDistinctBatchInputSchema, horseIdentityResolutionInputSchema, horseIdentityReviewQuerySchema, manualEntryBatchInputSchema, manualEntryInputSchema, parseQuickManualEntryList, raceOperationHistoryResponseSchema, resolveRaceDataMode } from './race-data-source';

describe('race data mode', () => {
  it('uses manual operation when no external provider is configured', () => {
    expect(resolveRaceDataMode()).toBe('MANUAL');
    expect(resolveRaceDataMode('CSV')).toBe('CSV');
  });

  it('rejects unknown modes and validates the minimal manual entry', () => {
    expect(() => resolveRaceDataMode('LIVE')).toThrow();
    expect(manualEntryInputSchema.parse({ number: 7, horseName: '手動登録馬' })).toEqual({ number: 7, horseName: '手動登録馬' });
    expect(manualEntryInputSchema.safeParse({ number: 7, horseName: '=IMPORT' }).success).toBe(false);
  });

  it('parses up to 18 manual entries without inventing identity data', () => {
    expect(parseQuickManualEntryList('1,一括登録馬A\n2\t一括登録馬B')).toEqual({ entries: [{ number: 1, horseName: '一括登録馬A' }, { number: 2, horseName: '一括登録馬B' }], errors: [] });
    expect(manualEntryBatchInputSchema.safeParse([{ number: 1, horseName: '一括登録馬A' }, { number: 1, horseName: '一括登録馬B' }]).success).toBe(false);
    expect(parseQuickManualEntryList('1,一括登録馬\n2,一括登録馬').errors).toContainEqual(expect.objectContaining({ row: 2, field: 'horseName' }));
    expect(parseQuickManualEntryList('1,=IMPORT').errors).toContainEqual(expect.objectContaining({ row: 1, field: 'horseName' }));
    expect(parseQuickManualEntryList(Array.from({ length: 19 }, (_, index) => `${index + 1},馬${index + 1}`).join('\n')).errors).toContainEqual(expect.objectContaining({ row: 19, field: 'number' }));
  });

  it('requires an explicit human decision, target horse and reason for identity resolution', () => {
    expect(horseIdentityResolutionInputSchema.parse({ decision: 'MATCH_EXISTING', resolvedHorseId: '10000000-0000-4000-8000-000000000001', reason: '同一馬と確認' })).toMatchObject({ decision: 'MATCH_EXISTING' });
    expect(horseIdentityResolutionInputSchema.safeParse({ decision: 'MATCH_EXISTING', resolvedHorseId: '10000000-0000-4000-8000-000000000001', reason: '' }).success).toBe(false);
    expect(horseIdentityResolutionInputSchema.safeParse({ decision: 'AUTO_MERGE', resolvedHorseId: '10000000-0000-4000-8000-000000000001', reason: '自動' }).success).toBe(false);
  });

  it('limits reviewed distinct-horse batches to one race and 18 unique identities', () => {
    const item = { id: '10000000-0000-4000-8000-000000000001', expectedHorseId: '10000000-0000-4000-8000-000000000002', expectedUpdatedAt: '2026-10-07T01:00:00.000Z' };
    const input = { raceId: '10000000-0000-4000-8000-000000000003', identities: [item], reason: '同名候補がないことを出馬表で確認' };
    expect(horseIdentityDistinctBatchInputSchema.parse(input)).toEqual(input);
    expect(horseIdentityDistinctBatchInputSchema.safeParse({ ...input, identities: [item, item] }).success).toBe(false);
    expect(horseIdentityDistinctBatchInputSchema.safeParse({ ...input, identities: [] }).success).toBe(false);
    expect(horseIdentityDistinctBatchInputSchema.safeParse({ ...input, identities: Array.from({ length: 19 }, (_, index) => ({ ...item, id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` })) }).success).toBe(false);
  });

  it('validates optional date and race filters for the identity review queue', () => {
    const raceId = '10000000-0000-4000-8000-000000000001';
    expect(horseIdentityReviewQuerySchema.parse({ date: '2026-10-07', raceId })).toMatchObject({ page: 1, limit: 20, date: '2026-10-07', raceId });
    expect(horseIdentityReviewQuerySchema.safeParse({ date: '2026/10/07' }).success).toBe(false);
    expect(horseIdentityReviewQuerySchema.safeParse({ raceId: 'not-a-uuid' }).success).toBe(false);
  });

  it('requires optimistic concurrency and a reason for identity correction', () => {
    const input = { resolvedHorseId: '10000000-0000-4000-8000-000000000001', expectedHorseId: '10000000-0000-4000-8000-000000000002', expectedUpdatedAt: '2026-10-06T08:00:00.000Z', reason: '確認内容の訂正' };
    expect(horseIdentityCorrectionInputSchema.parse(input)).toEqual(input);
    expect(horseIdentityCorrectionInputSchema.safeParse({ ...input, expectedUpdatedAt: 'not-a-date' }).success).toBe(false);
    expect(horseIdentityCorrectionInputSchema.safeParse({ ...input, reason: '' }).success).toBe(false);
  });

  it('keeps the operation source classification in the race history contract', () => {
    const row = { id: '10000000-0000-4000-8000-000000000001', action: 'RACE_CREATE', targetType: 'RACE', targetId: '10000000-0000-4000-8000-000000000002', reason: '手動登録', actorRole: 'ADMIN', actorDisplayName: '管理者', sourceType: 'MANUAL', createdAt: '2026-10-06T08:00:00.000Z', requestId: 'request-1' };
    expect(raceOperationHistoryResponseSchema.parse({ items: [row], total: 1, page: 1, limit: 20 }).items[0].sourceType).toBe('MANUAL');
    expect(raceOperationHistoryResponseSchema.safeParse({ items: [{ ...row, sourceType: 'SCRAPING' }], total: 1, page: 1, limit: 20 }).success).toBe(false);
  });
});
