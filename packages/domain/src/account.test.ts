import { describe, expect, it } from 'vitest';
import { currentAccountResponseSchema } from './account';

const id = '11111111-1111-4111-8111-111111111111';

function account() {
  return {
    id,
    email: 'member@example.test',
    emailVerified: true,
    hasPassword: true,
    registrationMethod: 'EMAIL',
    displayName: '会員',
    role: 'MEMBER' as const,
    aal: 1 as const,
    mfaEnabled: false,
    mfaRequired: false,
    mfaBackupEnabled: false,
    mfaBackupSupported: false,
    preferences: { emailEnabled: true, predictions: true, changes: true, articles: false, billing: true },
    lineLinked: false,
    lineNotificationState: 'NOT_LINKED' as const,
    lineNotificationReady: false,
    emailNotificationState: 'READY' as const,
    emailNotificationReady: true,
    emailDeliveryDisabledAt: null,
    emailDeliveryDisabledReason: null,
    entitlements: [{ planCode: 'STANDARD', startsAt: new Date('2026-09-01T00:00:00.000Z'), endsAt: new Date('2026-10-01T00:00:00.000Z'), raceDate: null }],
    consents: [{ documentType: 'TERMS', version: 'draft-v1', acceptedAt: new Date('2026-09-01T00:00:00.000Z') }]
  };
}

describe('current account response contract', () => {
  it('serializes database dates into the existing public JSON shape', () => {
    const parsed = currentAccountResponseSchema.parse(account());
    expect(parsed.entitlements[0].startsAt).toBe('2026-09-01T00:00:00.000Z');
    expect(parsed.consents[0].acceptedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rejects database-only authentication fields', () => {
    expect(() => currentAccountResponseSchema.parse({ ...account(), passwordHash: 'secret' })).toThrow();
    expect(() => currentAccountResponseSchema.parse({ ...account(), authSubject: 'provider-subject' })).toThrow();
  });
});
