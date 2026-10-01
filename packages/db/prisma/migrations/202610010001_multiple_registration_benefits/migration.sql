ALTER TABLE "free_member_benefits"
  ALTER COLUMN "id" DROP DEFAULT,
  ADD COLUMN "createdAt" TIMESTAMPTZ(3),
  ADD COLUMN "createdBy" UUID;

UPDATE "free_member_benefits"
SET "createdAt" = "updatedAt",
    "createdBy" = "updatedBy"
WHERE "createdAt" IS NULL;

ALTER TABLE "free_member_benefits"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "createdAt" SET NOT NULL;

CREATE INDEX "free_member_benefits_createdAt_idx"
  ON "free_member_benefits"("createdAt");

CREATE TABLE "free_member_benefit_views" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "benefitId" TEXT NOT NULL,
  "viewedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "free_member_benefit_views_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "free_member_benefit_views_userId_benefitId_key"
  ON "free_member_benefit_views"("userId", "benefitId");

CREATE INDEX "free_member_benefit_views_benefitId_viewedAt_idx"
  ON "free_member_benefit_views"("benefitId", "viewedAt");

ALTER TABLE "free_member_benefit_views"
  ADD CONSTRAINT "free_member_benefit_views_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "free_member_benefit_views"
  ADD CONSTRAINT "free_member_benefit_views_benefitId_fkey"
  FOREIGN KEY ("benefitId") REFERENCES "free_member_benefits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "free_member_benefit_views" ("userId", "benefitId", "viewedAt")
SELECT event."userId", benefit."id", event."occurredAt"
FROM "member_journey_events" event
JOIN "free_member_benefits" benefit ON benefit."id" = 'global'
WHERE event."eventType" = 'REGISTRATION_BENEFIT_VIEWED'
ON CONFLICT ("userId", "benefitId") DO NOTHING;
