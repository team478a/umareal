import { describe, expect, it } from 'vitest';
import { adminOperationalAlertActionResponseSchema, adminOperationalAlertDeliveryRetryResponseSchema, adminOperationalAlertListResponseSchema, adminOperationalAlertSettingsResponseSchema } from './operational-alert';

const id = '11111111-1111-4111-8111-111111111111';
const staffId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-09-27T00:00:00.000Z');

function response() {
  return {
    items: [{
      id,
      dedupeKey: `DELIVERY_FAILED:${id}`,
      code: 'DELIVERY_FAILED',
      severity: 'WARNING',
      sourceType: 'NOTIFICATION_DELIVERY',
      sourceId: id,
      title: '会員通知の送信に失敗',
      summary: 'EMAILの公開通知が最終失敗になりました。',
      status: 'ACKNOWLEDGED',
      detectedAt: now,
      lastObservedAt: now,
      acknowledgedAt: now,
      acknowledgedBy: staffId,
      acknowledgeReason: '原因を調査中',
      resolvedAt: null,
      resolvedBy: null,
      resolutionReason: null,
      deliveries: [{ id, recipient: 'ops@example.test', status: 'FAILED', attemptCount: 3, lastErrorCode: 'TEST_FAILURE', sentAt: null, createdAt: now }]
    }],
    counts: { open: 0, acknowledged: 1, resolved: 0 }
  } as const;
}

describe('admin operational alert list contract', () => {
  it('normalizes the existing list response timestamps', () => {
    const parsed = adminOperationalAlertListResponseSchema.parse(response());
    expect(parsed.items[0]?.detectedAt).toBe(now.toISOString());
    expect(parsed.items[0]?.acknowledgedAt).toBe(now.toISOString());
    expect(parsed.items[0]?.deliveries[0]?.createdAt).toBe(now.toISOString());
  });

  it('rejects unknown states and internal delivery fields', () => {
    const value = response();
    expect(adminOperationalAlertListResponseSchema.safeParse({ ...value, items: [{ ...value.items[0], status: 'UNKNOWN' }] }).success).toBe(false);
    expect(adminOperationalAlertListResponseSchema.safeParse({ ...value, items: [{ ...value.items[0], deliveries: [{ ...value.items[0].deliveries[0], leaseToken: id }] }] }).success).toBe(false);
    expect(adminOperationalAlertListResponseSchema.safeParse({ ...value, items: [{ ...value.items[0], deliveries: [{ ...value.items[0].deliveries[0], providerMessageId: 'provider-secret' }] }] }).success).toBe(false);
    expect(adminOperationalAlertListResponseSchema.safeParse({ ...value, inquiryBody: '非公開本文' }).success).toBe(false);
  });
});

describe('admin operational alert settings response contract', () => {
  it('normalizes the existing response timestamp without changing settings', () => {
    expect(adminOperationalAlertSettingsResponseSchema.parse({ revision: 3, enabled: true, minimumSeverity: 'WARNING', destinationEmails: ['ops@example.test'], updatedAt: now })).toEqual({ revision: 3, enabled: true, minimumSeverity: 'WARNING', destinationEmails: ['ops@example.test'], updatedAt: now.toISOString() });
  });

  it('rejects internal ownership and credential fields', () => {
    const value = { revision: 3, enabled: true, minimumSeverity: 'CRITICAL', destinationEmails: ['ops@example.test'], updatedAt: now } as const;
    expect(adminOperationalAlertSettingsResponseSchema.safeParse({ ...value, updatedBy: staffId }).success).toBe(false);
    expect(adminOperationalAlertSettingsResponseSchema.safeParse({ ...value, mailApiKey: 'secret' }).success).toBe(false);
    expect(adminOperationalAlertSettingsResponseSchema.safeParse({ ...value, reason: '内部変更理由' }).success).toBe(false);
  });
});

describe('admin operational alert action response contracts', () => {
  it('normalizes acknowledgement and resolution timestamps without list-only deliveries', () => {
    const parsedList = adminOperationalAlertListResponseSchema.parse(response());
    const { deliveries, ...actionResponse } = parsedList.items[0]!;
    expect(deliveries).toHaveLength(1);
    expect(adminOperationalAlertActionResponseSchema.parse(actionResponse).acknowledgedAt).toBe(now.toISOString());
    expect(adminOperationalAlertActionResponseSchema.safeParse(parsedList.items[0]).success).toBe(false);
  });

  it('requires retry responses to release the lease and remain queued', () => {
    const value = { id, alertId: id, recipient: 'ops@example.test', status: 'QUEUED', attemptCount: 3, nextAttemptAt: now, lockedAt: null, leaseToken: null, lastErrorCode: 'TEST_FAILURE', providerMessageId: null, sentAt: null, createdAt: now, updatedAt: now } as const;
    const parsed = adminOperationalAlertDeliveryRetryResponseSchema.parse(value);
    expect(parsed).toMatchObject({ status: 'QUEUED', lockedAt: null, leaseToken: null });
    expect(adminOperationalAlertDeliveryRetryResponseSchema.safeParse({ ...value, status: 'SENDING', leaseToken: id }).success).toBe(false);
    expect(adminOperationalAlertDeliveryRetryResponseSchema.safeParse({ ...value, password: 'secret' }).success).toBe(false);
  });
});
