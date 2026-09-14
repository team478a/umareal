import type { PrismaClient } from '@keiba/db';
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
  usable: boolean;
};

function readSecret(value: string | null) {
  if (!value) return null;
  try { return decrypt(value); } catch { return null; }
}

export async function loadStripeConfig(db: PrismaClient): Promise<StripeRuntimeConfig> {
  const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
  const adminSelected = !!(
    settings.stripeSecretKeyEncrypted || settings.stripeWebhookSecretEncrypted || settings.stripeLiveMode ||
    settings.stripePriceFounder || settings.stripePriceStandard || settings.stripePriceDayPass
  );
  const source = adminSelected ? 'ADMIN' as const : 'ENVIRONMENT' as const;
  const secretKey = adminSelected ? readSecret(settings.stripeSecretKeyEncrypted) : process.env.STRIPE_SECRET_KEY || null;
  const webhookSecret = adminSelected ? readSecret(settings.stripeWebhookSecretEncrypted) : process.env.STRIPE_WEBHOOK_SECRET || null;
  const liveMode = adminSelected ? settings.stripeLiveMode : process.env.STRIPE_LIVE_MODE === 'true';
  const priceFounder = adminSelected ? settings.stripePriceFounder : process.env.STRIPE_PRICE_FOUNDER || null;
  const priceStandard = adminSelected ? settings.stripePriceStandard : process.env.STRIPE_PRICE_STANDARD || null;
  const priceDayPass = adminSelected ? settings.stripePriceDayPass : process.env.STRIPE_PRICE_DAY_PASS || null;
  const complete = !!secretKey && !!webhookSecret && !!priceFounder && !!priceStandard && !!priceDayPass;
  const modeConsistent = !!secretKey && secretKey.startsWith(liveMode ? 'sk_live_' : 'sk_test_');
  const usable = complete && modeConsistent && (process.env.NODE_ENV !== 'production' || liveMode);
  return { source, secretKey, webhookSecret, liveMode, priceFounder, priceStandard, priceDayPass, complete, modeConsistent, usable };
}
