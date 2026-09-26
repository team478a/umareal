import { describe, expect, it } from 'vitest';
import { adminReferralListQuerySchema, lineOAuthStartSchema, memberReferralCodeSchema, memberReferralSummarySchema, referralInvalidateSchema, referralRewardRedeemSchema, registrationSchema } from './index';

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

  it('defines the strict public response contract for GET /me/referrals', () => {
    const grantedAt = new Date('2026-09-26T01:02:03.000Z');
    const response = {
      referralCode: 'AB12CD34EF',
      referralUrl: 'https://example.test/register?invite=AB12CD34EF',
      qualifiedCount: 3,
      nextMilestone: { requiredReferralCount: 10, remaining: 7, rewardType: 'DAY_PASS', rewardQuantity: 1 },
      milestones: [{ id: '11111111-1111-4111-8111-111111111111', requiredReferralCount: 3, rewardType: 'DAY_PASS', rewardQuantity: 1, achieved: true }],
      rewards: [{
        id: '22222222-2222-4222-8222-222222222222', rewardType: 'DAY_PASS', rewardQuantity: 1, status: 'REDEEMED',
        grantedAt, expiresAt: '2026-11-25T01:02:03.000Z', usedAt: '2026-09-27T00:00:00.000Z',
        milestone: { requiredReferralCount: 3 }, dayPass: { raceDate: '2026-09-27', status: 'ACTIVE' }
      }]
    };
    const parsed = memberReferralSummarySchema.parse(response);
    expect(parsed.rewards[0].grantedAt).toBe(grantedAt.toISOString());
    expect(parsed).toEqual({ ...response, rewards: [{ ...response.rewards[0], grantedAt: grantedAt.toISOString() }] });
    expect(memberReferralSummarySchema.safeParse({ ...response, email: 'member@example.test' }).success).toBe(false);
    expect(memberReferralSummarySchema.safeParse({ ...response, rewards: [{ ...response.rewards[0], userId: '33333333-3333-4333-8333-333333333333' }] }).success).toBe(false);
  });
});
