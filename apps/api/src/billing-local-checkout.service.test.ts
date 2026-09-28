import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from './auth.service';
import { BillingLocalCheckoutService } from './billing-local-checkout.service';

const now = new Date('2027-10-15T03:00:00.000Z');

function serviceWith(tx: Record<string, unknown>) {
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    idempotencyKey: { findUnique: vi.fn() },
  };
  return { service: new BillingLocalCheckoutService({ db } as unknown as AuthService), db };
}

describe('BillingLocalCheckoutService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('creates the existing local monthly access, payment and notification in one transaction', async () => {
    const idempotencyCreate = vi.fn().mockResolvedValue({});
    const entitlementCreate = vi.fn().mockResolvedValue({ id: 'entitlement-1' });
    const subscriptionCreate = vi.fn().mockResolvedValue({ id: 'subscription-1', status: 'ACTIVE' });
    const paymentCreate = vi.fn().mockResolvedValue({ id: 'payment-1' });
    const billingEventCreate = vi.fn().mockResolvedValue({ id: 'billing-event-1' });
    const notificationEventCreate = vi.fn().mockResolvedValue({ id: 'notification-1' });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      idempotencyKey: { findUnique: vi.fn().mockResolvedValue(null), create: idempotencyCreate },
      systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue({ newPurchasesEnabled: true, founderSalesEnabled: true, founderSalesLimit: 100, founderPriceYen: 1980, standardPriceYen: 2980 }) },
      subscription: { count: vi.fn().mockResolvedValue(0), create: subscriptionCreate },
      entitlement: { create: entitlementCreate },
      paymentTransaction: { create: paymentCreate },
      billingEvent: { create: billingEventCreate },
      notificationEvent: { create: notificationEventCreate },
    };
    const { service, db } = serviceWith(tx);

    await expect(service.subscription('user-1', 'STANDARD', 'checkout-key', 'request-hash')).resolves.toEqual({
      subscriptionId: 'subscription-1',
      paymentId: 'payment-1',
      status: 'ACTIVE',
      currentPeriodEndsAt: new Date('2027-11-15T03:00:00.000Z'),
    });

    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 20000, maxWait: 10000 });
    expect(entitlementCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-1', planCode: 'STANDARD', startsAt: now, endsAt: new Date('2027-11-15T03:00:00.000Z'), reason: 'LOCAL_TEST_SUBSCRIPTION', grantedBy: 'user-1' }) });
    expect(subscriptionCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'LOCAL_TEST', providerSubscriptionId: expect.stringMatching(/^local-sub-/), priceYen: 2980, entitlementId: 'entitlement-1' }) });
    expect(paymentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'LOCAL_TEST', providerPaymentId: expect.stringMatching(/^local-pay-/), status: 'SUCCEEDED', amountYen: 2980, subscriptionId: 'subscription-1' }) });
    expect(billingEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'SUBSCRIPTION_STARTED', subscriptionId: 'subscription-1', actorId: 'user-1', details: { planCode: 'STANDARD', priceYen: 2980, developmentSimulation: true } }) });
    expect(notificationEventCreate).toHaveBeenCalledWith({ data: { billingEventId: 'billing-event-1', eventType: 'BILLING_PAYMENT_SUCCEEDED', status: 'QUEUED', payload: { billingEventId: 'billing-event-1' } } });
    expect(idempotencyCreate).toHaveBeenCalledWith({ data: { key: 'checkout-key', requestHash: 'request-hash', response: expect.objectContaining({ subscriptionId: 'subscription-1', paymentId: 'payment-1' }) } });
  });

  it('returns the saved monthly response without issuing access again', async () => {
    const response = { subscriptionId: 'subscription-existing', paymentId: 'payment-existing', status: 'ACTIVE' };
    const entitlementCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      idempotencyKey: { findUnique: vi.fn().mockResolvedValue({ requestHash: 'request-hash', response }), create: vi.fn() },
      entitlement: { create: entitlementCreate },
    };
    const { service } = serviceWith(tx);

    await expect(service.subscription('user-1', 'STANDARD', 'checkout-key', 'request-hash')).resolves.toEqual(response);
    expect(entitlementCreate).not.toHaveBeenCalled();
  });

  it('keeps the founder capacity rejection before creating paid access', async () => {
    const entitlementCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      idempotencyKey: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue({ newPurchasesEnabled: true, founderSalesEnabled: true, founderSalesLimit: 3, founderPriceYen: 1980, standardPriceYen: 2980 }) },
      subscription: { count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(3) },
      entitlement: { create: entitlementCreate },
    };
    const { service } = serviceWith(tx);

    await expect(service.subscription('user-1', 'FOUNDER', 'checkout-key', 'request-hash')).rejects.toMatchObject({ response: { code: 'FOUNDER_LIMIT_REACHED' } });
    expect(entitlementCreate).not.toHaveBeenCalled();
  });

  it('creates a local day pass through the shared access path and queues the payment notice', async () => {
    const endsAt = new Date('2027-10-18T15:00:00.000Z');
    const entitlementCreate = vi.fn().mockResolvedValue({ id: 'entitlement-1' });
    const passCreate = vi.fn().mockResolvedValue({ id: 'pass-1', status: 'ACTIVE' });
    const paymentCreate = vi.fn().mockResolvedValue({ id: 'payment-1' });
    const notificationEventCreate = vi.fn().mockResolvedValue({ id: 'notification-1' });
    const idempotencyCreate = vi.fn().mockResolvedValue({});
    const tx = {
      idempotencyKey: { findUnique: vi.fn().mockResolvedValue(null), create: idempotencyCreate },
      systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue({ newPurchasesEnabled: true, dayPassPriceYen: 980 }) },
      predictionProduct: { findUnique: vi.fn().mockResolvedValue(null) },
      entitlement: { create: entitlementCreate },
      dayPass: { create: passCreate },
      billingEvent: { create: vi.fn().mockResolvedValue({ id: 'billing-event-1' }) },
      paymentTransaction: { create: paymentCreate },
      notificationEvent: { create: notificationEventCreate },
    };
    const { service } = serviceWith(tx);

    await expect(service.dayPass('user-1', '2027-10-18', 'pass-key', 'request-hash')).resolves.toEqual({
      dayPassId: 'pass-1',
      paymentId: 'payment-1',
      status: 'ACTIVE',
      startsAt: new Date('2027-10-17T15:00:00.000Z'),
      endsAt,
      waitingForPublication: false,
    });

    expect(entitlementCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-1', planCode: 'DAY_PASS', raceDate: '2027-10-18', reason: 'LOCAL_TEST_DAY_PASS' }) });
    expect(passCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ source: 'PURCHASE', provider: 'LOCAL_TEST', providerPassId: expect.stringMatching(/^local-pass-/), entitlementId: 'entitlement-1' }) });
    expect(paymentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'LOCAL_TEST', providerPaymentId: expect.stringMatching(/^local-pay-/), amountYen: 980, dayPassId: 'pass-1' }) });
    expect(notificationEventCreate).toHaveBeenCalledWith({ data: { billingEventId: 'billing-event-1', eventType: 'BILLING_PAYMENT_SUCCEEDED', status: 'QUEUED', payload: { billingEventId: 'billing-event-1' } } });
    expect(idempotencyCreate).toHaveBeenCalledWith({ data: { key: 'pass-key', requestHash: 'request-hash', response: expect.objectContaining({ dayPassId: 'pass-1', paymentId: 'payment-1', endsAt }) } });
  });
});
