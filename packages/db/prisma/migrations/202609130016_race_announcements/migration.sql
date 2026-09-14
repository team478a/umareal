CREATE TABLE "race_announcements" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "raceId" UUID NOT NULL REFERENCES "races"("id") ON DELETE RESTRICT,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "publishedBy" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" TEXT NOT NULL CHECK (length(trim("reason")) BETWEEN 1 AND 500),
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  UNIQUE ("raceId", "version")
);
CREATE INDEX "race_announcements_publishedAt_idx" ON "race_announcements"("publishedAt");

ALTER TABLE "notification_events" ALTER COLUMN "versionId" DROP NOT NULL;
ALTER TABLE "notification_events" ADD COLUMN "announcementId" UUID UNIQUE REFERENCES "race_announcements"("id") ON DELETE RESTRICT;
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_target_check" CHECK (
  (("versionId" IS NOT NULL)::integer + ("announcementId" IS NOT NULL)::integer) = 1
);

CREATE FUNCTION reject_race_announcement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'race_announcements is append-only' USING ERRCODE = '42501';
END; $$;
CREATE TRIGGER race_announcement_no_update_delete BEFORE UPDATE OR DELETE ON "race_announcements"
  FOR EACH ROW EXECUTE FUNCTION reject_race_announcement_mutation();
CREATE TRIGGER race_announcement_no_truncate BEFORE TRUNCATE ON "race_announcements"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_race_announcement_mutation();
