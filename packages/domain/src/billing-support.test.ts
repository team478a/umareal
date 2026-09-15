import { describe, expect, it } from 'vitest';
import { billingSupportEventType, billingSupportRequestSchema, billingSupportStatusSchema } from './billing-support';

describe('billing support', () => {
  it('requires a payment for refund and receipt requests', () => {
    expect(billingSupportRequestSchema.safeParse({ category: 'REFUND', message: '決済内容を確認して返金を相談したいです。' }).success).toBe(false);
    expect(billingSupportRequestSchema.safeParse({ category: 'RECEIPT', paymentTransactionId: 'e06ec166-69c9-4119-bdd4-0fe2b4cf6228', message: 'この支払いの領収書について確認したいです。' }).success).toBe(true);
  });

  it('accepts policy-neutral support categories without a payment', () => {
    expect(billingSupportRequestSchema.parse({ category: 'CANCELLATION', message: '解約予約の状態を確認したいです。' }).paymentTransactionId).toBeUndefined();
    expect(() => billingSupportStatusSchema.parse({ status: 'RESOLVED', reason: '会員へ確認内容を案内済み' })).not.toThrow();
  });

  it('allows only explicit support workflow transitions', () => {
    expect(billingSupportEventType('OPEN', 'IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(billingSupportEventType('IN_PROGRESS', 'RESOLVED')).toBe('RESOLVED');
    expect(billingSupportEventType('RESOLVED', 'OPEN')).toBe('REOPENED');
    expect(billingSupportEventType('IN_PROGRESS', 'OPEN')).toBeNull();
    expect(billingSupportEventType('OPEN', 'OPEN')).toBeNull();
  });
});
