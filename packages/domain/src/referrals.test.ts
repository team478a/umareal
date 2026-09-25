import { describe, expect, it } from 'vitest';
import { adminReferralListQuerySchema, memberReferralCodeSchema, referralInvalidateSchema, referralRewardRedeemSchema, registrationSchema } from './index';

describe('referral input boundaries', () => {
  it('normalizes safe member referral codes without changing acquisition referral input', () => {
    expect(memberReferralCodeSchema.parse('ab12cd34ef')).toBe('AB12CD34EF');
    expect(memberReferralCodeSchema.safeParse('https://example.test/invite').success).toBe(false);
    const registration = registrationSchema.parse({ email: 'member@example.test', password: 'long-enough-password', displayName: '会員', adult: true, terms: true, privacy: true, termsVersion: 'draft-v1', privacyVersion: 'draft-v1', memberReferralCode: 'friend1234', acquisition: { source: 'lp', referralCode: 'marketing_01' } });
    expect(registration.memberReferralCode).toBe('FRIEND1234');
    expect(registration.acquisition?.referralCode).toBe('marketing_01');
  });

  it('validates redemption, admin filters and required invalidation reasons', () => {
    expect(referralRewardRedeemSchema.safeParse({ targetDate: '2099-03-04' }).success).toBe(true);
    expect(referralRewardRedeemSchema.safeParse({ targetDate: '2099/03/04' }).success).toBe(false);
    expect(adminReferralListQuerySchema.parse({})).toEqual({ page: 1, status: 'ALL' });
    expect(referralInvalidateSchema.safeParse({ reason: ' ' }).success).toBe(false);
  });
});
