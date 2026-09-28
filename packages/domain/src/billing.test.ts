import { describe, expect, it } from 'vitest';
import { addCalendarMonthUtc, adminBillingResponseSchema, billingCouponCreateSchema, billingPlansResponseSchema, billingReviewResolutionSchema, dayPassCheckoutSchema, dayPassCheckoutWithCouponSchema, dayPassWindow, memberBillingResponseSchema } from './index';

describe('billing periods', () => {
  it('uses an exclusive JST day-pass boundary', () => {
    const window = dayPassWindow('2027-01-02');
    expect(window.startsAt.toISOString()).toBe('2027-01-01T15:00:00.000Z');
    expect(window.endsAt.toISOString()).toBe('2027-01-02T15:00:00.000Z');
    expect(dayPassCheckoutSchema.safeParse({ raceDate: '2027-02-30' }).success).toBe(false);
    expect(dayPassCheckoutWithCouponSchema.parse({ raceDate: '2027-02-07', couponCode: 'save_10' })).toEqual({ raceDate: '2027-02-07', couponCode: 'SAVE_10' });
    expect(dayPassCheckoutWithCouponSchema.safeParse({ raceDate: '2027-02-30', couponCode: 'SAVE_10' }).success).toBe(false);
  });
  it('validates coupon definitions without exposing arbitrary plan codes', () => {
    const input = { code: 'WELCOME10', name: '初回割引', discountType: 'PERCENT' as const, discountValue: 10, duration: 'ONCE' as const, applicablePlanCodes: ['STANDARD' as const, 'STANDARD' as const], startsAt: '2027-01-01T00:00:00.000Z', endsAt: '2027-02-01T00:00:00.000Z', maxRedemptions: 100, reason: '初回登録キャンペーン' };
    expect(billingCouponCreateSchema.parse(input).applicablePlanCodes).toEqual(['STANDARD']);
    expect(billingCouponCreateSchema.safeParse({ ...input, discountValue: 101 }).success).toBe(false);
    expect(billingCouponCreateSchema.safeParse({ ...input, applicablePlanCodes: ['INTERNAL'] }).success).toBe(false);
  });
  it('clamps the local simulation calendar month', () => {
    expect(addCalendarMonthUtc(new Date('2027-01-31T05:00:00Z')).toISOString()).toBe('2027-02-28T05:00:00.000Z');
  });
  it('requires an explicit review action and operational reason', () => {
    expect(billingReviewResolutionSchema.parse({ action: 'REFUND', reason: '重複契約を確認したため' })).toEqual({ action: 'REFUND', reason: '重複契約を確認したため' });
    expect(billingReviewResolutionSchema.safeParse({ action: 'GRANT_ACCESS', reason: ' ' }).success).toBe(false);
    expect(billingReviewResolutionSchema.safeParse({ action: 'OTHER', reason: '確認済み' }).success).toBe(false);
  });
  it('fixes the existing public plan catalog without accepting internal fields', () => {
    const response = {
      newPurchasesEnabled: false,
      developmentTerms: true,
      billingTransport: 'disabled' as const,
      stripeMode: null,
      currency: 'JPY' as const,
      taxIncluded: true,
      plans: [
        { code: 'FOUNDER' as const, name: '創設会員' as const, priceYen: 1980, interval: 'MONTH' as const, available: false, remaining: 100 },
        { code: 'STANDARD' as const, name: '通常会員' as const, priceYen: 2980, interval: 'MONTH' as const, available: false },
        { code: 'DAY_PASS' as const, name: '1日利用' as const, priceYen: 980, interval: 'JST_DAY' as const, available: false }
      ]
    };
    expect(billingPlansResponseSchema.parse(response)).toEqual(response);
    expect(() => billingPlansResponseSchema.parse({ ...response, stripeSecretKey: 'secret' })).toThrow();
  });
  it('keeps member billing responses public and serializes database timestamps', () => {
    const response = {
      subscriptions: [{ id: '10000000-0000-4000-8000-000000000001', planCode: 'STANDARD', status: 'ACTIVE', priceYen: 2980, currentPeriodEndsAt: new Date('2027-02-01T00:00:00Z'), graceEndsAt: null, cancelAtPeriodEnd: false }],
      dayPasses: [{ id: '10000000-0000-4000-8000-000000000002', raceDate: '2027-02-07', status: 'ACTIVE', priceYen: 980 }],
      payments: [{ id: '10000000-0000-4000-8000-000000000003', provider: 'STRIPE', kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: 2980, occurredAt: new Date('2027-01-01T00:00:00Z') }],
      supportRequests: [{ id: '10000000-0000-4000-8000-000000000004', paymentTransactionId: null, category: 'OTHER' as const, message: '請求について確認したいです。', status: 'OPEN' as const, createdAt: new Date('2027-01-02T00:00:00Z'), updatedAt: new Date('2027-01-02T00:00:00Z'), events: [{ eventType: 'CREATED', occurredAt: new Date('2027-01-02T00:00:00Z') }] }],
      customerPortalAvailable: true
    };
    expect(memberBillingResponseSchema.parse(response)).toEqual({
      ...response,
      subscriptions: [{ ...response.subscriptions[0], currentPeriodEndsAt: '2027-02-01T00:00:00.000Z' }],
      payments: [{ ...response.payments[0], occurredAt: '2027-01-01T00:00:00.000Z' }],
      supportRequests: [{ ...response.supportRequests[0], createdAt: '2027-01-02T00:00:00.000Z', updatedAt: '2027-01-02T00:00:00.000Z', events: [{ eventType: 'CREATED', occurredAt: '2027-01-02T00:00:00.000Z' }] }]
    });
    expect(() => memberBillingResponseSchema.parse({ ...response, subscriptions: [{ ...response.subscriptions[0], providerSubscriptionId: 'sub_internal' }] })).toThrow();
    expect(() => memberBillingResponseSchema.parse({ ...response, dayPasses: [{ ...response.dayPasses[0], providerPassId: 'pass_internal' }] })).toThrow();
    expect(() => memberBillingResponseSchema.parse({ ...response, payments: [{ ...response.payments[0], providerPaymentId: 'payment_internal' }] })).toThrow();
    expect(() => memberBillingResponseSchema.parse({ ...response, supportRequests: [{ ...response.supportRequests[0], events: [{ ...response.supportRequests[0].events[0], reason: 'internal reason' }] }] })).toThrow();
  });
  it('keeps the administrator billing dashboard within its explicit operational contract', () => {
    const subscription = { id: '20000000-0000-4000-8000-000000000001', planCode: 'STANDARD', status: 'ACTIVE', priceYen: 2980, currentPeriodEndsAt: new Date('2027-02-01T00:00:00Z'), graceEndsAt: null, cancelAtPeriodEnd: false, user: { email: 'member@example.test', displayName: '会員' } };
    const payment = { id: '20000000-0000-4000-8000-000000000002', provider: 'STRIPE', kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: 2980, occurredAt: new Date('2027-01-01T00:00:00Z'), user: { email: 'member@example.test', displayName: '会員' } };
    const response = { billingTransport: 'stripe' as const, subscriptions: [subscription], dayPasses: [], payments: [payment], checkouts: [], stripeWebhooks: [], supportRequests: [], pendingDayPassReviews: [], reviewCheckouts: [] };
    expect(adminBillingResponseSchema.parse(response)).toEqual({
      ...response,
      subscriptions: [{ ...subscription, currentPeriodEndsAt: '2027-02-01T00:00:00.000Z' }],
      payments: [{ ...payment, occurredAt: '2027-01-01T00:00:00.000Z' }]
    });
    expect(() => adminBillingResponseSchema.parse({ ...response, subscriptions: [{ ...subscription, providerSubscriptionId: 'sub_internal', entitlementId: '20000000-0000-4000-8000-000000000003' }] })).toThrow();
    expect(() => adminBillingResponseSchema.parse({ ...response, payments: [{ ...payment, providerPaymentId: 'payment_internal', subscriptionId: subscription.id }] })).toThrow();
  });
});
