import { describe, expect, it } from 'vitest';
import { notificationIdempotencyKey, notificationListQuerySchema, notificationRetrySchema, notificationTestSendSchema, retryDelayMs } from './notifications';

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
});
