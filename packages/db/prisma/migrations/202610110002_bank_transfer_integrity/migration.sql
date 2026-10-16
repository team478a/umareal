ALTER TABLE "bank_transfer_requests" DROP CONSTRAINT "bank_transfer_requests_values_check";
ALTER TABLE "bank_transfer_requests" ADD CONSTRAINT "bank_transfer_requests_values_check" CHECK (
  "kind" IN ('SUBSCRIPTION','DAY_PASS') AND
  "planCode" IN ('FOUNDER','STANDARD','DAY_PASS') AND
  "status" IN ('AWAITING_TRANSFER','TRANSFER_REPORTED','CONFIRMED','REJECTED','CANCELLED') AND
  "amountYen" > 0 AND
  "referenceCode" ~ '^UM-[A-Z0-9]{10}$' AND
  "expiresAt" > "createdAt" AND
  ("payerName" IS NULL OR length(trim("payerName")) BETWEEN 1 AND 100) AND
  ("reviewReason" IS NULL OR length(trim("reviewReason")) BETWEEN 1 AND 500) AND
  (
    ("kind" = 'DAY_PASS' AND "planCode" = 'DAY_PASS' AND "raceDate" ~ '^\d{4}-\d{2}-\d{2}$') OR
    ("kind" = 'SUBSCRIPTION' AND "planCode" IN ('FOUNDER','STANDARD') AND "raceDate" IS NULL)
  ) AND
  (
    ("status" IN ('AWAITING_TRANSFER','TRANSFER_REPORTED') AND "receivedAt" IS NULL AND "confirmedAt" IS NULL AND "rejectedAt" IS NULL AND "reviewedById" IS NULL AND "reviewReason" IS NULL AND "entitlementId" IS NULL AND "dayPassId" IS NULL) OR
    ("status" = 'CONFIRMED' AND "receivedAt" IS NOT NULL AND "confirmedAt" IS NOT NULL AND "rejectedAt" IS NULL AND "reviewedById" IS NOT NULL AND "reviewReason" IS NOT NULL AND (("kind" = 'SUBSCRIPTION' AND "entitlementId" IS NOT NULL AND "dayPassId" IS NULL) OR ("kind" = 'DAY_PASS' AND "dayPassId" IS NOT NULL AND "entitlementId" IS NULL))) OR
    ("status" = 'REJECTED' AND "receivedAt" IS NULL AND "confirmedAt" IS NULL AND "rejectedAt" IS NOT NULL AND "reviewedById" IS NOT NULL AND "reviewReason" IS NOT NULL AND "entitlementId" IS NULL AND "dayPassId" IS NULL) OR
    ("status" = 'CANCELLED' AND "receivedAt" IS NULL AND "confirmedAt" IS NULL AND "rejectedAt" IS NULL AND "reviewedById" IS NULL AND "reviewReason" IS NULL AND "entitlementId" IS NULL AND "dayPassId" IS NULL)
  )
);

CREATE OR REPLACE FUNCTION enforce_billing_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_tx BIGINT; source_type TEXT; expected_type TEXT;
BEGIN
  IF NEW."billingEventId" IS NULL THEN RETURN NEW; END IF;
  SELECT "createdTxId", "eventType" INTO source_tx, source_type FROM "billing_events" WHERE "id" = NEW."billingEventId";
  IF source_tx IS NULL OR source_tx <> txid_current() THEN
    RAISE EXCEPTION 'Billing notification must be created in the billing event transaction';
  END IF;
  expected_type := CASE source_type
    WHEN 'SUBSCRIPTION_STARTED' THEN 'BILLING_PAYMENT_SUCCEEDED'
    WHEN 'SUBSCRIPTION_RENEWED' THEN 'BILLING_PAYMENT_SUCCEEDED'
    WHEN 'BANK_TRANSFER_ACCESS_STARTED' THEN 'BILLING_PAYMENT_SUCCEEDED'
    WHEN 'DAY_PASS_PENDING' THEN 'BILLING_PAYMENT_SUCCEEDED'
    WHEN 'DAY_PASS_STARTED' THEN 'BILLING_PAYMENT_SUCCEEDED'
    WHEN 'PAYMENT_FAILED' THEN 'BILLING_PAYMENT_FAILED'
    WHEN 'PAYMENT_RECOVERED' THEN 'BILLING_PAYMENT_RECOVERED'
    WHEN 'CANCELLATION_SCHEDULED' THEN 'BILLING_CANCELLATION_SCHEDULED'
    WHEN 'CANCELLATION_REVERSED' THEN 'BILLING_CANCELLATION_REVERSED'
    WHEN 'SUBSCRIPTION_ENDED' THEN 'BILLING_SUBSCRIPTION_ENDED'
    WHEN 'DAY_PASS_REFUNDED' THEN 'BILLING_REFUND_COMPLETED'
    WHEN 'SUBSCRIPTION_PAYMENT_REFUNDED' THEN 'BILLING_REFUND_COMPLETED'
    WHEN 'CHECKOUT_PAYMENT_REFUNDED' THEN 'BILLING_REFUND_COMPLETED'
    ELSE NULL
  END;
  IF expected_type IS NULL OR NEW."eventType" <> expected_type THEN
    RAISE EXCEPTION 'Billing notification type is invalid';
  END IF;
  RETURN NEW;
END; $$;
