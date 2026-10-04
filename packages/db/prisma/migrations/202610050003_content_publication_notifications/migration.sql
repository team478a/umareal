ALTER TABLE notification_events
  ADD COLUMN "contentVersionId" UUID REFERENCES content_versions(id) ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE UNIQUE INDEX "notification_events_contentVersionId_key"
  ON notification_events("contentVersionId");

ALTER TABLE notification_events DROP CONSTRAINT notification_events_target_check;
ALTER TABLE notification_events ADD CONSTRAINT notification_events_target_check CHECK (
  num_nonnulls("versionId", "announcementId", "freeReportVersionId", "productVersionId",
    "raceResultVersionId", "win5EvaluationVersionId", "supportEventId", "billingEventId",
    "paperVersionId", "contentVersionId") = 1
);

CREATE FUNCTION enforce_content_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_tx BIGINT; source_version INTEGER;
BEGIN
  IF NEW."contentVersionId" IS NULL THEN RETURN NEW; END IF;
  SELECT "createdTxId", version INTO source_tx, source_version
    FROM content_versions WHERE id = NEW."contentVersionId";
  IF source_tx IS NULL OR source_tx <> txid_current()
    OR NEW."eventType" <> (CASE WHEN source_version = 1 THEN 'CONTENT_PUBLISHED' ELSE 'CONTENT_UPDATED' END)
  THEN
    RAISE EXCEPTION 'Content notification must match its publication transaction and version';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER content_notification_guard
  BEFORE INSERT ON notification_events
  FOR EACH ROW EXECUTE FUNCTION enforce_content_notification();
