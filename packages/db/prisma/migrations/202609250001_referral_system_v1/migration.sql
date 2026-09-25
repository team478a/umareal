ALTER TABLE "users" ADD COLUMN "referralCode" TEXT;

UPDATE "users"
SET "referralCode" = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20))
WHERE "referralCode" IS NULL;

ALTER TABLE "users"
  ALTER COLUMN "referralCode" SET NOT NULL,
  ALTER COLUMN "referralCode" SET DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 20));

CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");

ALTER TABLE "line_oauth_flows" ADD COLUMN "memberReferralCode" TEXT;
ALTER TABLE "line_registration_grants" ADD COLUMN "memberReferralCode" TEXT;
ALTER TABLE "day_passes" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'PURCHASE';

CREATE TABLE "referrals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "referrerUserId" UUID NOT NULL,
  "referredUserId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "qualifiedAt" TIMESTAMPTZ(3),
  "invalidatedAt" TIMESTAMPTZ(3),
  "invalidatedReason" TEXT,
  "invalidatedById" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referrals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referrals_distinct_users_check" CHECK ("referrerUserId" <> "referredUserId"),
  CONSTRAINT "referrals_status_check" CHECK (
    ("status" = 'PENDING' AND "qualifiedAt" IS NULL AND "invalidatedAt" IS NULL AND "invalidatedReason" IS NULL AND "invalidatedById" IS NULL) OR
    ("status" = 'QUALIFIED' AND "qualifiedAt" IS NOT NULL AND "invalidatedAt" IS NULL AND "invalidatedReason" IS NULL AND "invalidatedById" IS NULL) OR
    ("status" = 'INVALIDATED' AND "qualifiedAt" IS NOT NULL AND "invalidatedAt" IS NOT NULL AND length(btrim("invalidatedReason")) > 0 AND "invalidatedById" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "referrals_referredUserId_key" ON "referrals"("referredUserId");
CREATE INDEX "referrals_referrerUserId_status_qualifiedAt_idx" ON "referrals"("referrerUserId", "status", "qualifiedAt");
CREATE INDEX "referrals_createdAt_idx" ON "referrals"("createdAt");

CREATE TABLE "referral_milestones" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "requiredReferralCount" INTEGER NOT NULL,
  "rewardType" TEXT NOT NULL DEFAULT 'DAY_PASS',
  "rewardQuantity" INTEGER NOT NULL DEFAULT 1,
  "rewardValidityDays" INTEGER NOT NULL DEFAULT 60,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_milestones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_milestones_values_check" CHECK (
    "requiredReferralCount" > 0 AND "rewardType" = 'DAY_PASS' AND "rewardQuantity" > 0 AND "rewardValidityDays" > 0 AND "rewardValidityDays" <= 3650 AND "sortOrder" >= 0
  )
);

CREATE UNIQUE INDEX "referral_milestones_requiredReferralCount_key" ON "referral_milestones"("requiredReferralCount");
CREATE INDEX "referral_milestones_active_sortOrder_idx" ON "referral_milestones"("active", "sortOrder");

INSERT INTO "referral_milestones" ("requiredReferralCount", "rewardType", "rewardQuantity", "rewardValidityDays", "active", "sortOrder") VALUES
  (3, 'DAY_PASS', 1, 60, true, 10),
  (10, 'DAY_PASS', 1, 60, true, 20);

CREATE TABLE "referral_rewards" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "milestoneId" UUID NOT NULL,
  "rewardType" TEXT NOT NULL,
  "rewardQuantity" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "invalidatedAt" TIMESTAMPTZ(3),
  "invalidatedReason" TEXT,
  "dayPassId" UUID,
  CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_rewards_values_check" CHECK (
    "rewardType" = 'DAY_PASS' AND "rewardQuantity" > 0 AND "expiresAt" > "grantedAt" AND
    ("status" IN ('AVAILABLE','EXPIRED') AND "usedAt" IS NULL AND "dayPassId" IS NULL AND "invalidatedAt" IS NULL AND "invalidatedReason" IS NULL OR
     "status" = 'REDEEMED' AND "usedAt" IS NOT NULL AND "dayPassId" IS NOT NULL AND "invalidatedAt" IS NULL AND "invalidatedReason" IS NULL OR
     "status" = 'INVALIDATED' AND "usedAt" IS NULL AND "dayPassId" IS NULL AND "invalidatedAt" IS NOT NULL AND length(btrim("invalidatedReason")) > 0)
  )
);

CREATE UNIQUE INDEX "referral_rewards_userId_milestoneId_key" ON "referral_rewards"("userId", "milestoneId");
CREATE UNIQUE INDEX "referral_rewards_dayPassId_key" ON "referral_rewards"("dayPassId");
CREATE INDEX "referral_rewards_userId_status_expiresAt_idx" ON "referral_rewards"("userId", "status", "expiresAt");

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_invalidatedById_fkey" FOREIGN KEY ("invalidatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "referral_milestones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_dayPassId_fkey" FOREIGN KEY ("dayPassId") REFERENCES "day_passes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
