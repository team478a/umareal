-- Additive referral benefit management foundation. Existing V1 milestones,
-- rewards, day passes and entitlements remain unchanged.

CREATE TABLE "referral_benefits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_benefits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_benefits_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "referral_benefit_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "benefitId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "requiredReferralCount" INTEGER NOT NULL,
  "rewardType" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "claimValidityDays" INTEGER NOT NULL,
  "accessDays" INTEGER,
  "distributionStartsAt" TIMESTAMPTZ(3),
  "distributionEndsAt" TIMESTAMPTZ(3),
  "published" BOOLEAN NOT NULL DEFAULT false,
  "grantEnabled" BOOLEAN NOT NULL DEFAULT false,
  "sortOrder" INTEGER NOT NULL,
  "memberGuidance" TEXT NOT NULL,
  "usageTerms" TEXT NOT NULL,
  "changeReason" TEXT NOT NULL,
  "createdById" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_benefit_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_benefit_versions_values_check" CHECK (
    "version" > 0 AND
    length(btrim("name")) > 0 AND
    length(btrim("description")) > 0 AND
    "requiredReferralCount" > 0 AND
    "rewardType" IN ('DAY_PASS', 'MONTHLY_ACCESS', 'LIMITED_CONTENT') AND
    "quantity" > 0 AND "quantity" <= 100 AND
    "claimValidityDays" > 0 AND "claimValidityDays" <= 3650 AND
    "sortOrder" >= 0 AND
    length(btrim("memberGuidance")) > 0 AND
    length(btrim("usageTerms")) > 0 AND
    length(btrim("changeReason")) > 0 AND
    (NOT "grantEnabled" OR "published") AND
    ("distributionStartsAt" IS NULL OR "distributionEndsAt" IS NULL OR "distributionEndsAt" > "distributionStartsAt") AND
    (("rewardType" = 'MONTHLY_ACCESS' AND "accessDays" IS NOT NULL AND "accessDays" > 0 AND "accessDays" <= 3650) OR
     ("rewardType" <> 'MONTHLY_ACCESS' AND "accessDays" IS NULL)) AND
    ("rewardType" <> 'LIMITED_CONTENT' OR "quantity" = 1)
  )
);

CREATE TABLE "referral_benefit_version_contents" (
  "benefitVersionId" UUID NOT NULL,
  "contentItemId" UUID NOT NULL,
  CONSTRAINT "referral_benefit_version_contents_pkey" PRIMARY KEY ("benefitVersionId", "contentItemId")
);

CREATE TABLE "referral_achievements" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "referrerUserId" UUID NOT NULL,
  "referralId" UUID NOT NULL,
  "previousQualifiedCount" INTEGER NOT NULL,
  "qualifiedCount" INTEGER NOT NULL,
  "achievedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "referral_achievements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_achievements_counts_check" CHECK (
    "previousQualifiedCount" >= 0 AND "qualifiedCount" = "previousQualifiedCount" + 1
  )
);

CREATE TABLE "referral_benefit_grants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "benefitVersionId" UUID NOT NULL,
  "achievementId" UUID NOT NULL,
  "unitNo" INTEGER NOT NULL,
  "rewardType" TEXT NOT NULL,
  "rewardSnapshot" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
  "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "invalidatedAt" TIMESTAMPTZ(3),
  "invalidatedReason" TEXT,
  "dayPassId" UUID,
  "entitlementId" UUID,
  CONSTRAINT "referral_benefit_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_benefit_grants_values_check" CHECK (
    "unitNo" > 0 AND
    "rewardType" IN ('DAY_PASS', 'MONTHLY_ACCESS', 'LIMITED_CONTENT') AND
    "expiresAt" > "grantedAt" AND
    (("status" IN ('AVAILABLE', 'EXPIRED') AND "usedAt" IS NULL AND "dayPassId" IS NULL AND "entitlementId" IS NULL AND "invalidatedAt" IS NULL AND "invalidatedReason" IS NULL) OR
     ("status" = 'REDEEMED' AND "usedAt" IS NOT NULL AND "invalidatedAt" IS NULL AND "invalidatedReason" IS NULL AND
       (("rewardType" = 'DAY_PASS' AND "dayPassId" IS NOT NULL AND "entitlementId" IS NULL) OR
        ("rewardType" = 'MONTHLY_ACCESS' AND "dayPassId" IS NULL AND "entitlementId" IS NOT NULL) OR
        ("rewardType" = 'LIMITED_CONTENT' AND "dayPassId" IS NULL AND "entitlementId" IS NULL))) OR
     ("status" = 'INVALIDATED' AND "usedAt" IS NULL AND "dayPassId" IS NULL AND "entitlementId" IS NULL AND "invalidatedAt" IS NOT NULL AND length(btrim("invalidatedReason")) > 0))
  )
);

CREATE UNIQUE INDEX "referral_benefit_versions_benefitId_version_key" ON "referral_benefit_versions"("benefitId", "version");
CREATE INDEX "referral_benefit_versions_threshold_publish_idx" ON "referral_benefit_versions"("requiredReferralCount", "published", "grantEnabled");
CREATE INDEX "referral_benefit_versions_createdAt_idx" ON "referral_benefit_versions"("createdAt");
CREATE INDEX "referral_benefits_createdAt_idx" ON "referral_benefits"("createdAt");
CREATE INDEX "referral_benefit_version_contents_contentItemId_idx" ON "referral_benefit_version_contents"("contentItemId");
CREATE UNIQUE INDEX "referral_achievements_referralId_key" ON "referral_achievements"("referralId");
CREATE INDEX "referral_achievements_referrerUserId_achievedAt_idx" ON "referral_achievements"("referrerUserId", "achievedAt");
CREATE UNIQUE INDEX "referral_benefit_grants_user_version_unit_key" ON "referral_benefit_grants"("userId", "benefitVersionId", "unitNo");
CREATE UNIQUE INDEX "referral_benefit_grants_dayPassId_key" ON "referral_benefit_grants"("dayPassId");
CREATE UNIQUE INDEX "referral_benefit_grants_entitlementId_key" ON "referral_benefit_grants"("entitlementId");
CREATE INDEX "referral_benefit_grants_user_status_expiry_idx" ON "referral_benefit_grants"("userId", "status", "expiresAt");
CREATE INDEX "referral_benefit_grants_version_status_idx" ON "referral_benefit_grants"("benefitVersionId", "status");

