import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingController } from './billing.controller';
import { AuthController } from './auth.controller';
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
const previousNotificationTransport = process.env.NOTIFICATION_TRANSPORT;
const previousAuthProvider = process.env.AUTH_PROVIDER;
afterEach(() => {
  if (previousMode === undefined) delete process.env.LAUNCH_MODE;
  else process.env.LAUNCH_MODE = previousMode;
  if (previousBillingTransport === undefined) delete process.env.BILLING_TRANSPORT;
  else process.env.BILLING_TRANSPORT = previousBillingTransport;
  if (previousNotificationTransport === undefined) delete process.env.NOTIFICATION_TRANSPORT;
  else process.env.NOTIFICATION_TRANSPORT = previousNotificationTransport;
  if (previousAuthProvider === undefined) delete process.env.AUTH_PROVIDER;
  else process.env.AUTH_PROVIDER = previousAuthProvider;
});

describe('free registration launch API boundaries', () => {
  it.each([['line', true, true], ['test', true, true], ['disabled', true, false], ['line', false, false]])('reports effective LINE availability for %s / enabled=%s', async (transport, enabled, available) => {
    process.env.LAUNCH_MODE = 'FREE_REGISTRATION';
    process.env.AUTH_PROVIDER = 'local';
    process.env.NOTIFICATION_TRANSPORT = String(transport);
    const auth = { db: { systemSetting: { findUnique: async () => ({ emailNotificationsEnabled: true, lineLoginEnabled: true, lineNotificationsEnabled: enabled }) } }, registrationAvailability: async () => ({ enabled: true, message: '' }) };
    const captcha = { publicConfig: async () => ({ enabled: false, siteKey: null, mode: 'TEST_ONLY' }) };
    const controller = new AuthController(auth as never, captcha as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    expect(await controller.config()).toMatchObject({ capabilities: { lineNotifications: true, billing: false }, lineEnabled: true, lineNotificationsEnabled: available });
  });
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

  it('permits LINE Login in free registration mode independently of billing', async () => {
    process.env.LAUNCH_MODE = 'FREE_REGISTRATION';
    const start = vi.fn().mockResolvedValue({ authorizationUrl: 'https://access.line.me/example', expiresAt: new Date() });
    const controller = new LineLoginController({} as AuthService, { start } as unknown as LineLoginService, {} as never, {} as never);
    await expect(controller.start({ purpose: 'LOGIN' }, {} as never)).resolves.toMatchObject({ authorizationUrl: 'https://access.line.me/example' });
    expect(start).toHaveBeenCalledOnce();
  });

  it('permits signed LINE webhook processing in free registration mode', async () => {
    process.env.LAUNCH_MODE = 'FREE_REGISTRATION';
    const controller = new LineWebhookController({} as AuthService);
    await expect(controller.receive({} as never)).rejects.toMatchObject({ response: { code: 'LINE_RAW_BODY_REQUIRED' } });
  });

  it('rejects LINE webhooks in isolated cloud test modes before reading credentials or request bodies', async () => {
    process.env.LAUNCH_MODE = 'CLOUD_STAGING';
    const controller = new LineWebhookController({} as AuthService);
    await expect(controller.receive({} as never)).rejects.toMatchObject({ response: { code: 'LINE_WEBHOOK_NOT_IN_LAUNCH' } });
  });
});
