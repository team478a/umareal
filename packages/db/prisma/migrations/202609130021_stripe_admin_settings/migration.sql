ALTER TABLE "system_settings"
  ADD COLUMN "stripeSecretKeyEncrypted" TEXT,
  ADD COLUMN "stripeWebhookSecretEncrypted" TEXT,
  ADD COLUMN "stripeLiveMode" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stripePriceFounder" TEXT,
  ADD COLUMN "stripePriceStandard" TEXT,
  ADD COLUMN "stripePriceDayPass" TEXT;

ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_stripe_values_check" CHECK (
  ("stripePriceFounder" IS NULL OR "stripePriceFounder" ~ '^price_[A-Za-z0-9]+$') AND
  ("stripePriceStandard" IS NULL OR "stripePriceStandard" ~ '^price_[A-Za-z0-9]+$') AND
  ("stripePriceDayPass" IS NULL OR "stripePriceDayPass" ~ '^price_[A-Za-z0-9]+$') AND
  (NOT "stripeLiveMode" OR (
    "stripeSecretKeyEncrypted" IS NOT NULL AND "stripeWebhookSecretEncrypted" IS NOT NULL AND
    "stripePriceFounder" IS NOT NULL AND "stripePriceStandard" IS NOT NULL AND "stripePriceDayPass" IS NOT NULL
  ))
);
