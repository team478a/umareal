import { describe, expect, it } from 'vitest';
import { adminReferralListQuerySchema, lineOAuthStartSchema, memberReferralCodeSchema, referralInvalidateSchema, referralRewardRedeemSchema, registrationSchema } from './index';

describe('referral input boundaries', () => {
  it('normalizes safe member referral codes without changing acquisition referral input', () => {
    expect(memberReferralCodeSchema.parse('ab12cd34ef')).toBe('AB12CD34EF');
    expect(memberReferralCodeSchema.safeParse('https://example.test/invite').success).toBe(false);
    const registration = registrationSchema.parse({ email: 'member@example.test', password: 'long-enough-password', displayName: '会員', adult: true, terms: true, privacy: true, termsVersion: 'draft-v1', privacyVersion: 'draft-v1', memberReferralCode: 'friend1234', acquisition: { source: 'lp', referralCode: 'marketing_01' } });
    expect(registration.memberReferralCode).toBe('FRIEND1234');
    expect(registration.acquisition?.referralCode).toBe('marketing_01');
  });

  it('treats malformed invite context as ordinary registration', () => {
    const base = { email: 'ordinary@example.test', password: 'long-enough-password', displayName: '会員', adult: true as const, terms: true as const, privacy: true as const, termsVersion: 'draft-v1' as const, privacyVersion: 'draft-v1' as const };
    expect(registrationSchema.parse({ ...base, memberReferralCode: 'tampered code!' }).memberReferralCode).toBeUndefined();
    expect(lineOAuthStartSchema.parse({ purpose: 'REGISTER', memberReferralCode: 'not/a/code' }).memberReferralCode).toBeUndefined();
    expect(registrationSchema.safeParse({ ...base, memberReferralCode: 'x'.repeat(257) }).success).toBe(false);
  });

  it('validates redemption, admin filters and required invalidation reasons', () => {
    expect(referralRewardRedeemSchema.safeParse({ targetDate: '2099-03-04' }).success).toBe(true);
    expect(referralRewardRedeemSchema.safeParse({ targetDate: '2099/03/04' }).success).toBe(false);
    expect(adminReferralListQuerySchema.parse({})).toEqual({ page: 1, status: 'ALL' });
    expect(referralInvalidateSchema.safeParse({ reason: ' ' }).success).toBe(false);
  });
});
