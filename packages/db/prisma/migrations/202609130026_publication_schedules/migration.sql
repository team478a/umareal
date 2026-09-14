CREATE TABLE "publication_schedules" (
  "id" UUID NOT NULL,
  "raceId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "draftRevision" INTEGER,
  "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "reason" TEXT NOT NULL,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(3),
  "publishedTargetId" UUID,
  "errorCode" TEXT,
  CONSTRAINT "publication_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "publication_schedules_kind_check" CHECK ("kind" IN ('RACE_ANNOUNCEMENT', 'FREE_REPORT_PRE_RACE')),
  CONSTRAINT "publication_schedules_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'CANCELLED')),
  CONSTRAINT "publication_schedules_revision_check" CHECK (("kind" = 'RACE_ANNOUNCEMENT' AND "draftRevision" IS NULL) OR ("kind" = 'FREE_REPORT_PRE_RACE' AND "draftRevision" > 0))
);

CREATE INDEX "publication_schedules_status_scheduledAt_idx" ON "publication_schedules"("status", "scheduledAt");
CREATE INDEX "publication_schedules_raceId_kind_createdAt_idx" ON "publication_schedules"("raceId", "kind", "createdAt");
CREATE UNIQUE INDEX "publication_schedules_one_pending" ON "publication_schedules"("raceId", "kind") WHERE "status" IN ('PENDING', 'PROCESSING');
ALTER TABLE "publication_schedules" ADD CONSTRAINT "publication_schedules_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "publication_schedules" ADD CONSTRAINT "publication_schedules_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
