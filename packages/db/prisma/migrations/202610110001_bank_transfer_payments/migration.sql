ALTER TABLE "system_settings"
  ADD COLUMN "bankTransferEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bankTransferBankName" TEXT,
  ADD COLUMN "bankTransferBranchName" TEXT,
  ADD COLUMN "bankTransferAccountType" TEXT,
  ADD COLUMN "bankTransferAccountNumber" TEXT,
  ADD COLUMN "bankTransferAccountHolder" TEXT,
  ADD COLUMN "bankTransferInstructions" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "bankTransferRequestValidityDays" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "bankTransferMonthlyAccessDays" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_bank_transfer_check" CHECK (
  "bankTransferRequestValidityDays" BETWEEN 1 AND 30 AND
  "bankTransferMonthlyAccessDays" BETWEEN 1 AND 366 AND
  length("bankTransferInstructions") <= 1000 AND
  (
    NOT "bankTransferEnabled" OR
    (
      length(trim(coalesce("bankTransferBankName", ''))) BETWEEN 1 AND 100 AND
      length(trim(coalesce("bankTransferBranchName", ''))) BETWEEN 1 AND 100 AND
      "bankTransferAccountType" IN ('普通', '当座') AND
      "bankTransferAccountNumber" ~ '^[0-9]{1,12}$' AND
      length(trim(coalesce("bankTransferAccountHolder", ''))) BETWEEN 1 AND 100
    )
  )
);

CREATE TABLE "bank_transfer_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "kind" TEXT NOT NULL,
  "planCode" TEXT NOT NULL,
  "raceDate" TEXT,
  "amountYen" INTEGER NOT NULL,
  "referenceCode" TEXT NOT NULL UNIQUE,
  "bankAccountSnapshot" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AWAITING_TRANSFER',
  "payerName" TEXT,
  "reportedAt" TIMESTAMPTZ(3),
  "receivedAt" TIMESTAMPTZ(3),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "confirmedAt" TIMESTAMPTZ(3),
  "rejectedAt" TIMESTAMPTZ(3),
  "reviewedById" UUID REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "reviewReason" TEXT,
  "entitlementId" UUID UNIQUE REFERENCES "entitlements"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "dayPassId" UUID UNIQUE REFERENCES "day_passes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "requestHash" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_transfer_requests_values_check" CHECK (
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
      ("status" IN ('REJECTED','CANCELLED') AND "receivedAt" IS NULL AND "confirmedAt" IS NULL AND "entitlementId" IS NULL AND "dayPassId" IS NULL)
    )
  )
);

CREATE INDEX "bank_transfer_requests_userId_status_createdAt_idx" ON "bank_transfer_requests"("userId", "status", "createdAt");
CREATE INDEX "bank_transfer_requests_status_reportedAt_idx" ON "bank_transfer_requests"("status", "reportedAt");

ALTER TABLE "payment_transactions" ADD COLUMN "bankTransferRequestId" UUID UNIQUE REFERENCES "bank_transfer_requests"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "billing_events" ADD COLUMN "bankTransferRequestId" UUID REFERENCES "bank_transfer_requests"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "billing_events" DROP CONSTRAINT "billing_events_target_check";
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_target_check" CHECK (
  (("subscriptionId" IS NOT NULL)::int + ("dayPassId" IS NOT NULL)::int + ("billingCheckoutId" IS NOT NULL)::int + ("bankTransferRequestId" IS NOT NULL)::int) = 1
);
CREATE INDEX "billing_events_bankTransferRequestId_idx" ON "billing_events"("bankTransferRequestId");
ALTER TABLE "payment_transactions" DROP CONSTRAINT "payment_transactions_values_check";
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_values_check" CHECK (
  "kind" IN ('SUBSCRIPTION','DAY_PASS') AND
  "status" IN ('SUCCEEDED','FAILED','REFUNDED','REQUIRES_REVIEW') AND
  "amountYen" >= 0 AND
  (
    (
      "status" = 'REQUIRES_REVIEW' AND
      "subscriptionId" IS NULL AND "dayPassId" IS NULL AND
      "billingCheckoutId" IS NOT NULL AND "bankTransferRequestId" IS NULL
    ) OR
    (
      "status" <> 'REQUIRES_REVIEW' AND
      (("subscriptionId" IS NOT NULL)::int + ("dayPassId" IS NOT NULL)::int + ("billingCheckoutId" IS NOT NULL)::int + ("bankTransferRequestId" IS NOT NULL)::int = 1)
    )
  )
);

CREATE OR REPLACE FUNCTION reject_terminal_bank_transfer_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('CONFIRMED','REJECTED','CANCELLED') THEN
    RAISE EXCEPTION 'terminal bank transfer request is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "bank_transfer_requests_terminal_immutable" BEFORE UPDATE OR DELETE ON "bank_transfer_requests" FOR EACH ROW EXECUTE FUNCTION reject_terminal_bank_transfer_mutation();

CREATE OR REPLACE FUNCTION reject_bank_transfer_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'bank transfer history cannot be truncated'; END $$;
CREATE TRIGGER "bank_transfer_requests_no_truncate" BEFORE TRUNCATE ON "bank_transfer_requests" EXECUTE FUNCTION reject_bank_transfer_truncate();
