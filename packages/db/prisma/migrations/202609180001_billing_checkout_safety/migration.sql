ALTER TABLE "billing_checkouts" DROP CONSTRAINT "billing_checkouts_values_check";
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_values_check" CHECK (
  "kind" IN ('SUBSCRIPTION','DAY_PASS') AND "planCode" IN ('FOUNDER','STANDARD','DAY_PASS') AND
  "status" IN ('INITIATED','OPEN','COMPLETED','EXPIRED','FAILED','REJECTED_ACCOUNT_STATE','REJECTED_EXISTING_ACCESS','REJECTED_FOUNDER_LIMIT') AND
  "amountYen" >= 0 AND "expiresAt" > "createdAt" AND
  (("kind" = 'DAY_PASS' AND "raceDate" ~ '^\\d{4}-\\d{2}-\\d{2}$') OR ("kind" = 'SUBSCRIPTION' AND "raceDate" IS NULL))
);

ALTER TABLE "payment_transactions" DROP CONSTRAINT "payment_transactions_values_check";
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_values_check" CHECK (
  "kind" IN ('SUBSCRIPTION','DAY_PASS') AND
  "status" IN ('SUCCEEDED','FAILED','REFUNDED','REQUIRES_REVIEW') AND
  "amountYen" >= 0 AND
  (
    ("status" = 'REQUIRES_REVIEW' AND "subscriptionId" IS NULL AND "dayPassId" IS NULL) OR
    ("status" <> 'REQUIRES_REVIEW' AND (("subscriptionId" IS NOT NULL)::int + ("dayPassId" IS NOT NULL)::int = 1))
  )
);
