CREATE TABLE "billing_support_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES "users"("id"),
  "paymentTransactionId" UUID REFERENCES "payment_transactions"("id"),
  "category" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_support_requests_values_check" CHECK (
    "category" IN ('REFUND','RECEIPT','PAYMENT_FAILURE','CANCELLATION','OTHER') AND
    "status" IN ('OPEN','IN_PROGRESS','RESOLVED') AND
    char_length("message") BETWEEN 10 AND 2000 AND
    ("category" NOT IN ('REFUND','RECEIPT') OR "paymentTransactionId" IS NOT NULL)
  )
);
CREATE INDEX "billing_support_requests_userId_createdAt_idx" ON "billing_support_requests"("userId", "createdAt");
CREATE INDEX "billing_support_requests_status_createdAt_idx" ON "billing_support_requests"("status", "createdAt");

CREATE TABLE "billing_support_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "requestId" UUID NOT NULL REFERENCES "billing_support_requests"("id"),
  "eventType" TEXT NOT NULL,
  "actorId" UUID NOT NULL REFERENCES "users"("id"),
  "actorRole" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_support_events_values_check" CHECK (
    "eventType" IN ('CREATED','IN_PROGRESS','RESOLVED','REOPENED') AND
    "actorRole" IN ('MEMBER','ADMIN') AND
    char_length("reason") BETWEEN 1 AND 2000
  )
);
CREATE INDEX "billing_support_events_requestId_occurredAt_idx" ON "billing_support_events"("requestId", "occurredAt");

CREATE OR REPLACE FUNCTION reject_billing_support_request_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'billing support requests cannot be deleted'; END $$;
CREATE TRIGGER "billing_support_requests_no_delete" BEFORE DELETE ON "billing_support_requests" FOR EACH ROW EXECUTE FUNCTION reject_billing_support_request_delete();
CREATE TRIGGER "billing_support_requests_no_truncate" BEFORE TRUNCATE ON "billing_support_requests" EXECUTE FUNCTION reject_billing_history_truncate();
CREATE TRIGGER "billing_support_events_immutable" BEFORE UPDATE OR DELETE ON "billing_support_events" FOR EACH ROW EXECUTE FUNCTION reject_billing_history_mutation();
CREATE TRIGGER "billing_support_events_no_truncate" BEFORE TRUNCATE ON "billing_support_events" EXECUTE FUNCTION reject_billing_history_truncate();
