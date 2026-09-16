CREATE OR REPLACE FUNCTION enforce_evaluation_result_notification_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_tx BIGINT;
  evaluation_status TEXT;
BEGIN
  IF NEW."raceResultVersionId" IS NOT NULL THEN
    SELECT "createdTxId" INTO source_tx
      FROM "race_result_versions"
      WHERE "id" = NEW."raceResultVersionId";
    IF source_tx IS NULL OR source_tx <> txid_current() THEN
      RAISE EXCEPTION 'Race evaluation result notification must be created in the confirmation transaction';
    END IF;
    IF NEW."eventType" <> 'RACE_EVALUATION_CONFIRMED' THEN
      RAISE EXCEPTION 'Race evaluation result notification type is invalid';
    END IF;
    SELECT evaluation."status" INTO evaluation_status
      FROM "prediction_evaluations" evaluation
      JOIN "prediction_versions" prediction_version ON prediction_version."id" = evaluation."predictionVersionId"
      WHERE evaluation."resultVersionId" = NEW."raceResultVersionId"
      ORDER BY prediction_version."version" DESC
      LIMIT 1;
    IF evaluation_status IS NULL OR evaluation_status = 'REVIEW_REQUIRED' THEN
      RAISE EXCEPTION 'Race evaluation result notification requires a confirmed evaluation';
    END IF;
  ELSIF NEW."win5EvaluationVersionId" IS NOT NULL THEN
    SELECT "createdTxId", "status" INTO source_tx, evaluation_status
      FROM "win5_evaluation_versions"
      WHERE "id" = NEW."win5EvaluationVersionId";
    IF source_tx IS NULL OR source_tx <> txid_current() THEN
      RAISE EXCEPTION 'WIN5 evaluation result notification must be created in the confirmation transaction';
    END IF;
    IF NEW."eventType" <> 'WIN5_EVALUATION_CONFIRMED' THEN
      RAISE EXCEPTION 'WIN5 evaluation result notification type is invalid';
    END IF;
    IF evaluation_status NOT IN ('WIN5_ALL_WINNERS_RECOMMENDED', 'WIN5_PARTIAL', 'WIN5_MISSED') THEN
      RAISE EXCEPTION 'WIN5 evaluation result notification requires a confirmed evaluation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
