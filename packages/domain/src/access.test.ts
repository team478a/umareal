import { describe, expect, it } from 'vitest';
import { canEditRace, canManage, canReadPrediction, dayPassWindow, defaultContentAccessPolicy, parseContentAccessPolicy, registrationSchema } from './index';
describe('authorization boundaries', () => {
  it('rejects expert without MFA and unassigned expert', () => {
    expect(canEditRace({ id: 'a', role: 'EXPERT', aal: 1 }, ['a'])).toBe(false);
    expect(canEditRace({ id: 'a', role: 'EXPERT', aal: 2 }, ['b'])).toBe(false);
    expect(canEditRace({ id: 'a', role: 'EXPERT', aal: 2 }, ['a'])).toBe(true);
    expect(canManage({ id: 'a', role: 'MEMBER', aal: 2 }, ['ADMIN'])).toBe(false);
  });
  it('allows a race operator to edit every race only after MFA', () => {
    expect(canEditRace({ id: 'operator', role: 'OPERATOR', aal: 1 }, [])).toBe(false);
    expect(canEditRace({ id: 'operator', role: 'OPERATOR', aal: 2 }, [])).toBe(true);
    expect(canEditRace({ id: 'operator', role: 'OPERATOR', aal: 2 }, ['another-user'])).toBe(true);
  });
  it('requires consent and rejects caller-supplied roles', () => {
    const valid = { email: 'A@example.com', password: 'long-password-123', displayName: '会員', adult: true, terms: true, privacy: true, termsVersion: '2026-10-01-v1', privacyVersion: '2026-10-01-v1' };
    expect(registrationSchema.parse(valid).email).toBe('a@example.com');
    expect(registrationSchema.parse({ ...valid, captchaToken: 'verified-token' }).captchaToken).toBe('verified-token');
    expect(registrationSchema.safeParse({ ...valid, captchaToken: 'x'.repeat(2049) }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...valid, adult: false }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...valid, role: 'ADMIN' }).success).toBe(false);
  });
  it('uses inclusive start and exclusive end for JST day passes', () => {
    const window = dayPassWindow('2026-09-12');
    expect(window.startsAt.toISOString()).toBe('2026-09-11T15:00:00.000Z');
    const base = { publishedAt: window.startsAt, visibility: 'PAID' as const, raceDate: '2026-09-12', entitlements: [{ ...window, revokedAt: null, raceDate: '2026-09-12' }] };
    expect(canReadPrediction({ ...base, now: window.startsAt })).toBe(true);
    expect(canReadPrediction({ ...base, now: window.endsAt })).toBe(false);
    expect(canReadPrediction({ ...base, now: window.startsAt, raceDate: '2026-09-13' })).toBe(false);
    expect(canReadPrediction({ ...base, now: window.startsAt, entitlements: [] })).toBe(false);
    expect(canReadPrediction({ ...base, now: window.startsAt, publishedAt: window.endsAt })).toBe(false);
    expect(canReadPrediction({ ...base, now: window.startsAt, entitlements: [{ ...base.entitlements[0], revokedAt: window.startsAt }] })).toBe(false);
    expect(() => dayPassWindow('2026-02-30')).toThrow();
  });
  it('applies the configured paid content matrix without changing time and date checks', () => {
    const window = dayPassWindow('2026-09-12');
    const policy = { ...defaultContentAccessPolicy, dayPass: { paddock: true, win5: false, racePaper: false, content: false, aiRaceGuide: true } };
    const base = { now: window.startsAt, publishedAt: window.startsAt, visibility: 'PAID' as const, raceDate: '2026-09-12', entitlements: [{ ...window, planCode: 'DAY_PASS', revokedAt: null, raceDate: '2026-09-12' }], contentAccessPolicy: policy };
    expect(canReadPrediction({ ...base, contentKind: 'PADDOCK' })).toBe(true);
    expect(canReadPrediction({ ...base, contentKind: 'WIN5' })).toBe(false);
    expect(canReadPrediction({ ...base, contentKind: 'RACE_PAPER' })).toBe(false);
    expect(canReadPrediction({ ...base, contentKind: 'CONTENT' })).toBe(false);
    expect(canReadPrediction({ ...base, contentKind: 'AI_RACE_GUIDE' })).toBe(true);
    expect(canReadPrediction({ ...base, entitlements: [{ ...base.entitlements[0], planCode: 'STANDARD', raceDate: null }], contentKind: 'WIN5' })).toBe(true);
    expect(canReadPrediction({ ...base, entitlements: [{ ...base.entitlements[0], planCode: 'UNKNOWN' }], contentKind: 'PADDOCK' })).toBe(false);
    expect(parseContentAccessPolicy({}).dayPass.win5).toBe(false);
  });
});
