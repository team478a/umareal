import { describe, expect, it } from 'vitest';
import { canUseFreePredictionTrial } from './content-access';

describe('free prediction trial access', () => {
  const now = new Date('2026-10-10T03:00:00.000Z');

  it('allows only registered members to read WIN5 and paddock before the deadline', () => {
    const base = { now, registeredMember: true, enabled: true, endsAt: new Date('2026-10-12T15:00:00.000Z') };
    expect(canUseFreePredictionTrial({ ...base, contentKind: 'WIN5' })).toBe(true);
    expect(canUseFreePredictionTrial({ ...base, contentKind: 'PADDOCK' })).toBe(true);
    expect(canUseFreePredictionTrial({ ...base, contentKind: 'RACE_PAPER' })).toBe(false);
    expect(canUseFreePredictionTrial({ ...base, registeredMember: false, contentKind: 'WIN5' })).toBe(false);
  });

  it('fails closed when disabled, expired, or missing an end time', () => {
    const base = { now, registeredMember: true, contentKind: 'WIN5' as const };
    expect(canUseFreePredictionTrial({ ...base, enabled: false, endsAt: new Date('2026-10-12T15:00:00.000Z') })).toBe(false);
    expect(canUseFreePredictionTrial({ ...base, enabled: true, endsAt: now })).toBe(false);
    expect(canUseFreePredictionTrial({ ...base, enabled: true, endsAt: null })).toBe(false);
  });
});
