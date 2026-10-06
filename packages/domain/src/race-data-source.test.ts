import { describe, expect, it } from 'vitest';
import { horseIdentityCorrectionInputSchema, horseIdentityResolutionInputSchema, manualEntryInputSchema, raceOperationHistoryResponseSchema, resolveRaceDataMode } from './race-data-source';

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

  it('requires an explicit human decision, target horse and reason for identity resolution', () => {
    expect(horseIdentityResolutionInputSchema.parse({ decision: 'MATCH_EXISTING', resolvedHorseId: '10000000-0000-4000-8000-000000000001', reason: '同一馬と確認' })).toMatchObject({ decision: 'MATCH_EXISTING' });
    expect(horseIdentityResolutionInputSchema.safeParse({ decision: 'MATCH_EXISTING', resolvedHorseId: '10000000-0000-4000-8000-000000000001', reason: '' }).success).toBe(false);
    expect(horseIdentityResolutionInputSchema.safeParse({ decision: 'AUTO_MERGE', resolvedHorseId: '10000000-0000-4000-8000-000000000001', reason: '自動' }).success).toBe(false);
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
