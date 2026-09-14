CREATE TABLE "acquisition_campaigns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "medium" TEXT NOT NULL,
  "content" TEXT,
  "landingPath" TEXT NOT NULL,
  "referralCode" TEXT,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acquisition_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acquisition_campaigns_code_key" UNIQUE ("code"),
  CONSTRAINT "acquisition_campaigns_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "acquisition_campaigns_createdAt_idx" ON "acquisition_campaigns"("createdAt");
