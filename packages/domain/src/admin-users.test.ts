import { describe, expect, it } from 'vitest';
import { adminUsersResponseSchema } from './admin-users';

describe('administrator user list response contract', () => {
  const response = {
    items: [{
      id: '11111111-1111-4111-8111-111111111111',
      email: 'member@example.test',
      emailVerifiedAt: new Date('2026-09-29T01:00:00.000Z'),
      registrationMethod: 'EMAIL',
      lineAccount: { unlinkedAt: null },
      displayName: '会員',
      role: 'MEMBER' as const,
      createdAt: new Date('2026-09-29T00:00:00.000Z')
    }],
    total: 1,
    page: 1,
    limit: 20
  };

  it('preserves the existing paginated administration response', () => {
    const parsed = adminUsersResponseSchema.parse(response);
    expect(parsed.items[0].emailVerifiedAt).toBe('2026-09-29T01:00:00.000Z');
    expect(parsed.items[0].createdAt).toBe('2026-09-29T00:00:00.000Z');
  });

  it('rejects authentication, referral, billing and audit fields', () => {
    for (const privateField of ['passwordHash', 'authSubject', 'mfaSecretEncrypted', 'referralCode', 'stripeCustomerId']) {
      expect(adminUsersResponseSchema.safeParse({
        ...response,
        items: [{ ...response.items[0], [privateField]: 'private' }]
      }).success).toBe(false);
    }
    expect(adminUsersResponseSchema.safeParse({ ...response, auditLogs: [] }).success).toBe(false);
  });
});
