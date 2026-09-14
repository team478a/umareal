import { describe, expect, it } from 'vitest';
import { notificationIdempotencyKey, notificationListQuerySchema, notificationRetrySchema, retryDelayMs } from './notifications';

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
    expect(() => notificationListQuerySchema.parse({ status: 'UNKNOWN' })).toThrow();
    expect(() => notificationRetrySchema.parse({ reason: ' ' })).toThrow();
  });
});
