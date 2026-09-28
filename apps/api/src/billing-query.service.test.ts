import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbService } from './db.service';
import { BillingQueryService } from './billing-query.service';

const originalLaunchMode = process.env.LAUNCH_MODE;
const originalBillingTransport = process.env.BILLING_TRANSPORT;

afterEach(() => {
  process.env.LAUNCH_MODE = originalLaunchMode;
  process.env.BILLING_TRANSPORT = originalBillingTransport;
});

describe('BillingQueryService', () => {
  it('returns the existing three plans and accounts for sold and reserved founder capacity', async () => {
    process.env.LAUNCH_MODE = 'FULL';
    process.env.BILLING_TRANSPORT = 'test';
    const subscriptionCount = vi.fn().mockResolvedValue(2);
    const checkoutCount = vi.fn().mockResolvedValue(1);
    const db = {
      systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue({ newPurchasesEnabled: true, founderSalesEnabled: true, founderPriceYen: 1980, standardPriceYen: 2980, dayPassPriceYen: 980, founderSalesLimit: 5 }) },
      subscription: { count: subscriptionCount },
      billingCheckout: { count: checkoutCount },
    };
    const service = new BillingQueryService(db as unknown as DbService);

    const result = await service.plans();

    expect(result).toEqual({
      newPurchasesEnabled: true,
      developmentTerms: true,
      billingTransport: 'test',
      stripeMode: null,
      currency: 'JPY',
      taxIncluded: true,
      plans: [
        { code: 'FOUNDER', name: '創設会員', priceYen: 1980, interval: 'MONTH', available: true, remaining: 2 },
        { code: 'STANDARD', name: '通常会員', priceYen: 2980, interval: 'MONTH', available: true },
        { code: 'DAY_PASS', name: '1日利用', priceYen: 980, interval: 'JST_DAY', available: true },
      ],
    });
    expect(subscriptionCount).toHaveBeenCalledWith({ where: { planCode: 'FOUNDER', status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'] } } });
    expect(checkoutCount).toHaveBeenCalledWith({ where: { planCode: 'FOUNDER', status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: expect.any(Date) } } });
  });

  it('limits member billing history to the requested user and exposes the existing portal flag', async () => {
    process.env.BILLING_TRANSPORT = 'stripe';
    const currentPeriodEndsAt = new Date('2027-02-01T00:00:00Z');
    const subscription = { id: 'subscription-1', planCode: 'STANDARD', provider: 'STRIPE', status: 'ACTIVE', priceYen: 2980, currentPeriodEndsAt, graceEndsAt: null, cancelAtPeriodEnd: false };
    const publicSubscription = { id: 'subscription-1', planCode: 'STANDARD', status: 'ACTIVE', priceYen: 2980, currentPeriodEndsAt, graceEndsAt: null, cancelAtPeriodEnd: false };
    const pass = { id: 'pass-1', raceDate: '2027-02-07', status: 'ACTIVE', priceYen: 980 };
    const payment = { id: 'payment-1', provider: 'STRIPE', kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: 2980, occurredAt: new Date('2027-01-01T00:00:00Z') };
    const supportRequest = { id: 'support-1', paymentTransactionId: null, category: 'OTHER', message: '請求について確認したいです。', status: 'OPEN', createdAt: new Date('2027-01-02T00:00:00Z'), updatedAt: new Date('2027-01-02T00:00:00Z'), events: [] };
    const subscriptions = vi.fn().mockResolvedValue([subscription]);
    const dayPasses = vi.fn().mockResolvedValue([pass]);
    const payments = vi.fn().mockResolvedValue([payment]);
    const supportRequests = vi.fn().mockResolvedValue([supportRequest]);
    const service = new BillingQueryService({
      subscription: { findMany: subscriptions },
      dayPass: { findMany: dayPasses },
      paymentTransaction: { findMany: payments },
      billingSupportRequest: { findMany: supportRequests },
    } as unknown as DbService);

    const result = await service.member('member-1');

    expect(result).toEqual({ subscriptions: [publicSubscription], dayPasses: [pass], payments: [payment], supportRequests: [supportRequest], customerPortalAvailable: true });
    expect(subscriptions).toHaveBeenCalledWith({ where: { userId: 'member-1' }, select: { id: true, planCode: true, status: true, priceYen: true, currentPeriodEndsAt: true, graceEndsAt: true, cancelAtPeriodEnd: true, provider: true }, orderBy: { createdAt: 'desc' } });
    expect(dayPasses).toHaveBeenCalledWith({ where: { userId: 'member-1' }, select: { id: true, raceDate: true, status: true, priceYen: true }, orderBy: { createdAt: 'desc' } });
    expect(payments).toHaveBeenCalledWith({ where: { userId: 'member-1' }, select: { id: true, provider: true, kind: true, status: true, amountYen: true, occurredAt: true }, orderBy: { occurredAt: 'desc' } });
    expect(supportRequests).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'member-1' }, orderBy: { createdAt: 'desc' } }));
  });
});
