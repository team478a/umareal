import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbService } from './db.service';
import { MemberAccountQueryService } from './member-account-query.service';

const originalAuthProvider = process.env.AUTH_PROVIDER;
const id = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  process.env.AUTH_PROVIDER = originalAuthProvider;
});

function account(overrides: Record<string, unknown> = {}) {
  return {
    id,
    email: 'member@example.test',
    emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    passwordHash: 'stored-hash',
    authSubject: null,
    registrationMethod: 'EMAIL',
    displayName: '会員',
    role: 'MEMBER',
    mfaSecret: null,
    externalMfaFactorId: null,
    externalBackupMfaFactorId: null,
    emailDeliveryDisabledAt: null,
    emailDeliveryDisabledReason: null,
    preferences: null,
    lineAccount: null,
    entitlements: [{ planCode: 'STANDARD', startsAt: new Date('2026-09-01T00:00:00.000Z'), endsAt: new Date('2026-10-01T00:00:00.000Z'), raceDate: null }],
    consents: [{ documentType: 'TERMS', version: 'draft-v1', acceptedAt: new Date('2026-09-01T00:00:00.000Z') }],
    ...overrides,
  };
}

describe('MemberAccountQueryService', () => {
  it('returns the existing account response and limits the database selection', async () => {
    process.env.AUTH_PROVIDER = 'local';
    const findUniqueOrThrow = vi.fn().mockResolvedValue(account());
    const service = new MemberAccountQueryService({ user: { findUniqueOrThrow } } as unknown as DbService);

    const result = await service.current({ id, role: 'MEMBER', aal: 1 });

    expect(result).toMatchObject({
      id,
      email: 'member@example.test',
      emailVerified: true,
      hasPassword: true,
      role: 'MEMBER',
      aal: 1,
      mfaEnabled: false,
      mfaRequired: false,
      preferences: { emailEnabled: true, predictions: true, changes: true, articles: false, billing: true },
      lineLinked: false,
      lineNotificationState: 'NOT_LINKED',
      lineNotificationReady: false,
      emailNotificationState: 'READY',
      emailNotificationReady: true,
    });
    expect(result.entitlements[0]).toEqual({ planCode: 'STANDARD', startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z', raceDate: null });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id },
      select: expect.objectContaining({
        id: true,
        passwordHash: true,
        authSubject: true,
        preferences: { select: { emailEnabled: true, predictions: true, changes: true, articles: true, billing: true } },
        entitlements: expect.objectContaining({
          where: { revokedAt: null, endsAt: { gt: expect.any(Date) } },
          select: { planCode: true, startsAt: true, endsAt: true, raceDate: true },
        }),
      }),
    });
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('authSubject');
  });

  it('preserves blocked and disabled notification state precedence', async () => {
    process.env.AUTH_PROVIDER = 'local';
    const blockedAt = new Date('2026-09-02T00:00:00.000Z');
    const service = new MemberAccountQueryService({ user: { findUniqueOrThrow: vi.fn().mockResolvedValue(account({
      emailDeliveryDisabledAt: blockedAt,
      emailDeliveryDisabledReason: 'BOUNCED',
      preferences: { emailEnabled: false, predictions: false, changes: true, articles: false, billing: true },
      lineAccount: { unlinkedAt: null, notificationDisabledAt: blockedAt },
    })) } } as unknown as DbService);

    const result = await service.current({ id, role: 'MEMBER', aal: 1 });

    expect(result).toMatchObject({
      lineLinked: true,
      lineNotificationState: 'BLOCKED',
      lineNotificationReady: false,
      emailNotificationState: 'BLOCKED',
      emailNotificationReady: false,
      emailDeliveryDisabledAt: blockedAt.toISOString(),
      emailDeliveryDisabledReason: 'BOUNCED',
    });
  });

  it('preserves Supabase password and administrator MFA projections', async () => {
    process.env.AUTH_PROVIDER = 'supabase';
    const service = new MemberAccountQueryService({ user: { findUniqueOrThrow: vi.fn().mockResolvedValue(account({
      email: null,
      emailVerifiedAt: null,
      passwordHash: null,
      authSubject: 'provider-subject',
      registrationMethod: 'LINE',
      role: 'ADMIN',
      externalMfaFactorId: 'primary-factor',
      externalBackupMfaFactorId: 'backup-factor',
    })) } } as unknown as DbService);

    const result = await service.current({ id, role: 'ADMIN', aal: 2 });

    expect(result).toMatchObject({
      email: null,
      emailVerified: false,
      hasPassword: true,
      role: 'ADMIN',
      aal: 2,
      mfaEnabled: true,
      mfaRequired: true,
      mfaBackupEnabled: true,
      mfaBackupSupported: true,
      emailNotificationState: 'UNVERIFIED',
    });
  });
});
