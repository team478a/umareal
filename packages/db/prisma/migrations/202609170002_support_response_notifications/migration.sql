ALTER TABLE "support_events" ADD COLUMN "createdTxId" BIGINT NOT NULL DEFAULT txid_current();

ALTER TABLE "notification_events" ADD COLUMN "supportEventId" UUID;
CREATE UNIQUE INDEX "notification_events_supportEventId_key" ON "notification_events"("supportEventId");
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_supportEventId_fkey"
  FOREIGN KEY ("supportEventId") REFERENCES "support_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_target_check";
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_target_check" CHECK (
  (("versionId" IS NOT NULL)::integer
    + ("announcementId" IS NOT NULL)::integer
    + ("freeReportVersionId" IS NOT NULL)::integer
    + ("productVersionId" IS NOT NULL)::integer
    + ("raceResultVersionId" IS NOT NULL)::integer
    + ("win5EvaluationVersionId" IS NOT NULL)::integer
    + ("supportEventId" IS NOT NULL)::integer) = 1
);

CREATE FUNCTION enforce_support_response_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_tx BIGINT; source_type TEXT;
BEGIN
  IF NEW."supportEventId" IS NULL THEN RETURN NEW; END IF;
  SELECT "createdTxId", "eventType" INTO source_tx, source_type FROM "support_events" WHERE "id" = NEW."supportEventId";
  IF source_tx IS NULL OR source_tx <> txid_current() THEN
    RAISE EXCEPTION 'Support response notification must be created in the resolution transaction';
  END IF;
  IF source_type <> 'RESOLVED' OR NEW."eventType" <> 'SUPPORT_RESPONSE_POSTED' THEN
    RAISE EXCEPTION 'Support response notification type is invalid';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER support_response_notification_event_guard
  BEFORE INSERT ON "notification_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_support_response_notification_event();
