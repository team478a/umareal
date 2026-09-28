import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { AuthService } from './auth.service';
import { BillingAdminResolutionService } from './billing-admin-resolution.service';
import type { AppRequest } from './context';

class TestBillingAdminResolutionService extends BillingAdminResolutionService {
  constructor(auth: AuthService, private readonly client: Stripe) { super(auth); }
  protected override async configuredClient() { return this.client; }
}

const request = { requestId: 'request-1' } as AppRequest;

describe('BillingAdminResolutionService', () => {
  it('returns a completed checkout resolution without contacting Stripe or creating another record', async () => {
    const retrieve = vi.fn();
    const transaction = vi.fn();
    const auth = {
      db: {
        billingCheckout: { findUnique: vi.fn().mockResolvedValue({ id: 'checkout-1', providerSessionId: 'cs_1', completedAt: new Date(), status: 'REVIEW_REFUNDED' }) },
        $transaction: transaction
      }
    } as unknown as AuthService;
    const service = new TestBillingAdminResolutionService(auth, { checkout: { sessions: { retrieve } } } as unknown as Stripe);

    await expect(service.resolveCheckoutReview(request, 'admin-1', 'checkout-1', { action: 'REFUND', reason: '確認済み' })).resolves.toEqual({ checkoutId: 'checkout-1', status: 'REVIEW_REFUNDED' });
    expect(retrieve).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a mismatched Stripe payment before granting access', async () => {
    const transaction = vi.fn();
    const retrieve = vi.fn().mockResolvedValue({ payment_status: 'paid', currency: 'jpy', amount_total: 1, subscription: null });
    const auth = {
      db: {
        billingCheckout: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'checkout-1', userId: 'user-1', kind: 'DAY_PASS', planCode: 'DAY_PASS', amountYen: 980,
            providerSessionId: 'cs_1', providerSubscriptionId: null, completedAt: new Date(), status: 'REJECTED_ACCOUNT_STATE'
          })
        },
        $transaction: transaction
      }
    } as unknown as AuthService;
    const service = new TestBillingAdminResolutionService(auth, { checkout: { sessions: { retrieve } } } as unknown as Stripe);

    await expect(service.resolveCheckoutReview(request, 'admin-1', 'checkout-1', { action: 'GRANT_ACCESS', reason: '決済内容を確認済み' })).rejects.toMatchObject({ response: { code: 'STRIPE_PAYMENT_MISMATCH' } });
    expect(retrieve).toHaveBeenCalledWith('cs_1');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refunds an expired local day pass once and preserves idempotency on retry', async () => {
    const payments: Array<Record<string, unknown>> = [{ id: 'payment-1', status: 'SUCCEEDED', amountYen: 980 }];
    const pass = {
      id: 'day-pass-1', userId: 'user-1', source: 'PURCHASE', status: 'PENDING', startsAt: null, entitlementId: null,
      endsAt: new Date('2025-09-30T15:00:00.000Z'), provider: 'LOCAL_TEST', providerPassId: 'local-pass-1',
      priceYen: 980, raceDate: '2025-09-30'
    };
    const billingEventCreate = vi.fn().mockResolvedValue({ id: 'billing-event-1' });
    const notificationEventCreate = vi.fn().mockResolvedValue({ id: 'notification-1' });
    const paymentCreate = vi.fn().mockImplementation(async ({ data }) => {
      const payment = { id: 'refund-payment-1', ...data };
      payments.push(payment);
      return payment;
    });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      dayPass: {
        findUnique: vi.fn().mockImplementation(async () => ({ ...pass, payments: [...payments] })),
        findUniqueOrThrow: vi.fn().mockImplementation(async () => ({ ...pass, payments: [...payments] })),
        updateMany: vi.fn().mockImplementation(async () => { pass.status = 'REFUNDING'; return { count: 1 }; }),
        update: vi.fn().mockImplementation(async ({ data }) => { Object.assign(pass, data); return pass; })
      },
      paymentTransaction: { create: paymentCreate },
      billingEvent: { create: billingEventCreate },
      notificationEvent: { create: notificationEventCreate }
    };
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const audit = vi.fn().mockResolvedValue(undefined);
    const auth = { db: { $transaction: transaction }, audit } as unknown as AuthService;
    const service = new TestBillingAdminResolutionService(auth, {} as Stripe);

    const first = await service.refundExpiredPendingDayPass(request, 'admin-1', 'day-pass-1', '公開されず期限を過ぎたため');
    const second = await service.refundExpiredPendingDayPass(request, 'admin-1', 'day-pass-1', '再確認');

    expect(first).toEqual({ dayPassId: 'day-pass-1', status: 'REFUNDED', refundPaymentId: 'refund-payment-1' });
    expect(second).toEqual(first);
    expect(paymentCreate).toHaveBeenCalledOnce();
    expect(paymentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'LOCAL_TEST', providerPaymentId: 'refund:local-day-pass-1', status: 'REFUNDED', amountYen: 980 }) });
    expect(billingEventCreate).toHaveBeenCalledOnce();
    expect(billingEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'DAY_PASS_REFUNDED', userId: 'user-1', dayPassId: 'day-pass-1', actorId: 'admin-1' }) });
    expect(notificationEventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'BILLING_REFUND_COMPLETED', billingEventId: 'billing-event-1' }) });
    expect(audit).toHaveBeenCalledOnce();
  });
});
