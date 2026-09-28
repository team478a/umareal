import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { AuthService } from './auth.service';
import type { AppRequest } from './context';
import type { StripeRuntimeConfig } from './stripe-config';
import { StripeCheckoutService } from './stripe-checkout.service';

class TestStripeCheckoutService extends StripeCheckoutService {
  constructor(auth: AuthService, private readonly client: Stripe) { super(auth); }
  protected override async configuredClient() {
    return {
      config: {
        priceFounder: 'price_founder',
        priceStandard: 'price_standard',
        priceDayPass: 'price_day_pass'
      } as StripeRuntimeConfig,
      client: this.client
    };
  }
}

function fixture(input: { existing?: Record<string, unknown> | null; stripePrice?: Record<string, unknown> } = {}) {
  const checkout = {
    id: 'checkout-1',
    amountYen: 980,
    expiresAt: new Date('2027-10-01T01:30:00.000Z')
  };
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: { findUnique: vi.fn().mockResolvedValue({ role: 'MEMBER', disabledAt: null, accountClosure: null }) },
    billingCheckout: {
      findUnique: vi.fn().mockResolvedValue(input.existing ?? null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(checkout),
      update: vi.fn().mockResolvedValue(checkout)
    },
    systemSetting: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        newPurchasesEnabled: true,
        founderSalesEnabled: true,
        founderSalesLimit: 100,
        founderPriceYen: 1980,
        standardPriceYen: 2980,
        dayPassPriceYen: 980
      })
    },
    subscription: { count: vi.fn().mockResolvedValue(0) },
    dayPass: { count: vi.fn().mockResolvedValue(0) }
  };
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const update = vi.fn().mockResolvedValue(checkout);
  const db = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    billingCheckout: { updateMany, update }
  };
  const audit = vi.fn().mockResolvedValue(undefined);
  const auth = { db, audit } as unknown as AuthService;
  const retrieve = vi.fn().mockResolvedValue(input.stripePrice ?? { active: true, currency: 'jpy', unit_amount: 980, recurring: null });
  const create = vi.fn().mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay', expires_at: 1822354200 });
  const service = new TestStripeCheckoutService(auth, { prices: { retrieve }, checkout: { sessions: { create } } } as unknown as Stripe);
  return { service, tx, db, audit, retrieve, create, updateMany, update };
}

const request = { requestId: 'request-1' } as AppRequest;
const previousBaseUrl = process.env.APP_BASE_URL;

beforeEach(() => { process.env.APP_BASE_URL = 'https://app.example.test'; });
afterEach(() => {
  if (previousBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = previousBaseUrl;
});

describe('StripeCheckoutService', () => {
  it('returns an existing open checkout without creating another Stripe session', async () => {
    const existing = {
      id: 'checkout-existing',
      requestHash: 'same-request',
      status: 'OPEN',
      expiresAt: new Date(Date.now() + 60_000),
      providerSessionId: 'cs_existing',
      providerCheckoutUrl: 'https://checkout.stripe.com/c/existing'
    };
    const { service, retrieve, create } = fixture({ existing });

    await expect(service.create(request, 'user-1', 'member@example.test', 'SUBSCRIPTION', 'STANDARD', null, 'checkout-key', 'same-request')).resolves.toEqual({
      checkoutId: 'checkout-existing',
      checkoutUrl: 'https://checkout.stripe.com/c/existing',
      status: 'OPEN'
    });
    expect(retrieve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('marks the reservation failed when the configured Stripe Price does not match', async () => {
    const { service, create, updateMany } = fixture({ stripePrice: { active: true, currency: 'jpy', unit_amount: 1, recurring: null } });

    await expect(service.create(request, 'user-1', 'member@example.test', 'DAY_PASS', 'DAY_PASS', '2027-10-01', 'checkout-key', 'request-hash')).rejects.toMatchObject({ response: { code: 'STRIPE_PRICE_MISMATCH' } });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'checkout-1', status: 'INITIATED' }, data: { status: 'FAILED' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a one-time Checkout Session and records the existing audit boundary', async () => {
    const { service, create, update, audit } = fixture();

    await expect(service.create(request, 'user-1', 'member@example.test', 'DAY_PASS', 'DAY_PASS', '2027-10-01', 'checkout-key', 'request-hash')).resolves.toEqual({
      checkoutId: 'checkout-1',
      checkoutUrl: 'https://checkout.stripe.com/c/pay',
      status: 'OPEN'
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      customer_email: 'member@example.test',
      line_items: [{ price: 'price_day_pass', quantity: 1 }],
      metadata: { checkoutId: 'checkout-1', userId: 'user-1', kind: 'DAY_PASS', planCode: 'DAY_PASS', raceDate: '2027-10-01' },
      success_url: 'https://app.example.test/account?checkout=success',
      cancel_url: 'https://app.example.test/plans?checkout=canceled'
    }), { idempotencyKey: 'checkout-key' });
    expect(update).toHaveBeenCalledWith({ where: { id: 'checkout-1' }, data: expect.objectContaining({ status: 'OPEN', providerSessionId: 'cs_test_1', providerCheckoutUrl: 'https://checkout.stripe.com/c/pay' }) });
    expect(audit).toHaveBeenCalledWith(expect.anything(), request, 'STRIPE_CHECKOUT_CREATED', 'checkout-1', '会員本人による外部決済開始', { kind: 'DAY_PASS', planCode: 'DAY_PASS', amountYen: 980, raceDate: '2027-10-01' }, 'BillingCheckout');
  });
});
