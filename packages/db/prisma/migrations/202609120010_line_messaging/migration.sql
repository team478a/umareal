ALTER TABLE "line_accounts"
  ADD COLUMN "notificationDisabledAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastWebhookAt" TIMESTAMPTZ(3);

CREATE TABLE "line_webhook_events" (
  "id" UUID PRIMARY KEY,
  "webhookEventId" TEXT NOT NULL UNIQUE,
  "eventType" TEXT NOT NULL,
  "subjectHash" TEXT,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('MATCHED','UNMATCHED','IGNORED')),
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "line_webhook_events_receivedAt_idx" ON "line_webhook_events"("receivedAt");

CREATE TRIGGER line_webhook_event_no_update_delete BEFORE UPDATE OR DELETE ON "line_webhook_events"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER line_webhook_event_no_truncate BEFORE TRUNCATE ON "line_webhook_events"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
