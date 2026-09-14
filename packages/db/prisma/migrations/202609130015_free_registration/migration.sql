ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD COLUMN "registrationMethod" TEXT NOT NULL DEFAULT 'EMAIL';
UPDATE "users" SET "emailVerifiedAt" = "createdAt" WHERE "email" IS NOT NULL;
ALTER TABLE "users" ADD CONSTRAINT "users_registration_method_check" CHECK (
  "registrationMethod" IN ('EMAIL','LINE') AND
  ("registrationMethod" <> 'EMAIL' OR ("email" IS NOT NULL AND "passwordHash" IS NOT NULL)) AND
  ("email" IS NULL OR "passwordHash" IS NOT NULL)
);

CREATE TABLE "email_verifications" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "purpose" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_verifications_values_check" CHECK (
    "purpose" IN ('REGISTRATION','ADD_FALLBACK') AND
    length("email") <= 254 AND
    (("purpose" = 'REGISTRATION' AND "passwordHash" IS NULL) OR ("purpose" = 'ADD_FALLBACK' AND "passwordHash" IS NOT NULL))
  )
);
CREATE INDEX "email_verifications_userId_expiresAt_idx" ON "email_verifications"("userId", "expiresAt");

CREATE TABLE "line_registration_grants" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tokenHash" TEXT NOT NULL UNIQUE,
  "subjectHash" TEXT NOT NULL,
  "subjectEncrypted" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "line_registration_grants_subjectHash_expiresAt_idx" ON "line_registration_grants"("subjectHash", "expiresAt");

ALTER TABLE "line_oauth_flows" DROP CONSTRAINT "line_oauth_flows_purpose_check";
ALTER TABLE "line_oauth_flows" DROP CONSTRAINT "line_oauth_flows_user_check";
ALTER TABLE "line_oauth_flows" ADD CONSTRAINT "line_oauth_flows_purpose_check" CHECK ("purpose" IN ('LOGIN','LINK','REGISTER'));
ALTER TABLE "line_oauth_flows" ADD CONSTRAINT "line_oauth_flows_user_check" CHECK (
  ("purpose" IN ('LOGIN','REGISTER') AND "userId" IS NULL) OR ("purpose" = 'LINK' AND "userId" IS NOT NULL)
);
