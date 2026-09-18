import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@keiba/db';
import { loadStripeConfig, resolveStripeConfig } from './stripe-config';

const keys = ['NODE_ENV', 'LAUNCH_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_LIVE_MODE', 'STRIPE_PRICE_FOUNDER', 'STRIPE_PRICE_STANDARD', 'STRIPE_PRICE_DAY_PASS'] as const;
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const db = {
  systemSetting: {
    findUniqueOrThrow: async () => ({
      stripeSecretKeyEncrypted: null,
      stripeWebhookSecretEncrypted: null,
      stripeLiveMode: false,
      stripePriceFounder: null,
      stripePriceStandard: null,
      stripePriceDayPass: null
    })
  }
} as unknown as PrismaClient;

beforeEach(() => {
  process.env.NODE_ENV = 'production';
  process.env.LAUNCH_MODE = 'STRIPE_SANDBOX';
  process.env.STRIPE_SECRET_KEY = 'sk_test_sandbox_secret';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_sandbox_secret';
  process.env.STRIPE_LIVE_MODE = 'false';
  process.env.STRIPE_PRICE_FOUNDER = 'price_founder';
  process.env.STRIPE_PRICE_STANDARD = 'price_standard';
  process.env.STRIPE_PRICE_DAY_PASS = 'price_day_pass';
});

afterEach(() => {
  for (const key of keys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('Stripe runtime configuration', () => {
  it('accepts complete test credentials only in the dedicated production sandbox', async () => {
    await expect(loadStripeConfig(db)).resolves.toMatchObject({ liveMode: false, complete: true, modeConsistent: true, usable: true });
  });

  it('rejects live credentials in the production sandbox', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_production_secret';
    process.env.STRIPE_LIVE_MODE = 'true';
    await expect(loadStripeConfig(db)).resolves.toMatchObject({ liveMode: true, complete: true, modeConsistent: true, usable: false });
  });

  it('rejects test credentials in full production mode', async () => {
    process.env.LAUNCH_MODE = 'FULL';
    await expect(loadStripeConfig(db)).resolves.toMatchObject({ liveMode: false, complete: true, modeConsistent: true, usable: false });
  });

  it('keeps environment fallback when only the displayed live-mode flag was persisted', () => {
    process.env.LAUNCH_MODE = 'FULL';
    process.env.STRIPE_SECRET_KEY = 'sk_live_environment_secret';
    process.env.STRIPE_LIVE_MODE = 'true';
    expect(resolveStripeConfig({
      stripeSecretKeyEncrypted: null,
      stripeWebhookSecretEncrypted: null,
      stripeLiveMode: true,
      stripePriceFounder: null,
      stripePriceStandard: null,
      stripePriceDayPass: null
    })).toMatchObject({ source: 'ENVIRONMENT', liveMode: true, complete: true, modeConsistent: true, runtimeModeAllowed: true, usable: true });
  });
});
