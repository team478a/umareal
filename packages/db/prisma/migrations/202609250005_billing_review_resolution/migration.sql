ALTER TABLE "payment_transactions"
  ADD COLUMN "billingCheckoutId" UUID REFERENCES "billing_checkouts"("id");

CREATE INDEX "payment_transactions_billingCheckoutId_idx"
  ON "payment_transactions"("billingCheckoutId");

-- Link pre-existing review records to their immutable checkout source before
-- enforcing the new target rule. No amount, status, or provider identifier is
-- changed by this compatibility backfill.
ALTER TABLE "payment_transactions" DISABLE TRIGGER "payment_transactions_immutable";
UPDATE "payment_transactions" AS payment
SET "billingCheckoutId" = checkout."id"
FROM "billing_checkouts" AS checkout
WHERE payment."status" = 'REQUIRES_REVIEW'
  AND payment."billingCheckoutId" IS NULL
  AND checkout."providerSessionId" IS NOT NULL
  AND payment."providerPaymentId" = 'checkout:' || checkout."providerSessionId";
ALTER TABLE "payment_transactions" ENABLE TRIGGER "payment_transactions_immutable";

ALTER TABLE "billing_checkouts" DROP CONSTRAINT "billing_checkouts_values_check";
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_values_check" CHECK (
  "kind" IN ('SUBSCRIPTION','DAY_PASS') AND "planCode" IN ('FOUNDER','STANDARD','DAY_PASS') AND
  "status" IN (
    'INITIATED','OPEN','COMPLETED','EXPIRED','FAILED',
    'REJECTED_ACCOUNT_STATE','REJECTED_EXISTING_ACCESS','REJECTED_FOUNDER_LIMIT',
    'REVIEW_REFUNDING','REVIEW_REFUNDED','REVIEW_ACCESS_GRANTED'
  ) AND
  "amountYen" >= 0 AND "expiresAt" > "createdAt" AND
  (("kind" = 'DAY_PASS' AND "raceDate" ~ '^\d{4}-\d{2}-\d{2}$') OR ("kind" = 'SUBSCRIPTION' AND "raceDate" IS NULL))
);

ALTER TABLE "payment_transactions" DROP CONSTRAINT "payment_transactions_values_check";
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_values_check" CHECK (
  "kind" IN ('SUBSCRIPTION','DAY_PASS') AND
  "status" IN ('SUCCEEDED','FAILED','REFUNDED','REQUIRES_REVIEW') AND
  "amountYen" >= 0 AND
  (
    (
      "status" = 'REQUIRES_REVIEW' AND
      "subscriptionId" IS NULL AND "dayPassId" IS NULL AND
      "billingCheckoutId" IS NOT NULL
    ) OR
    (
      "status" <> 'REQUIRES_REVIEW' AND
      (("subscriptionId" IS NOT NULL)::int + ("dayPassId" IS NOT NULL)::int + ("billingCheckoutId" IS NOT NULL)::int = 1)
    )
  )
);
