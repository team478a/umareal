import { describe, expect, it } from 'vitest';
import { horseIdentityResolutionInputSchema, manualEntryInputSchema, resolveRaceDataMode } from './race-data-source';

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
});
