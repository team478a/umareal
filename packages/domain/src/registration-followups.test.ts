import { describe, expect, it } from 'vitest';
import { adminRegistrationFollowupsResponseSchema } from './registration-followups';

describe('registration follow-up API contract', () => {
  it('keeps the existing response fields and normalizes timestamps', () => {
    const createdAt = new Date('2026-09-27T01:02:03.000Z');
    const expiresAt = new Date('2026-09-28T01:02:03.000Z');
    const generatedAt = new Date('2026-09-27T02:03:04.000Z');
    const value = adminRegistrationFollowupsResponseSchema.parse({
      items: [{
        id: '10000000-0000-4000-8000-000000000001',
        displayName: '田中',
        email: 'member@example.test',
        createdAt,
        status: 'OVERDUE',
        lastVerification: { createdAt, expiresAt, usedAt: null },
        canResend: true,
        resendAvailableAt: createdAt
      }],
      total: 1,
      page: 1,
      limit: 20,
      status: 'OVERDUE',
      counts: { pending: 1, recent: 0, overdue: 1 },
      resendMode: 'ADMIN_DIRECT',
      selfServicePath: '/verify-email',
      generatedAt
    });

    expect(value.items[0]?.createdAt).toBe(createdAt.toISOString());
    expect(value.items[0]?.lastVerification?.expiresAt).toBe(expiresAt.toISOString());
    expect(value.generatedAt).toBe(generatedAt.toISOString());
  });

  it('rejects authentication secrets and unrelated account fields', () => {
    const response = {
      items: [{
        id: '10000000-0000-4000-8000-000000000001',
        displayName: '田中',
        email: 'member@example.test',
        createdAt: '2026-09-27T01:02:03.000Z',
        status: 'RECENT',
        lastVerification: null,
        canResend: false,
        resendAvailableAt: null
      }],
      total: 1,
      page: 1,
      limit: 20,
      status: 'ALL',
      counts: { pending: 1, recent: 1, overdue: 0 },
      resendMode: 'MEMBER_SELF_SERVICE',
      selfServicePath: '/verify-email',
      generatedAt: '2026-09-27T02:03:04.000Z'
    };

    expect(adminRegistrationFollowupsResponseSchema.safeParse({ ...response, token: 'secret' }).success).toBe(false);
    expect(adminRegistrationFollowupsResponseSchema.safeParse({
      ...response,
      items: [{ ...response.items[0], passwordHash: 'secret' }]
    }).success).toBe(false);
  });
});
