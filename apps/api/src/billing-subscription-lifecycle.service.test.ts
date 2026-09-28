import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { BillingSubscriptionLifecycleService } from './billing-subscription-lifecycle.service';

class TestBillingSubscriptionLifecycleService extends BillingSubscriptionLifecycleService {
  constructor(auth: AuthService, private readonly client: Stripe) { super(auth); }
  protected override async configuredClient() { return this.client; }
}

const accessEndsAt = new Date('2027-11-01T00:00:00.000Z');
const updatedAt = new Date('2027-10-01T00:00:00.000Z');
const request = { requestId: 'request-1' } as AppRequest;

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'subscription-1',
    userId: 'user-1',
    provider: 'STRIPE',
    providerSubscriptionId: 'sub_123',
    status: 'ACTIVE',
    cancelAtPeriodEnd: false,
    currentPeriodEndsAt: accessEndsAt,
    updatedAt,
    ...overrides
  };
}

function fixture(input: { external?: ReturnType<typeof subscription> | null; current?: ReturnType<typeof subscription> | null } = {}) {
  const external = input.external === undefined ? subscription() : input.external;
  const current = input.current === undefined ? external : input.current;
  const subscriptionUpdate = vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...current, ...data }));
  const billingEventCreate = vi.fn().mockResolvedValue({ id: 'billing-event-1' });
  const notificationEventCreate = vi.fn().mockResolvedValue({ id: 'notification-1' });
  const queryRaw = vi.fn().mockResolvedValue([]);
  const tx = {
    $queryRaw: queryRaw,
    subscription: { findUnique: vi.fn().mockResolvedValue(current), update: subscriptionUpdate },
    billingEvent: { create: billingEventCreate },
    notificationEvent: { create: notificationEventCreate }
  };
  const db = {
    subscription: { findUnique: vi.fn().mockResolvedValue(external) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx))
  };
  const audit = vi.fn().mockResolvedValue(undefined);
  const providerUpdate = vi.fn().mockResolvedValue({ id: 'sub_123' });
  const auth = { db, audit } as unknown as AuthService;
  const service = new TestBillingSubscriptionLifecycleService(auth, { subscriptions: { update: providerUpdate } } as unknown as Stripe);
  return { service, db, tx, audit, providerUpdate, subscriptionUpdate, billingEventCreate, notificationEventCreate, queryRaw };
}

describe('BillingSubscriptionLifecycleService', () => {
  it('schedules Stripe cancellation while preserving access through the paid period', async () => {
    const { service, providerUpdate, subscriptionUpdate, billingEventCreate, notificationEventCreate, audit } = fixture();

    await expect(service.scheduleCancellation(request, 'user-1', 'subscription-1', 'stripe')).resolves.toEqual({
      id: 'subscription-1',
      status: 'ACTIVE',
      cancelAtPeriodEnd: true,
      accessEndsAt
    });
    expect(providerUpdate).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: true }, { idempotencyKey: `cancel-at-period-end:subscription-1:${updatedAt.getTime()}` });
    expect(subscriptionUpdate).toHaveBeenCalledWith({ where: { id: 'subscription-1' }, data: { cancelAtPeriodEnd: true, canceledAt: expect.any(Date) } });
    expect(billingEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'CANCELLATION_SCHEDULED', userId: 'user-1', subscriptionId: 'subscription-1', actorId: 'user-1' }) });
    expect(notificationEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'BILLING_CANCELLATION_SCHEDULED', billingEventId: 'billing-event-1' }) });
    expect(audit).toHaveBeenCalledWith(expect.anything(), request, 'SUBSCRIPTION_CANCEL_SCHEDULE', 'subscription-1', '会員本人による解約予約', { accessEndsAt }, 'Subscription');
  });

  it('keeps an existing cancellation idempotent without another Stripe update or event', async () => {
    const scheduled = subscription({ cancelAtPeriodEnd: true });
    const { service, providerUpdate, subscriptionUpdate, billingEventCreate, audit } = fixture({ external: scheduled, current: scheduled });

    await expect(service.scheduleCancellation(request, 'user-1', 'subscription-1', 'stripe')).resolves.toEqual({
      id: 'subscription-1',
      status: 'ACTIVE',
      cancelAtPeriodEnd: true,
      accessEndsAt
    });
    expect(providerUpdate).not.toHaveBeenCalled();
    expect(subscriptionUpdate).not.toHaveBeenCalled();
    expect(billingEventCreate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects another member subscription before changing Stripe', async () => {
    const { service, providerUpdate } = fixture({ external: subscription({ userId: 'user-2' }) });

    await expect(service.scheduleCancellation(request, 'user-1', 'subscription-1', 'stripe')).rejects.toMatchObject({ response: { code: 'SUBSCRIPTION_ACCESS_DENIED' } });
    expect(providerUpdate).not.toHaveBeenCalled();
  });

  it('reverses a Stripe cancellation with the existing lock, event and audit boundary', async () => {
    const scheduled = subscription({ cancelAtPeriodEnd: true });
    const { service, providerUpdate, subscriptionUpdate, billingEventCreate, notificationEventCreate, audit, queryRaw } = fixture({ external: scheduled, current: scheduled });

    await expect(service.resume(request, 'user-1', 'subscription-1', 'stripe')).resolves.toEqual({
      id: 'subscription-1',
      status: 'ACTIVE',
      cancelAtPeriodEnd: false,
      accessEndsAt
    });
    expect(providerUpdate).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: false }, { idempotencyKey: `resume-subscription:subscription-1:${updatedAt.getTime()}` });
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(subscriptionUpdate).toHaveBeenCalledWith({ where: { id: 'subscription-1' }, data: { cancelAtPeriodEnd: false, canceledAt: null, updatedAt: expect.any(Date) } });
    expect(billingEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'CANCELLATION_REVERSED', userId: 'user-1', subscriptionId: 'subscription-1', actorId: 'user-1' }) });
    expect(notificationEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'BILLING_CANCELLATION_REVERSED', billingEventId: 'billing-event-1' }) });
    expect(audit).toHaveBeenCalledWith(expect.anything(), request, 'SUBSCRIPTION_CANCEL_REVERSED', 'subscription-1', '会員本人による解約予約の取消', { accessEndsAt }, 'Subscription');
  });
});
