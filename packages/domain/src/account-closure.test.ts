import { describe, expect, it } from 'vitest';
import { accountClosureEligibilityResponseSchema } from './account-closure';

const response = {
  eligible: false,
  passwordRequired: true,
  blockers: [{
    code: 'ACTIVE_SUBSCRIPTION' as const,
    message: '有効な月額契約を先に解約予約してください。',
    href: '/account',
    endsAt: new Date('2026-10-31T15:00:00.000Z')
  }],
  retentionPolicyVersion: 'development-v1',
  retained: ['支払・契約履歴', '同意履歴']
};

describe('account closure eligibility response contract', () => {
  it('preserves the existing public response and normalizes blocker timestamps', () => {
    const parsed = accountClosureEligibilityResponseSchema.parse(response);
    expect(parsed.blockers[0].endsAt).toBe('2026-10-31T15:00:00.000Z');
  });

  it('rejects billing identifiers and private authentication data', () => {
    expect(accountClosureEligibilityResponseSchema.safeParse({ ...response, userId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(accountClosureEligibilityResponseSchema.safeParse({
      ...response,
      blockers: [{ ...response.blockers[0], subscriptionId: 'internal-subscription' }]
    }).success).toBe(false);
    expect(accountClosureEligibilityResponseSchema.safeParse({ ...response, passwordHash: 'secret' }).success).toBe(false);
  });
});
