import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from './auth.service';
import { BillingLocalSimulationService } from './billing-local-simulation.service';
import type { AppRequest } from './context';

const request = { requestId: 'request-1' } as AppRequest;
const now = new Date('2027-10-15T03:00:00.000Z');

function fixture(options: { status?: string; graceDays?: number } = {}) {
  const current = { id: 'subscription-1', userId: 'user-1', entitlementId: 'entitlement-1', status: options.status ?? 'ACTIVE', priceYen: 2980 };
  const subscriptionUpdate = vi.fn().mockResolvedValue(current);
  const entitlementUpdate = vi.fn().mockResolvedValue({ id: 'entitlement-1' });
  const paymentCreate = vi.fn().mockResolvedValue({ id: 'payment-1' });
  const billingEventCreate = vi.fn().mockResolvedValue({ id: 'billing-event-1' });
  const notificationEventCreate = vi.fn().mockResolvedValue({ id: 'notification-1' });
  const tx = {
    subscription: { findUniqueOrThrow: vi.fn().mockResolvedValue(current), update: subscriptionUpdate },
    systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue({ billingGraceDays: options.graceDays ?? 3 }) },
    entitlement: { update: entitlementUpdate },
    paymentTransaction: { create: paymentCreate },
    billingEvent: { create: billingEventCreate },
    notificationEvent: { create: notificationEventCreate }
  };
  const db = { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
  const audit = vi.fn().mockResolvedValue(undefined);
  const service = new BillingLocalSimulationService({ db, audit } as unknown as AuthService);
  return { service, tx, audit, subscriptionUpdate, entitlementUpdate, paymentCreate, billingEventCreate, notificationEventCreate };
}

describe('BillingLocalSimulationService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('simulates a failed payment while preserving access through the configured grace period', async () => {
    const { service, subscriptionUpdate, entitlementUpdate, paymentCreate, billingEventCreate, notificationEventCreate, audit } = fixture({ graceDays: 3 });
    const graceEndsAt = new Date('2027-10-18T03:00:00.000Z');

    await expect(service.simulateFailure(request, 'admin-1', 'subscription-1', '支払失敗の試験')).resolves.toEqual({ id: 'subscription-1', status: 'PAST_DUE', graceEndsAt });
    expect(subscriptionUpdate).toHaveBeenCalledWith({ where: { id: 'subscription-1' }, data: { status: 'PAST_DUE', graceEndsAt } });
    expect(entitlementUpdate).toHaveBeenCalledWith({ where: { id: 'entitlement-1' }, data: { endsAt: graceEndsAt, revokedAt: null } });
    expect(paymentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: 'user-1', provider: 'LOCAL_TEST', providerPaymentId: expect.stringMatching(/^local-failed-/), kind: 'SUBSCRIPTION', status: 'FAILED', amountYen: 2980, subscriptionId: 'subscription-1' }) });
    expect(billingEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'PAYMENT_FAILED', subscriptionId: 'subscription-1', actorId: 'admin-1', details: { reason: '支払失敗の試験', graceEndsAt: graceEndsAt.toISOString() } }) });
    expect(notificationEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'BILLING_PAYMENT_FAILED', billingEventId: 'billing-event-1' }) });
    expect(audit).toHaveBeenCalledWith(expect.anything(), request, 'BILLING_SIMULATE_FAILURE', 'subscription-1', '支払失敗の試験', { graceEndsAt });
  });

  it('revokes access immediately when the configured grace period is zero', async () => {
    const { service, entitlementUpdate } = fixture({ graceDays: 0 });

    await service.simulateFailure(request, 'admin-1', 'subscription-1', '猶予なしの試験');
    expect(entitlementUpdate).toHaveBeenCalledWith({ where: { id: 'entitlement-1' }, data: { endsAt: new Date(now.getTime() + 1), revokedAt: now } });
  });

  it('rejects failure simulation for a closed subscription before writing history', async () => {
    const { service, subscriptionUpdate, paymentCreate, billingEventCreate, audit } = fixture({ status: 'CANCELED' });

    await expect(service.simulateFailure(request, 'admin-1', 'subscription-1', '失敗不可の試験')).rejects.toMatchObject({ response: { code: 'SUBSCRIPTION_NOT_OPEN' } });
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(paymentCreate).not.toHaveBeenCalled();
    expect(billingEventCreate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('simulates payment recovery and restores the existing entitlement for one calendar month', async () => {
    const { service, subscriptionUpdate, entitlementUpdate, paymentCreate, billingEventCreate, notificationEventCreate, audit } = fixture({ status: 'PAST_DUE' });
    const currentPeriodEndsAt = new Date('2027-11-15T03:00:00.000Z');

    await expect(service.simulateRecovery(request, 'admin-1', 'subscription-1', '支払回復の試験')).resolves.toEqual({ id: 'subscription-1', status: 'ACTIVE', currentPeriodEndsAt });
    expect(subscriptionUpdate).toHaveBeenCalledWith({ where: { id: 'subscription-1' }, data: { status: 'ACTIVE', currentPeriodStartsAt: now, currentPeriodEndsAt, graceEndsAt: null } });
    expect(entitlementUpdate).toHaveBeenCalledWith({ where: { id: 'entitlement-1' }, data: { startsAt: now, endsAt: currentPeriodEndsAt, revokedAt: null } });
    expect(paymentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'LOCAL_TEST', providerPaymentId: expect.stringMatching(/^local-recovery-/), status: 'SUCCEEDED', subscriptionId: 'subscription-1' }) });
    expect(billingEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'PAYMENT_RECOVERED', actorId: 'admin-1', details: { reason: '支払回復の試験', currentPeriodEndsAt: currentPeriodEndsAt.toISOString() } }) });
    expect(notificationEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'BILLING_PAYMENT_RECOVERED', billingEventId: 'billing-event-1' }) });
    expect(audit).toHaveBeenCalledWith(expect.anything(), request, 'BILLING_RECOVER', 'subscription-1', '支払回復の試験', { currentPeriodEndsAt });
  });

  it('rejects recovery when the subscription is not waiting for payment', async () => {
    const { service, subscriptionUpdate, paymentCreate, billingEventCreate, audit } = fixture({ status: 'ACTIVE' });

    await expect(service.simulateRecovery(request, 'admin-1', 'subscription-1', '回復不可の試験')).rejects.toMatchObject({ response: { code: 'SUBSCRIPTION_NOT_PAST_DUE' } });
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(paymentCreate).not.toHaveBeenCalled();
    expect(billingEventCreate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
