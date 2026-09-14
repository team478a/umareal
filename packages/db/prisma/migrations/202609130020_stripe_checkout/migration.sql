CREATE TABLE "billing_checkouts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "userId" UUID NOT NULL REFERENCES "users"("id"),
  "kind" TEXT NOT NULL, "planCode" TEXT NOT NULL, "raceDate" TEXT, "amountYen" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'INITIATED', "idempotencyKey" TEXT NOT NULL UNIQUE, "requestHash" TEXT NOT NULL,
  "providerSessionId" TEXT UNIQUE, "providerCheckoutUrl" TEXT, "providerSubscriptionId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMPTZ(3) NOT NULL, "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "billing_checkouts_values_check" CHECK (
    "kind" IN ('SUBSCRIPTION','DAY_PASS') AND "planCode" IN ('FOUNDER','STANDARD','DAY_PASS') AND
    "status" IN ('INITIATED','OPEN','COMPLETED','EXPIRED') AND "amountYen" >= 0 AND "expiresAt" > "createdAt" AND
    (("kind" = 'DAY_PASS' AND "raceDate" ~ '^\\d{4}-\\d{2}-\\d{2}$') OR ("kind" = 'SUBSCRIPTION' AND "raceDate" IS NULL))
  )
);
CREATE INDEX "billing_checkouts_userId_status_idx" ON "billing_checkouts"("userId", "status");

CREATE TABLE "stripe_webhook_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "providerEventId" TEXT NOT NULL UNIQUE,
  "eventType" TEXT NOT NULL, "livemode" BOOLEAN NOT NULL, "outcome" TEXT NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "stripe_webhook_events_receivedAt_idx" ON "stripe_webhook_events"("receivedAt");
CREATE TRIGGER "stripe_webhook_events_immutable" BEFORE UPDATE OR DELETE ON "stripe_webhook_events" FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();
CREATE TRIGGER "stripe_webhook_events_no_truncate" BEFORE TRUNCATE ON "stripe_webhook_events" EXECUTE FUNCTION reject_billing_history_truncate();
