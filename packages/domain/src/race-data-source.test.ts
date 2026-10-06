import { describe, expect, it } from 'vitest';
import { manualEntryInputSchema, resolveRaceDataMode } from './race-data-source';

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
});
