CREATE TABLE "free_report_drafts" (
  "id" UUID NOT NULL,
  "raceId" UUID NOT NULL,
  "upEntryId" UUID NOT NULL,
  "upReason" TEXT NOT NULL,
  "downEntryId" UUID NOT NULL,
  "downReason" TEXT NOT NULL,
  "audioUrl" TEXT NOT NULL,
  "reviewText" TEXT NOT NULL DEFAULT '',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedBy" UUID NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "free_report_drafts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "free_report_versions" (
  "id" UUID NOT NULL,
  "raceId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "upEntryId" UUID NOT NULL,
  "upHorseNumber" INTEGER NOT NULL,
  "upHorseName" TEXT NOT NULL,
  "upReason" TEXT NOT NULL,
  "downEntryId" UUID NOT NULL,
  "downHorseNumber" INTEGER NOT NULL,
  "downHorseName" TEXT NOT NULL,
  "downReason" TEXT NOT NULL,
  "audioUrl" TEXT NOT NULL,
  "reviewText" TEXT,
  "publishedBy" UUID NOT NULL,
  "publishReason" TEXT NOT NULL,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  CONSTRAINT "free_report_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "free_member_benefits" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "videoUrl" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedBy" UUID,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "free_member_benefits_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notification_events" ADD COLUMN "freeReportVersionId" UUID;
CREATE UNIQUE INDEX "free_report_drafts_raceId_key" ON "free_report_drafts"("raceId");
CREATE UNIQUE INDEX "free_report_versions_raceId_version_key" ON "free_report_versions"("raceId", "version");
CREATE INDEX "free_report_versions_raceId_kind_publishedAt_idx" ON "free_report_versions"("raceId", "kind", "publishedAt");
CREATE UNIQUE INDEX "notification_events_freeReportVersionId_key" ON "notification_events"("freeReportVersionId");
ALTER TABLE "free_report_drafts" ADD CONSTRAINT "free_report_drafts_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "free_report_versions" ADD CONSTRAINT "free_report_versions_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "free_report_versions" ADD CONSTRAINT "free_report_versions_publishedBy_fkey" FOREIGN KEY ("publishedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_freeReportVersionId_fkey" FOREIGN KEY ("freeReportVersionId") REFERENCES "free_report_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION reject_free_report_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published free report versions are append-only';
END;
$$;
CREATE TRIGGER free_report_versions_no_update_delete BEFORE UPDATE OR DELETE ON "free_report_versions" FOR EACH ROW EXECUTE FUNCTION reject_free_report_version_mutation();
CREATE TRIGGER free_report_versions_no_truncate BEFORE TRUNCATE ON "free_report_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_free_report_version_mutation();
