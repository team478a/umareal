import type { PrismaClient, SystemSetting } from '@keiba/db';
import { resolveLaunchMode, stripeRuntimeModeAllowed } from '@keiba/domain';
import { decrypt } from './security';

export type StripeRuntimeConfig = {
  source: 'ADMIN' | 'ENVIRONMENT';
  secretKey: string | null;
  webhookSecret: string | null;
  liveMode: boolean;
  priceFounder: string | null;
  priceStandard: string | null;
  priceDayPass: string | null;
  complete: boolean;
  modeConsistent: boolean;
  runtimeModeAllowed: boolean;
  usable: boolean;
};

function readSecret(value: string | null) {
  if (!value) return null;
  try { return decrypt(value); } catch { return null; }
}

type StoredStripeConfig = Pick<SystemSetting,
  'stripeSecretKeyEncrypted' | 'stripeWebhookSecretEncrypted' | 'stripeLiveMode' |
  'stripePriceFounder' | 'stripePriceStandard' | 'stripePriceDayPass'>;

type StripeEnvironment = {
  NODE_ENV?: string;
  LAUNCH_MODE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_LIVE_MODE?: string;
  STRIPE_PRICE_FOUNDER?: string;
  STRIPE_PRICE_STANDARD?: string;
  STRIPE_PRICE_DAY_PASS?: string;
};

export function resolveStripeConfig(settings: StoredStripeConfig, environment: StripeEnvironment = process.env): StripeRuntimeConfig {
  // The mode flag alone must not select administrator settings. The settings form
  // displays the effective environment mode, so an unrelated save may persist it.
  const adminSelected = !!(
    settings.stripeSecretKeyEncrypted || settings.stripeWebhookSecretEncrypted ||
    settings.stripePriceFounder || settings.stripePriceStandard || settings.stripePriceDayPass
  );
  const source = adminSelected ? 'ADMIN' as const : 'ENVIRONMENT' as const;
  const secretKey = adminSelected ? readSecret(settings.stripeSecretKeyEncrypted) : environment.STRIPE_SECRET_KEY || null;
  const webhookSecret = adminSelected ? readSecret(settings.stripeWebhookSecretEncrypted) : environment.STRIPE_WEBHOOK_SECRET || null;
  const liveMode = adminSelected ? settings.stripeLiveMode : environment.STRIPE_LIVE_MODE === 'true';
  const priceFounder = adminSelected ? settings.stripePriceFounder : environment.STRIPE_PRICE_FOUNDER || null;
  const priceStandard = adminSelected ? settings.stripePriceStandard : environment.STRIPE_PRICE_STANDARD || null;
  const priceDayPass = adminSelected ? settings.stripePriceDayPass : environment.STRIPE_PRICE_DAY_PASS || null;
  const complete = !!secretKey && !!webhookSecret && !!priceFounder && !!priceStandard && !!priceDayPass;
  const modeConsistent = !!secretKey && secretKey.startsWith(liveMode ? 'sk_live_' : 'sk_test_');
  const runtimeModeAllowed = stripeRuntimeModeAllowed(environment.NODE_ENV, resolveLaunchMode(environment.LAUNCH_MODE), liveMode);
  const usable = complete && modeConsistent && runtimeModeAllowed;
  return { source, secretKey, webhookSecret, liveMode, priceFounder, priceStandard, priceDayPass, complete, modeConsistent, runtimeModeAllowed, usable };
}

export async function loadStripeConfig(db: PrismaClient): Promise<StripeRuntimeConfig> {
  const settings = await db.systemSetting.findUniqueOrThrow({
    where: { id: 'global' },
    select: {
      stripeSecretKeyEncrypted: true, stripeWebhookSecretEncrypted: true, stripeLiveMode: true,
      stripePriceFounder: true, stripePriceStandard: true, stripePriceDayPass: true
    }
  });
  return resolveStripeConfig(settings);
}
