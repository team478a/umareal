import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbService } from './db.service';
import { BillingQueryService } from './billing-query.service';
import type { BankTransferService } from './bank-transfer.service';

const bankSettings = { revision: 1, enabled: false, bankName: '', branchName: '', accountType: '' as const, accountNumber: '', accountHolder: '', instructions: '', requestValidityDays: 3, monthlyAccessDays: 30 };
const bankTransfers = { settings: vi.fn().mockResolvedValue(bankSettings), memberRequests: vi.fn().mockResolvedValue([]), adminRequests: vi.fn().mockResolvedValue([]) };

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
      systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue({ newPurchasesEnabled: true, founderSalesEnabled: true, standardSalesEnabled: true, dayPassSalesEnabled: true, founderPriceYen: 1980, standardPriceYen: 2980, dayPassPriceYen: 980, founderSalesLimit: 5 }) },
      subscription: { count: subscriptionCount },
      billingCheckout: { count: checkoutCount },
      bankTransferRequest: { count: vi.fn().mockResolvedValue(0) },
    };
    const service = new BillingQueryService(db as unknown as DbService, bankTransfers as unknown as BankTransferService);

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
    } as unknown as DbService, bankTransfers as unknown as BankTransferService);

    const result = await service.member('member-1');

    expect(result).toEqual({ subscriptions: [publicSubscription], dayPasses: [pass], payments: [payment], supportRequests: [supportRequest], bankTransfers: [], customerPortalAvailable: true });
    expect(subscriptions).toHaveBeenCalledWith({ where: { userId: 'member-1' }, select: { id: true, planCode: true, status: true, priceYen: true, currentPeriodEndsAt: true, graceEndsAt: true, cancelAtPeriodEnd: true, provider: true }, orderBy: { createdAt: 'desc' } });
    expect(dayPasses).toHaveBeenCalledWith({ where: { userId: 'member-1' }, select: { id: true, raceDate: true, status: true, priceYen: true }, orderBy: { createdAt: 'desc' } });
    expect(payments).toHaveBeenCalledWith({ where: { userId: 'member-1' }, select: { id: true, provider: true, kind: true, status: true, amountYen: true, occurredAt: true }, orderBy: { occurredAt: 'desc' } });
    expect(supportRequests).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'member-1' }, orderBy: { createdAt: 'desc' } }));
  });

  it('loads the existing bounded administration views without exposing full database records', async () => {
    process.env.BILLING_TRANSPORT = 'stripe';
    const subscription = { id: 'subscription-1' };
    const dayPass = { id: 'pass-1' };
    const payment = { id: 'payment-1' };
    const checkout = { id: 'checkout-1' };
    const webhook = { id: 'webhook-1' };
    const supportRequest = { id: 'support-1' };
    const pendingReview = { id: 'pending-pass-1' };
    const reviewCheckout = { id: 'review-checkout-1' };
    const subscriptionFindMany = vi.fn().mockResolvedValue([subscription]);
    const dayPassFindMany = vi.fn().mockResolvedValueOnce([dayPass]).mockResolvedValueOnce([pendingReview]);
    const paymentFindMany = vi.fn().mockResolvedValue([payment]);
    const checkoutFindMany = vi.fn().mockResolvedValueOnce([checkout]).mockResolvedValueOnce([reviewCheckout]);
    const webhookFindMany = vi.fn().mockResolvedValue([webhook]);
    const supportFindMany = vi.fn().mockResolvedValue([supportRequest]);
    const service = new BillingQueryService({
      subscription: { findMany: subscriptionFindMany },
      dayPass: { findMany: dayPassFindMany },
      paymentTransaction: { findMany: paymentFindMany },
      billingCheckout: { findMany: checkoutFindMany },
      stripeWebhookEvent: { findMany: webhookFindMany },
      billingSupportRequest: { findMany: supportFindMany },
    } as unknown as DbService, bankTransfers as unknown as BankTransferService);

    const result = await service.admin();

    expect(result).toEqual({
      billingTransport: 'stripe',
      subscriptions: [subscription],
      dayPasses: [dayPass],
      payments: [payment],
      checkouts: [checkout],
      stripeWebhooks: [webhook],
      supportRequests: [supportRequest],
      pendingDayPassReviews: [pendingReview],
      reviewCheckouts: [reviewCheckout],
      bankTransfers: [],
      bankTransferSettings: bankSettings,
    });
    expect(subscriptionFindMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ id: true, user: { select: { email: true, displayName: true } } }), orderBy: { createdAt: 'desc' }, take: 100 }));
    expect(paymentFindMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ providerPaymentId: true, userId: true }), take: 100 }));
    expect(dayPassFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { source: 'PURCHASE', status: { in: ['PENDING', 'REFUNDING'] }, startsAt: null, entitlementId: null, endsAt: { lte: expect.any(Date) } },
      orderBy: { endsAt: 'asc' },
      take: 100,
    }));
    expect(checkoutFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { status: { in: ['REJECTED_ACCOUNT_STATE', 'REJECTED_EXISTING_ACCESS', 'REJECTED_FOUNDER_LIMIT', 'REVIEW_REFUNDING'] } },
      orderBy: { completedAt: 'asc' },
      take: 100,
    }));
  });
});
