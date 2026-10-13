ALTER TABLE "line_accounts"
  ADD COLUMN "identityOwnerUserId" UUID,
  ADD COLUMN "referralIdentityConsumedAt" TIMESTAMPTZ(3);

-- Preserve the first account associated with a LINE identity when its login
-- row is later reassigned to a newly registered account.
UPDATE "line_accounts"
SET "identityOwnerUserId" = "userId";

-- An identity that has already counted as a referred member must not count
-- again after account closure and re-registration.
UPDATE "line_accounts" AS line_account
SET "referralIdentityConsumedAt" = line_account."linkedAt"
WHERE EXISTS (
  SELECT 1
  FROM "referrals" AS referral
  WHERE referral."referredUserId" = line_account."userId"
);

ALTER TABLE "line_accounts"
  ADD CONSTRAINT "line_accounts_identityOwnerUserId_fkey"
  FOREIGN KEY ("identityOwnerUserId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "line_accounts_identityOwnerUserId_idx"
  ON "line_accounts"("identityOwnerUserId");
