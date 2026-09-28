import { describe, expect, it } from 'vitest';
import { addCalendarMonthUtc, adminBillingCheckoutResolutionResponseSchema, adminBillingDayPassRefundResponseSchema, adminBillingFailureSimulationResponseSchema, adminBillingRecoverySimulationResponseSchema, adminBillingResponseSchema, adminBillingSupportStatusResponseSchema, billingCouponCreateSchema, billingDayPassCheckoutResponseSchema, billingPlansResponseSchema, billingPortalResponseSchema, billingReceiptResponseSchema, billingReviewResolutionSchema, billingSubscriptionCheckoutResponseSchema, billingSubscriptionLifecycleResponseSchema, billingSupportRequestCreatedResponseSchema, dayPassCheckoutSchema, dayPassCheckoutWithCouponSchema, dayPassWindow, memberBillingResponseSchema } from './index';

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
  it('shares the existing checkout and Stripe self-service response contracts', () => {
    const subscription = {
      subscriptionId: '30000000-0000-4000-8000-000000000001',
      paymentId: '30000000-0000-4000-8000-000000000002',
      status: 'ACTIVE',
      currentPeriodEndsAt: new Date('2027-02-01T00:00:00Z')
    };
    expect(billingSubscriptionCheckoutResponseSchema.parse(subscription)).toEqual({ ...subscription, currentPeriodEndsAt: '2027-02-01T00:00:00.000Z' });
    expect(() => billingSubscriptionCheckoutResponseSchema.parse({ ...subscription, providerSubscriptionId: 'sub_secret' })).toThrow();

    const dayPass = {
      dayPassId: '30000000-0000-4000-8000-000000000003',
      paymentId: '30000000-0000-4000-8000-000000000004',
      status: 'PENDING',
      startsAt: null,
      endsAt: new Date('2027-02-07T15:00:00Z'),
      waitingForPublication: true
    };
    expect(billingDayPassCheckoutResponseSchema.parse(dayPass)).toEqual({ ...dayPass, endsAt: '2027-02-07T15:00:00.000Z' });
    expect(billingSubscriptionCheckoutResponseSchema.parse({ checkoutId: '30000000-0000-4000-8000-000000000005', checkoutUrl: 'https://checkout.stripe.com/c/pay/test', status: 'OPEN' })).toMatchObject({ status: 'OPEN' });

    const receipt = { paymentId: '30000000-0000-4000-8000-000000000004', receiptUrl: 'https://pay.stripe.com/receipts/test' };
    expect(billingReceiptResponseSchema.parse(receipt)).toEqual(receipt);
    expect(billingReceiptResponseSchema.safeParse({ ...receipt, receiptUrl: 'https://stripe.com.example.test/receipt' }).success).toBe(false);
    expect(billingPortalResponseSchema.parse({ portalUrl: 'https://billing.stripe.com/p/session/test' })).toEqual({ portalUrl: 'https://billing.stripe.com/p/session/test' });
    expect(billingPortalResponseSchema.safeParse({ portalUrl: 'http://billing.stripe.com/p/session/test' }).success).toBe(false);
  });
  it('shares member billing action responses without exposing internal identifiers', () => {
    const lifecycle = {
      id: '30000000-0000-4000-8000-000000000006',
      status: 'ACTIVE',
      cancelAtPeriodEnd: true,
      accessEndsAt: new Date('2027-03-01T00:00:00Z')
    };
    expect(billingSubscriptionLifecycleResponseSchema.parse(lifecycle)).toEqual({ ...lifecycle, accessEndsAt: '2027-03-01T00:00:00.000Z' });
    expect(() => billingSubscriptionLifecycleResponseSchema.parse({ ...lifecycle, providerSubscriptionId: 'sub_secret' })).toThrow();

    const support = {
      id: '30000000-0000-4000-8000-000000000007',
      category: 'REFUND',
      status: 'OPEN',
      paymentTransactionId: '30000000-0000-4000-8000-000000000008',
      createdAt: new Date('2027-03-01T01:00:00Z')
    } as const;
    expect(billingSupportRequestCreatedResponseSchema.parse(support)).toEqual({ ...support, createdAt: '2027-03-01T01:00:00.000Z' });
    expect(() => billingSupportRequestCreatedResponseSchema.parse({ ...support, userId: '30000000-0000-4000-8000-000000000009' })).toThrow();
  });
  it('shares administrator billing action responses without exposing provider or actor identifiers', () => {
    const checkoutId = '40000000-0000-4000-8000-000000000001';
    const paymentId = '40000000-0000-4000-8000-000000000002';
    const subscriptionId = '40000000-0000-4000-8000-000000000003';
    const supportId = '40000000-0000-4000-8000-000000000004';
    expect(adminBillingCheckoutResolutionResponseSchema.parse({ checkoutId, status: 'REVIEW_ACCESS_GRANTED' })).toEqual({ checkoutId, status: 'REVIEW_ACCESS_GRANTED' });
    expect(() => adminBillingCheckoutResolutionResponseSchema.parse({ checkoutId, status: 'REVIEW_REFUNDED', providerRefundId: 're_internal' })).toThrow();
    expect(adminBillingDayPassRefundResponseSchema.parse({ dayPassId: checkoutId, status: 'REFUNDED', refundPaymentId: paymentId })).toEqual({ dayPassId: checkoutId, status: 'REFUNDED', refundPaymentId: paymentId });
    expect(() => adminBillingDayPassRefundResponseSchema.parse({ dayPassId: checkoutId, status: 'REFUNDED', refundPaymentId: paymentId, userId: subscriptionId })).toThrow();
    expect(adminBillingSupportStatusResponseSchema.parse({ id: supportId, status: 'IN_PROGRESS', updatedAt: new Date('2027-03-02T00:00:00Z') })).toEqual({ id: supportId, status: 'IN_PROGRESS', updatedAt: '2027-03-02T00:00:00.000Z' });
    expect(() => adminBillingSupportStatusResponseSchema.parse({ id: supportId, status: 'RESOLVED', updatedAt: new Date(), actorId: subscriptionId })).toThrow();
    expect(adminBillingFailureSimulationResponseSchema.parse({ id: subscriptionId, status: 'PAST_DUE', graceEndsAt: new Date('2027-03-10T00:00:00Z') })).toEqual({ id: subscriptionId, status: 'PAST_DUE', graceEndsAt: '2027-03-10T00:00:00.000Z' });
    expect(adminBillingRecoverySimulationResponseSchema.parse({ id: subscriptionId, status: 'ACTIVE', currentPeriodEndsAt: new Date('2027-04-01T00:00:00Z') })).toEqual({ id: subscriptionId, status: 'ACTIVE', currentPeriodEndsAt: '2027-04-01T00:00:00.000Z' });
    expect(() => adminBillingRecoverySimulationResponseSchema.parse({ id: subscriptionId, status: 'ACTIVE', currentPeriodEndsAt: new Date(), providerSubscriptionId: 'sub_internal' })).toThrow();
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
