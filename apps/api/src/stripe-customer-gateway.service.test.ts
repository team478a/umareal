import { describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { DbService } from './db.service';
import { StripeCustomerGatewayService } from './stripe-customer-gateway.service';

class TestStripeCustomerGatewayService extends StripeCustomerGatewayService {
  constructor(private readonly client: Stripe) { super({} as DbService); }
  protected override async configuredClient() { return this.client; }
}

function service(client: object) {
  return new TestStripeCustomerGatewayService(client as Stripe);
}

describe('StripeCustomerGatewayService', () => {
  it('returns the Stripe charge receipt from a checkout payment', async () => {
    const retrieve = vi.fn().mockResolvedValue({ payment_intent: { latest_charge: { receipt_url: 'https://pay.stripe.com/receipts/one' } }, invoice: null });
    const gateway = service({ checkout: { sessions: { retrieve } }, invoices: {} });

    await expect(gateway.receiptUrl('checkout:cs_123')).resolves.toBe('https://pay.stripe.com/receipts/one');
    expect(retrieve).toHaveBeenCalledWith('cs_123', { expand: ['payment_intent.latest_charge', 'invoice'] });
  });

  it('returns the hosted invoice URL for a recurring payment', async () => {
    const retrieve = vi.fn().mockResolvedValue({ hosted_invoice_url: 'https://invoice.stripe.com/i/acct_123/test' });
    const gateway = service({ checkout: { sessions: {} }, invoices: { retrieve } });

    await expect(gateway.receiptUrl('invoice:in_123:paid')).resolves.toBe('https://invoice.stripe.com/i/acct_123/test');
    expect(retrieve).toHaveBeenCalledWith('in_123');
  });

  it('preserves the not-ready response when Stripe has no receipt URL', async () => {
    const gateway = service({ checkout: { sessions: { retrieve: vi.fn().mockResolvedValue({ payment_intent: null, invoice: null }) } }, invoices: {} });
    await expect(gateway.receiptUrl('review-grant:cs_123')).rejects.toMatchObject({ response: { code: 'RECEIPT_NOT_READY' } });
  });

  it('rejects a receipt URL outside the Stripe HTTPS domains', async () => {
    const gateway = service({ checkout: { sessions: { retrieve: vi.fn().mockResolvedValue({ payment_intent: { latest_charge: { receipt_url: 'https://example.test/receipt' } }, invoice: null }) } }, invoices: {} });
    await expect(gateway.receiptUrl('checkout:cs_123')).rejects.toMatchObject({ response: { code: 'RECEIPT_URL_INVALID' } });
  });

  it('creates a customer portal session and validates its URL', async () => {
    const retrieve = vi.fn().mockResolvedValue({ customer: { id: 'cus_123' } });
    const create = vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/p/session' });
    const gateway = service({ subscriptions: { retrieve }, billingPortal: { sessions: { create } } });

    await expect(gateway.customerPortalUrl('sub_123', 'https://app.example.test/account')).resolves.toBe('https://billing.stripe.com/p/session');
    expect(create).toHaveBeenCalledWith({ customer: 'cus_123', return_url: 'https://app.example.test/account' });
  });

  it('preserves missing customer and portal provider failures', async () => {
    const missing = service({ subscriptions: { retrieve: vi.fn().mockResolvedValue({ customer: null }) }, billingPortal: { sessions: { create: vi.fn() } } });
    await expect(missing.customerPortalUrl('sub_123', 'https://app.example.test/account')).rejects.toMatchObject({ response: { code: 'STRIPE_CUSTOMER_MISSING' } });

    const unavailable = service({ subscriptions: { retrieve: vi.fn().mockResolvedValue({ customer: 'cus_123' }) }, billingPortal: { sessions: { create: vi.fn().mockRejectedValue(new Error('provider unavailable')) } } });
    await expect(unavailable.customerPortalUrl('sub_123', 'https://app.example.test/account')).rejects.toMatchObject({ response: { code: 'STRIPE_PORTAL_UNAVAILABLE' } });
  });

  it('rejects a customer portal URL outside the Stripe HTTPS domains', async () => {
    const gateway = service({ subscriptions: { retrieve: vi.fn().mockResolvedValue({ customer: 'cus_123' }) }, billingPortal: { sessions: { create: vi.fn().mockResolvedValue({ url: 'https://example.test/portal' }) } } });
    await expect(gateway.customerPortalUrl('sub_123', 'https://app.example.test/account')).rejects.toMatchObject({ response: { code: 'STRIPE_PORTAL_URL_INVALID' } });
  });
});
