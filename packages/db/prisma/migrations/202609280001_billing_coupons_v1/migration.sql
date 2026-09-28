ALTER TABLE "system_settings"
  ADD COLUMN "standardSalesEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "dayPassSalesEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "billing_coupons" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "discountType" TEXT NOT NULL,
  "discountValue" INTEGER NOT NULL,
  "duration" TEXT NOT NULL,
  "applicablePlanCodes" TEXT[] NOT NULL,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "maxRedemptions" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" UUID NOT NULL,
  "deactivatedById" UUID,
  "deactivatedAt" TIMESTAMPTZ(3),
  "deactivationReason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_coupons_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_coupons_values_check" CHECK (
    "code" ~ '^[A-Z0-9][A-Z0-9_-]{3,31}$' AND
    length(btrim("name")) BETWEEN 1 AND 100 AND
    "discountType" IN ('PERCENT','FIXED_YEN') AND
    (("discountType" = 'PERCENT' AND "discountValue" BETWEEN 1 AND 100) OR
     ("discountType" = 'FIXED_YEN' AND "discountValue" BETWEEN 1 AND 1000000)) AND
    "duration" IN ('ONCE','FOREVER') AND
    cardinality("applicablePlanCodes") > 0 AND
    "applicablePlanCodes" <@ ARRAY['FOUNDER','STANDARD','DAY_PASS']::TEXT[] AND
    "endsAt" > "startsAt" AND
    ("maxRedemptions" IS NULL OR "maxRedemptions" > 0) AND
    (("active" = true AND "deactivatedById" IS NULL AND "deactivatedAt" IS NULL AND "deactivationReason" IS NULL) OR
     ("active" = false AND "deactivatedById" IS NOT NULL AND "deactivatedAt" IS NOT NULL AND length(btrim("deactivationReason")) > 0))
  )
);

CREATE UNIQUE INDEX "billing_coupons_code_key" ON "billing_coupons"("code");
CREATE INDEX "billing_coupons_active_startsAt_endsAt_idx" ON "billing_coupons"("active", "startsAt", "endsAt");
ALTER TABLE "billing_coupons" ADD CONSTRAINT "billing_coupons_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_coupons" ADD CONSTRAINT "billing_coupons_deactivatedById_fkey" FOREIGN KEY ("deactivatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "billing_checkouts"
  ADD COLUMN "baseAmountYen" INTEGER,
  ADD COLUMN "discountAmountYen" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recurringAmountYen" INTEGER,
  ADD COLUMN "couponId" UUID;

UPDATE "billing_checkouts"
SET "baseAmountYen" = "amountYen",
    "recurringAmountYen" = CASE WHEN "kind" = 'SUBSCRIPTION' THEN "amountYen" ELSE NULL END;

ALTER TABLE "billing_checkouts" ALTER COLUMN "baseAmountYen" SET NOT NULL;
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "billing_coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "billing_checkouts_couponId_idx" ON "billing_checkouts"("couponId");

ALTER TABLE "billing_checkouts" DROP CONSTRAINT "billing_checkouts_values_check";
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_values_check" CHECK (
  "kind" IN ('SUBSCRIPTION','DAY_PASS') AND "planCode" IN ('FOUNDER','STANDARD','DAY_PASS') AND
  "status" IN (
    'INITIATED','OPEN','COMPLETED','EXPIRED','FAILED',
    'REJECTED_ACCOUNT_STATE','REJECTED_EXISTING_ACCESS','REJECTED_FOUNDER_LIMIT',
    'REVIEW_REFUNDING','REVIEW_REFUNDED','REVIEW_ACCESS_GRANTED'
  ) AND
  "baseAmountYen" >= 0 AND "discountAmountYen" >= 0 AND "amountYen" >= 0 AND
  "baseAmountYen" - "discountAmountYen" = "amountYen" AND
  (("kind" = 'SUBSCRIPTION' AND "recurringAmountYen" IS NOT NULL AND "recurringAmountYen" >= 0) OR
   ("kind" = 'DAY_PASS' AND "recurringAmountYen" IS NULL)) AND
  (("couponId" IS NULL AND "discountAmountYen" = 0) OR ("couponId" IS NOT NULL AND "discountAmountYen" > 0)) AND
  "expiresAt" > "createdAt" AND
  (("kind" = 'DAY_PASS' AND "raceDate" ~ '^\d{4}-\d{2}-\d{2}$') OR ("kind" = 'SUBSCRIPTION' AND "raceDate" IS NULL))
);

CREATE TABLE "billing_coupon_redemptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "couponId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "billingCheckoutId" UUID,
  "paymentTransactionId" UUID,
  "status" TEXT NOT NULL,
  "reservedUntil" TIMESTAMPTZ(3),
  "redeemedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_coupon_redemptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_coupon_redemptions_values_check" CHECK (
    ("status" = 'RESERVED' AND "billingCheckoutId" IS NOT NULL AND "paymentTransactionId" IS NULL AND "reservedUntil" IS NOT NULL AND "redeemedAt" IS NULL) OR
    ("status" = 'REDEEMED' AND "redeemedAt" IS NOT NULL AND (("billingCheckoutId" IS NOT NULL)::int + ("paymentTransactionId" IS NOT NULL)::int >= 1)) OR
    ("status" = 'RELEASED' AND "redeemedAt" IS NULL)
  )
);

CREATE UNIQUE INDEX "billing_coupon_redemptions_billingCheckoutId_key" ON "billing_coupon_redemptions"("billingCheckoutId");
CREATE UNIQUE INDEX "billing_coupon_redemptions_paymentTransactionId_key" ON "billing_coupon_redemptions"("paymentTransactionId");
CREATE UNIQUE INDEX "billing_coupon_redemptions_couponId_userId_key" ON "billing_coupon_redemptions"("couponId", "userId");
CREATE INDEX "billing_coupon_redemptions_couponId_status_reservedUntil_idx" ON "billing_coupon_redemptions"("couponId", "status", "reservedUntil");
CREATE INDEX "billing_coupon_redemptions_userId_createdAt_idx" ON "billing_coupon_redemptions"("userId", "createdAt");
ALTER TABLE "billing_coupon_redemptions" ADD CONSTRAINT "billing_coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "billing_coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_coupon_redemptions" ADD CONSTRAINT "billing_coupon_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_coupon_redemptions" ADD CONSTRAINT "billing_coupon_redemptions_billingCheckoutId_fkey" FOREIGN KEY ("billingCheckoutId") REFERENCES "billing_checkouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_coupon_redemptions" ADD CONSTRAINT "billing_coupon_redemptions_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
