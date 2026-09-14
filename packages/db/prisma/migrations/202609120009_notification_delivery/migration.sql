ALTER TABLE "notification_events"
  ADD COLUMN "expandedAt" TIMESTAMPTZ(3),
  ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "notification_deliveries" (
  "id" UUID PRIMARY KEY,
  "eventId" UUID NOT NULL REFERENCES "notification_events"("id"),
  "userId" UUID NOT NULL REFERENCES "users"("id"),
  "channel" TEXT NOT NULL DEFAULT 'LINE' CHECK ("channel" = 'LINE'),
  "status" TEXT NOT NULL DEFAULT 'QUEUED' CHECK ("status" IN ('QUEUED','SENDING','SENT','FAILED','SKIPPED')),
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "attemptCount" INTEGER NOT NULL DEFAULT 0 CHECK ("attemptCount" >= 0),
  "manualRetryCount" INTEGER NOT NULL DEFAULT 0 CHECK ("manualRetryCount" >= 0),
  "forceAttempt" BOOLEAN NOT NULL DEFAULT FALSE,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMPTZ(3),
  "leaseToken" UUID,
  "lastErrorCode" TEXT,
  "sentAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("eventId", "userId", "channel")
);
CREATE INDEX "notification_deliveries_status_nextAttemptAt_idx" ON "notification_deliveries"("status", "nextAttemptAt");

CREATE TABLE "notification_attempts" (
  "id" UUID PRIMARY KEY,
  "deliveryId" UUID NOT NULL REFERENCES "notification_deliveries"("id"),
  "attemptNumber" INTEGER NOT NULL CHECK ("attemptNumber" > 0),
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('SENT','TRANSIENT_FAILURE','PERMANENT_FAILURE','SKIPPED')),
  "errorCode" TEXT,
  "providerMessageId" TEXT,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "finishedAt" TIMESTAMPTZ(3) NOT NULL,
  UNIQUE ("deliveryId", "attemptNumber")
);

CREATE FUNCTION reject_notification_attempt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'notification_attempts is append-only' USING ERRCODE = '42501';
END; $$;
CREATE TRIGGER notification_attempt_no_update_delete BEFORE UPDATE OR DELETE ON "notification_attempts"
  FOR EACH ROW EXECUTE FUNCTION reject_notification_attempt_mutation();
CREATE TRIGGER notification_attempt_no_truncate BEFORE TRUNCATE ON "notification_attempts"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_notification_attempt_mutation();
