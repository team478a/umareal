import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingController } from './billing.controller';
import { LineLoginController } from './line-login.controller';
import { LineWebhookController } from './line-webhook.controller';
import type { AuthService } from './auth.service';
import type { LineLoginService } from './line-login.service';
import type { StripeCustomerGatewayService } from './stripe-customer-gateway.service';
import type { StripeWebhookService } from './stripe-webhook.service';
import type { StripeCheckoutService } from './stripe-checkout.service';
import type { BillingSubscriptionLifecycleService } from './billing-subscription-lifecycle.service';
import type { BillingAdminResolutionService } from './billing-admin-resolution.service';
import type { BillingSupportService } from './billing-support.service';
import type { BillingLocalSimulationService } from './billing-local-simulation.service';
import type { BillingQueryService } from './billing-query.service';

const previousMode = process.env.LAUNCH_MODE;
const previousBillingTransport = process.env.BILLING_TRANSPORT;
afterEach(() => {
  if (previousMode === undefined) delete process.env.LAUNCH_MODE;
  else process.env.LAUNCH_MODE = previousMode;
  if (previousBillingTransport === undefined) delete process.env.BILLING_TRANSPORT;
  else process.env.BILLING_TRANSPORT = previousBillingTransport;
});

describe('free registration launch API boundaries', () => {
  it('rejects billing mutations before authentication or provider access', async () => {
    process.env.LAUNCH_MODE = 'FREE_REGISTRATION';
    const controller = new BillingController({} as AuthService, {} as StripeCustomerGatewayService, {} as StripeWebhookService, {} as StripeCheckoutService, {} as BillingSubscriptionLifecycleService, {} as BillingAdminResolutionService, {} as BillingSupportService, {} as BillingLocalSimulationService, {} as BillingQueryService);
    await expect(controller.checkout({} as never, {})).rejects.toMatchObject({ response: { code: 'BILLING_NOT_IN_LAUNCH' } });
  });

  it('permits the no-charge billing transport in cloud staging', async () => {
    process.env.LAUNCH_MODE = 'CLOUD_STAGING';
    process.env.BILLING_TRANSPORT = 'test';
    const authenticate = vi.fn().mockRejectedValue(new Error('AUTH_REACHED'));
    const controller = new BillingController({ authenticate } as unknown as AuthService, {} as StripeCustomerGatewayService, {} as StripeWebhookService, {} as StripeCheckoutService, {} as BillingSubscriptionLifecycleService, {} as BillingAdminResolutionService, {} as BillingSupportService, {} as BillingLocalSimulationService, {} as BillingQueryService);
    await expect(controller.checkout({} as never, {})).rejects.toThrow('AUTH_REACHED');
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it('permits Stripe checkout routing in the dedicated sandbox', async () => {
    process.env.LAUNCH_MODE = 'STRIPE_SANDBOX';
    process.env.BILLING_TRANSPORT = 'stripe';
    const authenticate = vi.fn().mockRejectedValue(new Error('AUTH_REACHED'));
    const controller = new BillingController({ authenticate } as unknown as AuthService, {} as StripeCustomerGatewayService, {} as StripeWebhookService, {} as StripeCheckoutService, {} as BillingSubscriptionLifecycleService, {} as BillingAdminResolutionService, {} as BillingSupportService, {} as BillingLocalSimulationService, {} as BillingQueryService);
    await expect(controller.checkout({} as never, {})).rejects.toThrow('AUTH_REACHED');
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it('permits LINE Login in free registration mode without enabling LINE notifications', async () => {
    process.env.LAUNCH_MODE = 'FREE_REGISTRATION';
    const start = vi.fn().mockResolvedValue({ authorizationUrl: 'https://access.line.me/example', expiresAt: new Date() });
    const controller = new LineLoginController({} as AuthService, { start } as unknown as LineLoginService, {} as never, {} as never);
    await expect(controller.start({ purpose: 'LOGIN' }, {} as never)).resolves.toMatchObject({ authorizationUrl: 'https://access.line.me/example' });
    expect(start).toHaveBeenCalledOnce();
  });

  it('rejects LINE webhooks before reading credentials or request bodies', async () => {
    process.env.LAUNCH_MODE = 'FREE_REGISTRATION';
    const controller = new LineWebhookController({} as AuthService);
    await expect(controller.receive({} as never)).rejects.toMatchObject({ response: { code: 'LINE_WEBHOOK_NOT_IN_LAUNCH' } });
  });
});
