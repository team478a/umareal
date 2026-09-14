ALTER TABLE "users"
  ADD COLUMN "emailDeliveryDisabledAt" TIMESTAMPTZ(3),
  ADD COLUMN "emailDeliveryDisabledReason" TEXT;

ALTER TABLE "system_settings"
  ADD COLUMN "mailWebhookSecretEncrypted" TEXT;

CREATE TABLE "email_webhook_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "providerEventId" TEXT NOT NULL,
  "providerEmailId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "recipientCount" INTEGER NOT NULL,
  "matchedCount" INTEGER NOT NULL,
  "disabledCount" INTEGER NOT NULL,
  "outcome" TEXT NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_webhook_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_webhook_event_provider_id_length" CHECK (length("providerEventId") BETWEEN 1 AND 200),
  CONSTRAINT "email_webhook_email_id_length" CHECK (length("providerEmailId") BETWEEN 1 AND 200),
  CONSTRAINT "email_webhook_event_type_allowed" CHECK ("eventType" IN ('email.bounced', 'email.complained', 'email.suppressed', 'email.failed', 'email.delivery_delayed')),
  CONSTRAINT "email_webhook_event_counts_valid" CHECK ("recipientCount" BETWEEN 1 AND 100 AND "matchedCount" BETWEEN 0 AND "recipientCount" AND "disabledCount" BETWEEN 0 AND "matchedCount"),
  CONSTRAINT "email_webhook_event_outcome_allowed" CHECK ("outcome" IN ('DISABLED', 'ALREADY_DISABLED', 'MATCHED', 'UNMATCHED', 'PARTIAL'))
);

CREATE UNIQUE INDEX "email_webhook_events_providerEventId_key" ON "email_webhook_events"("providerEventId");
CREATE INDEX "email_webhook_events_receivedAt_idx" ON "email_webhook_events"("receivedAt");

CREATE TRIGGER email_webhook_event_no_update_delete BEFORE UPDATE OR DELETE ON "email_webhook_events"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER email_webhook_event_no_truncate BEFORE TRUNCATE ON "email_webhook_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();

ALTER TABLE "users" ADD CONSTRAINT "users_email_delivery_reason_allowed"
  CHECK ("emailDeliveryDisabledReason" IS NULL OR "emailDeliveryDisabledReason" IN ('BOUNCED', 'COMPLAINED', 'SUPPRESSED'));
ALTER TABLE "users" ADD CONSTRAINT "users_email_delivery_block_consistent"
  CHECK (("emailDeliveryDisabledAt" IS NULL) = ("emailDeliveryDisabledReason" IS NULL));
