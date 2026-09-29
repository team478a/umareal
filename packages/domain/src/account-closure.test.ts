import { describe, expect, it } from 'vitest';
import { accountClosureCompletionResponseSchema, accountClosureEligibilityResponseSchema, adminAccountClosuresResponseSchema } from './account-closure';

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

describe('account closure completion response contract', () => {
  const completed = {
    closedAt: new Date('2026-09-29T00:00:00.000Z'),
    alreadyClosed: false,
    retainedHistory: true as const
  };

  it('preserves the existing public response and normalizes the closure timestamp', () => {
    expect(accountClosureCompletionResponseSchema.parse(completed)).toEqual({
      closedAt: '2026-09-29T00:00:00.000Z',
      alreadyClosed: false,
      retainedHistory: true
    });
  });

  it('rejects closure, user and audit identifiers', () => {
    expect(accountClosureCompletionResponseSchema.safeParse({ ...completed, closureId: 'internal-closure' }).success).toBe(false);
    expect(accountClosureCompletionResponseSchema.safeParse({ ...completed, userId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(accountClosureCompletionResponseSchema.safeParse({ ...completed, auditLogId: 'internal-audit' }).success).toBe(false);
  });
});

describe('administrator account closures response contract', () => {
  const list = {
    items: [{
      id: '11111111-1111-4111-8111-111111111111',
      reasonCode: 'PRICE' as const,
      requestedAt: new Date('2026-09-29T01:00:00.000Z'),
      accessRevokedAt: new Date('2026-09-29T01:00:01.000Z'),
      retentionPolicyVersion: 'development-v1',
      status: 'CLOSED' as const,
      user: {
        id: '22222222-2222-4222-8222-222222222222',
        displayName: '退会済み会員',
        email: 'closed@example.test',
        registrationMethod: 'EMAIL',
        disabledAt: new Date('2026-09-29T01:00:01.000Z')
      }
    }],
    total: 1,
    page: 1,
    limit: 20
  };

  it('preserves the existing paginated administration response', () => {
    const parsed = adminAccountClosuresResponseSchema.parse(list);
    expect(parsed.items[0].requestedAt).toBe('2026-09-29T01:00:00.000Z');
    expect(parsed.items[0].user.disabledAt).toBe('2026-09-29T01:00:01.000Z');
  });

  it('rejects authentication, audit and unselected database fields', () => {
    expect(adminAccountClosuresResponseSchema.safeParse({
      ...list,
      items: [{ ...list.items[0], userId: list.items[0].user.id }]
    }).success).toBe(false);
    expect(adminAccountClosuresResponseSchema.safeParse({
      ...list,
      items: [{ ...list.items[0], user: { ...list.items[0].user, passwordHash: 'secret' } }]
    }).success).toBe(false);
    expect(adminAccountClosuresResponseSchema.safeParse({ ...list, auditLog: [] }).success).toBe(false);
  });
});
