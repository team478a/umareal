ALTER TABLE "system_settings"
  ADD COLUMN "founderSalesEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "founderPriceYen" INTEGER NOT NULL DEFAULT 1980,
  ADD COLUMN "standardPriceYen" INTEGER NOT NULL DEFAULT 2980,
  ADD COLUMN "dayPassPriceYen" INTEGER NOT NULL DEFAULT 980,
  ADD COLUMN "founderSalesLimit" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "billingGraceDays" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_billing_values_check" CHECK (
  "founderPriceYen" BETWEEN 0 AND 1000000 AND "standardPriceYen" BETWEEN 0 AND 1000000 AND
  "dayPassPriceYen" BETWEEN 0 AND 1000000 AND "founderSalesLimit" BETWEEN 1 AND 100000 AND
  "billingGraceDays" BETWEEN 0 AND 30
);

CREATE TABLE "subscriptions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "userId" UUID NOT NULL REFERENCES "users"("id"),
  "planCode" TEXT NOT NULL, "status" TEXT NOT NULL, "priceYen" INTEGER NOT NULL,
  "currentPeriodStartsAt" TIMESTAMPTZ(3) NOT NULL, "currentPeriodEndsAt" TIMESTAMPTZ(3) NOT NULL,
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false, "canceledAt" TIMESTAMPTZ(3), "graceEndsAt" TIMESTAMPTZ(3),
  "provider" TEXT NOT NULL, "providerSubscriptionId" TEXT NOT NULL UNIQUE,
  "entitlementId" UUID NOT NULL UNIQUE REFERENCES "entitlements"("id"),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subscriptions_values_check" CHECK ("planCode" IN ('FOUNDER','STANDARD') AND "status" IN ('TRIALING','ACTIVE','PAST_DUE','CANCELED','EXPIRED') AND "priceYen" >= 0 AND "currentPeriodEndsAt" > "currentPeriodStartsAt")
);
CREATE INDEX "subscriptions_userId_status_idx" ON "subscriptions"("userId", "status");
CREATE UNIQUE INDEX "subscriptions_one_open_per_user" ON "subscriptions"("userId") WHERE "status" IN ('TRIALING','ACTIVE','PAST_DUE');

CREATE TABLE "day_passes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "userId" UUID NOT NULL REFERENCES "users"("id"),
  "raceDate" TEXT NOT NULL, "status" TEXT NOT NULL, "priceYen" INTEGER NOT NULL,
  "startsAt" TIMESTAMPTZ(3) NOT NULL, "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "provider" TEXT NOT NULL, "providerPassId" TEXT NOT NULL UNIQUE,
  "entitlementId" UUID NOT NULL UNIQUE REFERENCES "entitlements"("id"),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "day_passes_values_check" CHECK ("raceDate" ~ '^\\d{4}-\\d{2}-\\d{2}$' AND "status" IN ('PENDING','ACTIVE','USED','EXPIRED','REFUNDED') AND "priceYen" >= 0 AND "endsAt" > "startsAt"),
  UNIQUE ("userId", "raceDate")
);
CREATE INDEX "day_passes_status_endsAt_idx" ON "day_passes"("status", "endsAt");

CREATE TABLE "payment_transactions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "userId" UUID NOT NULL REFERENCES "users"("id"),
  "provider" TEXT NOT NULL, "providerPaymentId" TEXT NOT NULL UNIQUE, "kind" TEXT NOT NULL, "status" TEXT NOT NULL,
  "amountYen" INTEGER NOT NULL, "subscriptionId" UUID REFERENCES "subscriptions"("id"), "dayPassId" UUID REFERENCES "day_passes"("id"),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  CONSTRAINT "payment_transactions_values_check" CHECK ("kind" IN ('SUBSCRIPTION','DAY_PASS') AND "status" IN ('SUCCEEDED','FAILED','REFUNDED') AND "amountYen" >= 0 AND (("subscriptionId" IS NOT NULL)::int + ("dayPassId" IS NOT NULL)::int = 1))
);
CREATE INDEX "payment_transactions_userId_occurredAt_idx" ON "payment_transactions"("userId", "occurredAt");

CREATE TABLE "billing_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "userId" UUID NOT NULL REFERENCES "users"("id"), "eventType" TEXT NOT NULL,
  "subscriptionId" UUID REFERENCES "subscriptions"("id"), "dayPassId" UUID REFERENCES "day_passes"("id"),
  "details" JSONB NOT NULL, "actorId" UUID NOT NULL, "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_events_target_check" CHECK ((("subscriptionId" IS NOT NULL)::int + ("dayPassId" IS NOT NULL)::int) = 1)
);
CREATE INDEX "billing_events_userId_occurredAt_idx" ON "billing_events"("userId", "occurredAt");

CREATE OR REPLACE FUNCTION reject_billing_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'billing history is append-only'; END $$;
CREATE TRIGGER "payment_transactions_immutable" BEFORE UPDATE OR DELETE ON "payment_transactions" FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();
CREATE TRIGGER "billing_events_immutable" BEFORE UPDATE OR DELETE ON "billing_events" FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();

CREATE OR REPLACE FUNCTION reject_billing_history_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'billing history cannot be truncated'; END $$;
CREATE TRIGGER "payment_transactions_no_truncate" BEFORE TRUNCATE ON "payment_transactions" EXECUTE FUNCTION reject_billing_history_truncate();
CREATE TRIGGER "billing_events_no_truncate" BEFORE TRUNCATE ON "billing_events" EXECUTE FUNCTION reject_billing_history_truncate();
