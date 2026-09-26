import { describe, expect, it } from 'vitest';
import { adminNotificationListResponseSchema, adminNotificationTestOptionsResponseSchema, notificationIdempotencyKey, notificationListQuerySchema, notificationRetrySchema, notificationTestSendSchema, retryDelayMs } from './notifications';

describe('notification operations rules', () => {
  it('builds a recipient and version scoped idempotency key', () => {
    expect(notificationIdempotencyKey({ eventType: 'PREDICTION_PUBLISHED', targetId: 'race', recipientId: 'member', version: 2 })).toBe('LINE:PREDICTION_PUBLISHED:race:member:v2');
    expect(notificationIdempotencyKey({ eventType: 'RACE_ANNOUNCED', targetId: 'race', recipientId: 'member', version: 1, channel: 'EMAIL' })).toBe('EMAIL:RACE_ANNOUNCED:race:member:v1');
  });
  it('uses capped exponential retry delays', () => {
    expect([1, 2, 3].map(attempt => retryDelayMs(30, attempt))).toEqual([30_000, 60_000, 120_000]);
    expect(retryDelayMs(3600, 10)).toBe(86_400_000);
  });
  it('validates filters and requires a manual retry reason', () => {
    expect(notificationListQuerySchema.parse({ status: 'FAILED' })).toMatchObject({ page: 1, limit: 20, status: 'FAILED' });
    expect(notificationListQuerySchema.parse({ channel: 'EMAIL' })).toMatchObject({ page: 1, limit: 20, channel: 'EMAIL' });
    expect(notificationListQuerySchema.parse({ raceId: '11111111-1111-4111-8111-111111111111' })).toMatchObject({ raceId: '11111111-1111-4111-8111-111111111111' });
    expect(() => notificationListQuerySchema.parse({ status: 'UNKNOWN' })).toThrow();
    expect(() => notificationRetrySchema.parse({ reason: ' ' })).toThrow();
  });
  it('requires a frozen draft revision for free-content test sends', () => {
    const common = { raceId: '11111111-1111-4111-8111-111111111111', channel: 'EMAIL', reason: '公開前の文面確認' } as const;
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'RACE_ANNOUNCEMENT' })).toMatchObject({ contentType: 'RACE_ANNOUNCEMENT' });
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'FREE_REPORT_PRE_RACE', draftRevision: 2 })).toMatchObject({ draftRevision: 2 });
    expect(() => notificationTestSendSchema.parse({ ...common, contentType: 'FREE_REPORT_PRE_RACE' })).toThrow();
    expect(() => notificationTestSendSchema.parse({ ...common, contentType: 'RACE_ANNOUNCEMENT', draftRevision: 1 })).toThrow();
  });
  it('requires the target that belongs to each operational test type', () => {
    const common = { channel: 'EMAIL', reason: '公開前の文面確認' } as const;
    const id = '11111111-1111-4111-8111-111111111111';
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'RACE_PREDICTION', raceId: id })).toMatchObject({ raceId: id });
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'WIN5_PREDICTION', productId: id })).toMatchObject({ productId: id });
    expect(notificationTestSendSchema.parse({ ...common, contentType: 'BILLING_PAYMENT_FAILED', subscriptionId: id })).toMatchObject({ subscriptionId: id });
    expect(() => notificationTestSendSchema.parse({ ...common, contentType: 'WIN5_PREDICTION', raceId: id })).toThrow();
    expect(() => notificationTestSendSchema.parse({ ...common, contentType: 'BILLING_PAYMENT_FAILED', productId: id })).toThrow();
  });
  it('normalizes the admin list response and rejects fields outside the public contract', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const now = new Date('2026-09-27T00:00:00.000Z');
    const response = {
      items: [{
        id, status: 'FAILED' as const, channel: 'EMAIL' as const, attemptCount: 1, manualRetryCount: 0,
        nextAttemptAt: now, lastErrorCode: 'TEST_FAILURE', sentAt: null, createdAt: now, updatedAt: now,
        user: { id, displayName: '通知確認者', email: 'member@example.test' },
        event: {
          id, eventType: 'BILLING_PAYMENT_FAILED', status: 'FAILED', createdAt: now,
          version: null, announcement: null, freeReportVersion: null, productVersion: null,
          raceResultVersion: null, win5EvaluationVersion: null,
          billingEvent: { id, eventType: 'SUBSCRIPTION_PAYMENT_FAILED', subscription: { planCode: 'STANDARD' }, dayPass: null, billingCheckout: { planCode: 'STANDARD' } }
        },
        attempts: [{ id, attemptNumber: 1, outcome: 'PERMANENT_FAILURE', errorCode: 'TEST_FAILURE', startedAt: now, finishedAt: now }]
      }],
      total: 1, page: 1, limit: 20, channel: 'EMAIL' as const, raceId: null, counts: { FAILED: 1 },
      webhook: { lastReceivedAt: null, lastEventType: null, lastOutcome: null, received24h: 0, unmatched24h: 0, blockedAccounts: 0 },
      emailWebhook: {
        lastReceivedAt: now, lastEventType: 'email.failed', lastOutcome: 'MATCHED', received24h: 1, actionRequired24h: 1, blockedAccounts: 1,
        recent: [{ id, eventType: 'email.failed', occurredAt: now, receivedAt: now, recipientCount: 1, matchedCount: 1, disabledCount: 0, outcome: 'MATCHED' }],
        blockedMembers: [{ id, displayName: '通知確認者', email: 'member@example.test', emailDeliveryDisabledAt: now, emailDeliveryDisabledReason: 'BOUNCED' }]
      }
    };
    const parsed = adminNotificationListResponseSchema.parse(response);
    expect(parsed.items[0]?.createdAt).toBe(now.toISOString());
    expect(parsed.emailWebhook.recent[0]?.receivedAt).toBe(now.toISOString());
    expect(adminNotificationListResponseSchema.safeParse({ ...response, databaseUrl: 'postgres://secret' }).success).toBe(false);
    expect(adminNotificationListResponseSchema.safeParse({ ...response, items: [{ ...response.items[0], user: { ...response.items[0].user, authSubject: 'secret-subject' } }] }).success).toBe(false);
  });
  it('keeps administrator test options free of recipient addresses and provider identities', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const response = {
      channels: { email: true, line: false },
      races: [{ id, raceDate: '2026-09-27', venue: '中山', number: 11, name: 'テスト競走' }],
      products: [{ id, targetDate: '2026-09-27', title: 'WIN5紙面', status: 'DRAFT' }],
      subscriptions: [{ id, planCode: 'STANDARD', status: 'ACTIVE', currentPeriodEndsAt: new Date('2026-10-27T00:00:00.000Z'), user: { displayName: '表示名' } }]
    };
    const parsed = adminNotificationTestOptionsResponseSchema.parse(response);
    expect(parsed.subscriptions[0]?.currentPeriodEndsAt).toBe('2026-10-27T00:00:00.000Z');
    expect(adminNotificationTestOptionsResponseSchema.safeParse({ ...response, email: 'admin@example.test' }).success).toBe(false);
    expect(adminNotificationTestOptionsResponseSchema.safeParse({ ...response, subscriptions: [{ ...response.subscriptions[0], user: { displayName: '表示名', lineSubject: 'secret-subject' } }] }).success).toBe(false);
  });
});
