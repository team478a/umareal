ALTER TABLE "notification_events" ADD COLUMN "productVersionId" UUID;

CREATE UNIQUE INDEX "notification_events_productVersionId_key"
  ON "notification_events"("productVersionId");

ALTER TABLE "notification_events"
  ADD CONSTRAINT "notification_events_productVersionId_fkey"
  FOREIGN KEY ("productVersionId") REFERENCES "prediction_product_versions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_target_check";
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_target_check" CHECK (
  (("versionId" IS NOT NULL)::integer
    + ("announcementId" IS NOT NULL)::integer
    + ("freeReportVersionId" IS NOT NULL)::integer
    + ("productVersionId" IS NOT NULL)::integer) = 1
);

CREATE FUNCTION enforce_win5_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  publication_tx BIGINT;
  publication_status TEXT;
BEGIN
  IF NEW."productVersionId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "createdTxId", "status"
    INTO publication_tx, publication_status
    FROM "prediction_product_versions"
    WHERE "id" = NEW."productVersionId";

  IF publication_tx IS NULL OR publication_tx <> txid_current() THEN
    RAISE EXCEPTION 'WIN5 notification event must be created in the publication transaction';
  END IF;

  IF (publication_status = 'PUBLISHED' AND NEW."eventType" <> 'WIN5_PREVIEW_PUBLISHED')
     OR (publication_status = 'CORRECTED' AND NEW."eventType" <> 'WIN5_PREVIEW_CORRECTED')
     OR publication_status NOT IN ('PUBLISHED', 'CORRECTED') THEN
    RAISE EXCEPTION 'WIN5 notification event type does not match publication status';
  END IF;

  RETURN NEW;
END; $$;

CREATE TRIGGER win5_notification_event_guard
  BEFORE INSERT ON "notification_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_win5_notification_event();
