ALTER TABLE "line_accounts" ADD COLUMN "unlinkedAt" TIMESTAMPTZ(3);

CREATE TABLE "line_oauth_flows" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "stateHash" TEXT NOT NULL,
  "nonceHash" TEXT NOT NULL,
  "nonceEncrypted" TEXT NOT NULL,
  "codeVerifierEncrypted" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "userId" UUID,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "line_oauth_flows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "line_oauth_flows_purpose_check" CHECK ("purpose" IN ('LOGIN', 'LINK')),
  CONSTRAINT "line_oauth_flows_user_check" CHECK (("purpose" = 'LOGIN' AND "userId" IS NULL) OR ("purpose" = 'LINK' AND "userId" IS NOT NULL)),
  CONSTRAINT "line_oauth_flows_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "line_oauth_flows_stateHash_key" ON "line_oauth_flows"("stateHash");
CREATE INDEX "line_oauth_flows_expiresAt_idx" ON "line_oauth_flows"("expiresAt");
