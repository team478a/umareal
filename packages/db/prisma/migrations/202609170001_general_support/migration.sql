CREATE TABLE "support_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES "users"("id"),
  "category" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_requests_values_check" CHECK (
    "category" IN ('ACCOUNT','NOTIFICATION','CONTENT','TECHNICAL','SERVICE','OTHER') AND
    "status" IN ('OPEN','IN_PROGRESS','RESOLVED') AND
    char_length("subject") BETWEEN 5 AND 120 AND
    char_length("message") BETWEEN 10 AND 4000
  )
);
CREATE INDEX "support_requests_userId_createdAt_idx" ON "support_requests"("userId", "createdAt");
CREATE INDEX "support_requests_status_createdAt_idx" ON "support_requests"("status", "createdAt");

CREATE TABLE "support_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "requestId" UUID NOT NULL REFERENCES "support_requests"("id"),
  "eventType" TEXT NOT NULL,
  "actorId" UUID NOT NULL REFERENCES "users"("id"),
  "actorRole" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "publicMessage" TEXT,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_events_values_check" CHECK (
    "eventType" IN ('CREATED','IN_PROGRESS','RESOLVED','REOPENED') AND
    "actorRole" IN ('MEMBER','OPERATOR','ADMIN') AND
    char_length("reason") BETWEEN 1 AND 2000 AND
    ("publicMessage" IS NULL OR char_length("publicMessage") BETWEEN 1 AND 2000) AND
    (("eventType" = 'RESOLVED' AND "publicMessage" IS NOT NULL) OR ("eventType" <> 'RESOLVED' AND "publicMessage" IS NULL))
  )
);
CREATE INDEX "support_events_requestId_occurredAt_idx" ON "support_events"("requestId", "occurredAt");

CREATE OR REPLACE FUNCTION protect_support_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'support requests cannot be deleted'; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId" OR
     NEW."category" IS DISTINCT FROM OLD."category" OR NEW."subject" IS DISTINCT FROM OLD."subject" OR
     NEW."message" IS DISTINCT FROM OLD."message" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'support request content is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "support_requests_guard" BEFORE UPDATE OR DELETE ON "support_requests" FOR EACH ROW EXECUTE FUNCTION protect_support_request();
CREATE TRIGGER "support_requests_no_truncate" BEFORE TRUNCATE ON "support_requests" EXECUTE FUNCTION reject_billing_history_truncate();
CREATE TRIGGER "support_events_immutable" BEFORE UPDATE OR DELETE ON "support_events" FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();
CREATE TRIGGER "support_events_no_truncate" BEFORE TRUNCATE ON "support_events" EXECUTE FUNCTION reject_billing_history_truncate();
