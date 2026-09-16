ALTER TABLE "notification_events"
  ADD COLUMN "raceResultVersionId" UUID,
  ADD COLUMN "win5EvaluationVersionId" UUID;

CREATE UNIQUE INDEX "notification_events_raceResultVersionId_key"
  ON "notification_events"("raceResultVersionId");
CREATE UNIQUE INDEX "notification_events_win5EvaluationVersionId_key"
  ON "notification_events"("win5EvaluationVersionId");

ALTER TABLE "notification_events"
  ADD CONSTRAINT "notification_events_raceResultVersionId_fkey"
    FOREIGN KEY ("raceResultVersionId") REFERENCES "race_result_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "notification_events_win5EvaluationVersionId_fkey"
    FOREIGN KEY ("win5EvaluationVersionId") REFERENCES "win5_evaluation_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_target_check";
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_target_check" CHECK (
  (("versionId" IS NOT NULL)::integer
    + ("announcementId" IS NOT NULL)::integer
    + ("freeReportVersionId" IS NOT NULL)::integer
    + ("productVersionId" IS NOT NULL)::integer
    + ("raceResultVersionId" IS NOT NULL)::integer
    + ("win5EvaluationVersionId" IS NOT NULL)::integer) = 1
);

CREATE FUNCTION enforce_evaluation_result_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_tx BIGINT;
BEGIN
  IF NEW."raceResultVersionId" IS NOT NULL THEN
    SELECT "createdTxId" INTO source_tx FROM "race_result_versions" WHERE "id" = NEW."raceResultVersionId";
    IF source_tx IS NULL OR source_tx <> txid_current() THEN
      RAISE EXCEPTION 'Race evaluation result notification must be created in the confirmation transaction';
    END IF;
    IF NEW."eventType" <> 'RACE_EVALUATION_CONFIRMED' THEN
      RAISE EXCEPTION 'Race evaluation result notification type is invalid';
    END IF;
  ELSIF NEW."win5EvaluationVersionId" IS NOT NULL THEN
    SELECT "createdTxId" INTO source_tx FROM "win5_evaluation_versions" WHERE "id" = NEW."win5EvaluationVersionId";
    IF source_tx IS NULL OR source_tx <> txid_current() THEN
      RAISE EXCEPTION 'WIN5 evaluation result notification must be created in the confirmation transaction';
    END IF;
    IF NEW."eventType" <> 'WIN5_EVALUATION_CONFIRMED' THEN
      RAISE EXCEPTION 'WIN5 evaluation result notification type is invalid';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER evaluation_result_notification_event_guard
  BEFORE INSERT ON "notification_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_evaluation_result_notification_event();