ALTER TABLE "referral_benefits" ADD CONSTRAINT "referral_benefits_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_benefit_versions" ADD CONSTRAINT "referral_benefit_versions_benefitId_fkey" FOREIGN KEY ("benefitId") REFERENCES "referral_benefits"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_benefit_versions" ADD CONSTRAINT "referral_benefit_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_benefit_version_contents" ADD CONSTRAINT "referral_benefit_version_contents_benefitVersionId_fkey" FOREIGN KEY ("benefitVersionId") REFERENCES "referral_benefit_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_benefit_version_contents" ADD CONSTRAINT "referral_benefit_version_contents_contentItemId_fkey" FOREIGN KEY ("contentItemId") REFERENCES "content_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_achievements" ADD CONSTRAINT "referral_achievements_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_achievements" ADD CONSTRAINT "referral_achievements_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_benefit_grants" ADD CONSTRAINT "referral_benefit_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_benefit_grants" ADD CONSTRAINT "referral_benefit_grants_benefitVersionId_fkey" FOREIGN KEY ("benefitVersionId") REFERENCES "referral_benefit_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_benefit_grants" ADD CONSTRAINT "referral_benefit_grants_achievementId_fkey" FOREIGN KEY ("achievementId") REFERENCES "referral_achievements"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_benefit_grants" ADD CONSTRAINT "referral_benefit_grants_dayPassId_fkey" FOREIGN KEY ("dayPassId") REFERENCES "day_passes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "referral_benefit_grants" ADD CONSTRAINT "referral_benefit_grants_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "entitlements"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE OR REPLACE FUNCTION reject_referral_benefit_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END; $$;

CREATE TRIGGER referral_benefit_versions_immutable BEFORE UPDATE OR DELETE ON "referral_benefit_versions" FOR EACH ROW EXECUTE FUNCTION reject_referral_benefit_history_mutation();
CREATE TRIGGER referral_benefit_versions_no_truncate BEFORE TRUNCATE ON "referral_benefit_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_referral_benefit_history_mutation();
CREATE TRIGGER referral_benefit_contents_immutable BEFORE UPDATE OR DELETE ON "referral_benefit_version_contents" FOR EACH ROW EXECUTE FUNCTION reject_referral_benefit_history_mutation();
CREATE TRIGGER referral_benefit_contents_no_truncate BEFORE TRUNCATE ON "referral_benefit_version_contents" FOR EACH STATEMENT EXECUTE FUNCTION reject_referral_benefit_history_mutation();
CREATE TRIGGER referral_achievements_immutable BEFORE UPDATE OR DELETE ON "referral_achievements" FOR EACH ROW EXECUTE FUNCTION reject_referral_benefit_history_mutation();
CREATE TRIGGER referral_achievements_no_truncate BEFORE TRUNCATE ON "referral_achievements" FOR EACH STATEMENT EXECUTE FUNCTION reject_referral_benefit_history_mutation();

CREATE OR REPLACE FUNCTION guard_referral_benefit_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."createdById" <> OLD."createdById" OR NEW."createdAt" <> OLD."createdAt" OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'referral benefit update must only increment revision' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER referral_benefits_update_guard BEFORE UPDATE ON "referral_benefits" FOR EACH ROW EXECUTE FUNCTION guard_referral_benefit_update();
CREATE TRIGGER referral_benefits_no_delete BEFORE DELETE ON "referral_benefits" FOR EACH ROW EXECUTE FUNCTION reject_referral_benefit_history_mutation();
CREATE TRIGGER referral_benefits_no_truncate BEFORE TRUNCATE ON "referral_benefits" FOR EACH STATEMENT EXECUTE FUNCTION reject_referral_benefit_history_mutation();

CREATE OR REPLACE FUNCTION guard_referral_benefit_grant_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."id" <> OLD."id" OR NEW."userId" <> OLD."userId" OR NEW."benefitVersionId" <> OLD."benefitVersionId" OR
     NEW."achievementId" <> OLD."achievementId" OR NEW."unitNo" <> OLD."unitNo" OR NEW."rewardType" <> OLD."rewardType" OR
     NEW."rewardSnapshot" <> OLD."rewardSnapshot" OR NEW."grantedAt" <> OLD."grantedAt" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'referral benefit grant identity is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER referral_benefit_grants_update_guard BEFORE UPDATE ON "referral_benefit_grants" FOR EACH ROW EXECUTE FUNCTION guard_referral_benefit_grant_update();
CREATE TRIGGER referral_benefit_grants_no_delete BEFORE DELETE ON "referral_benefit_grants" FOR EACH ROW EXECUTE FUNCTION reject_referral_benefit_history_mutation();
CREATE TRIGGER referral_benefit_grants_no_truncate BEFORE TRUNCATE ON "referral_benefit_grants" FOR EACH STATEMENT EXECUTE FUNCTION reject_referral_benefit_history_mutation();
