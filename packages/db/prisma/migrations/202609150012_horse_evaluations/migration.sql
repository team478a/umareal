-- Additive migration: legacy betting data and immutable published snapshots remain intact.
ALTER TABLE "prediction_product_races"
  ADD COLUMN "paceView" TEXT,
  ADD COLUMN "shortComment" TEXT,
  ADD CONSTRAINT "prediction_product_races_pace_view_check" CHECK ("paceView" IS NULL OR length(btrim("paceView")) BETWEEN 1 AND 2000),
  ADD CONSTRAINT "prediction_product_races_short_comment_check" CHECK ("shortComment" IS NULL OR length(btrim("shortComment")) BETWEEN 1 AND 1000);

ALTER TABLE "prediction_product_selections"
  ADD COLUMN "evaluationType" TEXT,
  ADD COLUMN "reason" TEXT,
  ADD CONSTRAINT "prediction_product_selections_evaluation_type_check" CHECK ("evaluationType" IS NULL OR "evaluationType" IN ('PRIMARY','SECONDARY','WATCH','RISK')),
  ADD CONSTRAINT "prediction_product_selections_reason_check" CHECK ("reason" IS NULL OR length(btrim("reason")) BETWEEN 1 AND 1000);

UPDATE "prediction_product_selections"
SET "evaluationType" = CASE "selectionType" WHEN 'CENTER' THEN 'PRIMARY' WHEN 'SELECTED' THEN 'SECONDARY' END
WHERE "evaluationType" IS NULL;

CREATE UNIQUE INDEX "prediction_product_one_primary"
  ON "prediction_product_selections"("productRaceId") WHERE "evaluationType" = 'PRIMARY';

ALTER TABLE "prediction_product_versions"
  ADD COLUMN "formatVersion" TEXT NOT NULL DEFAULT 'LEGACY_BETTING_V1',
  ADD CONSTRAINT "prediction_product_versions_format_check" CHECK ("formatVersion" IN ('LEGACY_BETTING_V1','HORSE_EVALUATION_V1'));

CREATE TABLE "prediction_evaluations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "predictionVersionId" UUID NOT NULL REFERENCES "prediction_versions"("id") ON DELETE RESTRICT,
  "resultVersionId" UUID NOT NULL REFERENCES "race_result_versions"("id") ON DELETE RESTRICT,
  "raceId" UUID NOT NULL REFERENCES "races"("id") ON DELETE RESTRICT,
  "primaryFinishedFirst" BOOLEAN NOT NULL,
  "primaryFinishedTop2" BOOLEAN NOT NULL,
  "primaryFinishedTop3" BOOLEAN NOT NULL,
  "winnerInRecommended" BOOLEAN NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('PRIMARY_WIN','PRIMARY_TOP2','PRIMARY_TOP3','WINNER_IN_RECOMMENDED','WINNER_NOT_RECOMMENDED','SKIPPED','EXCLUDED','CANCELED','REVIEW_REQUIRED')),
  "confirmedBy" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "confirmedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "calculationRuleVersion" TEXT NOT NULL,
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  UNIQUE ("resultVersionId", "predictionVersionId"),
  CHECK (NOT "primaryFinishedFirst" OR "primaryFinishedTop2"),
  CHECK (NOT "primaryFinishedTop2" OR "primaryFinishedTop3"),
  CHECK (NOT "primaryFinishedFirst" OR "winnerInRecommended")
);
CREATE INDEX "prediction_evaluations_raceId_confirmedAt_idx" ON "prediction_evaluations"("raceId", "confirmedAt");

CREATE TABLE "win5_evaluation_drafts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL UNIQUE REFERENCES "prediction_products"("id") ON DELETE RESTRICT,
  "productVersionId" UUID NOT NULL REFERENCES "prediction_product_versions"("id") ON DELETE RESTRICT,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "status" TEXT NOT NULL CHECK ("status" IN ('READY','REVIEW_REQUIRED')),
  "sourceHash" TEXT NOT NULL CHECK (length("sourceHash") = 64),
  "legsSnapshot" JSONB NOT NULL CHECK (jsonb_typeof("legsSnapshot") = 'array'),
  "ruleVersion" TEXT NOT NULL,
  "updatedBy" UUID NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "win5_evaluation_drafts_productVersionId_idx" ON "win5_evaluation_drafts"("productVersionId");

CREATE TABLE "win5_evaluation_versions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" UUID NOT NULL REFERENCES "prediction_products"("id") ON DELETE RESTRICT,
  "productVersionId" UUID NOT NULL REFERENCES "prediction_product_versions"("id") ON DELETE RESTRICT,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" > 0),
  "status" TEXT NOT NULL CHECK ("status" IN ('WIN5_ALL_WINNERS_RECOMMENDED','WIN5_PARTIAL','WIN5_MISSED','REVIEW_REQUIRED')),
  "recommendedLegs" INTEGER NOT NULL CHECK ("recommendedLegs" BETWEEN 0 AND 5),
  "allWinnersRecommended" BOOLEAN NOT NULL,
  "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "confirmedBy" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "confirmedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "calculationRuleVersion" TEXT NOT NULL,
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  UNIQUE ("productId", "version"),
  UNIQUE ("productId", "sourceRevision"),
  CHECK ("allWinnersRecommended" = ("status" = 'WIN5_ALL_WINNERS_RECOMMENDED'))
);
CREATE INDEX "win5_evaluation_versions_confirmedAt_idx" ON "win5_evaluation_versions"("confirmedAt");

CREATE TABLE "win5_evaluation_legs" (
  "evaluationVersionId" UUID NOT NULL REFERENCES "win5_evaluation_versions"("id") ON DELETE RESTRICT,
  "legNumber" INTEGER NOT NULL CHECK ("legNumber" BETWEEN 1 AND 5),
  "raceId" UUID NOT NULL REFERENCES "races"("id") ON DELETE RESTRICT,
  "raceResultVersionId" UUID NOT NULL REFERENCES "race_result_versions"("id") ON DELETE RESTRICT,
  "winnerEntryId" UUID NOT NULL REFERENCES "race_entries"("id") ON DELETE RESTRICT,
  "winnerNumber" INTEGER NOT NULL CHECK ("winnerNumber" BETWEEN 1 AND 18),
  "winnerHorseName" TEXT NOT NULL CHECK (length(btrim("winnerHorseName")) > 0),
  "primaryFinishedFirst" BOOLEAN NOT NULL,
  "primaryFinishedTop2" BOOLEAN NOT NULL,
  "primaryFinishedTop3" BOOLEAN NOT NULL,
  "winnerInRecommended" BOOLEAN NOT NULL,
  "status" TEXT NOT NULL CHECK ("status" IN ('PRIMARY_WIN','PRIMARY_TOP2','PRIMARY_TOP3','WINNER_IN_RECOMMENDED','WINNER_NOT_RECOMMENDED','SKIPPED','EXCLUDED','CANCELED','REVIEW_REQUIRED')),
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  PRIMARY KEY ("evaluationVersionId", "legNumber"),
  UNIQUE ("evaluationVersionId", "raceId"),
  UNIQUE ("evaluationVersionId", "raceResultVersionId"),
  CHECK (NOT "primaryFinishedFirst" OR "primaryFinishedTop2"),
  CHECK (NOT "primaryFinishedTop2" OR "primaryFinishedTop3"),
  CHECK (NOT "primaryFinishedFirst" OR "winnerInRecommended")
);

CREATE FUNCTION validate_prediction_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prediction_race UUID; result_race UUID;
BEGIN
  SELECT p."raceId" INTO prediction_race FROM "prediction_versions" pv JOIN "predictions" p ON p."id" = pv."predictionId" WHERE pv."id" = NEW."predictionVersionId" FOR SHARE OF pv;
  SELECT "raceId" INTO result_race FROM "race_result_versions" WHERE "id" = NEW."resultVersionId" FOR SHARE;
  IF prediction_race IS DISTINCT FROM NEW."raceId" OR result_race IS DISTINCT FROM NEW."raceId" THEN
    RAISE EXCEPTION 'Prediction evaluation sources must belong to the same race';
  END IF;
  NEW."confirmedAt" := transaction_timestamp();
  NEW."createdTxId" := txid_current();
  RETURN NEW;
END; $$;
CREATE TRIGGER prediction_evaluation_validate BEFORE INSERT ON "prediction_evaluations" FOR EACH ROW EXECUTE FUNCTION validate_prediction_evaluation();

CREATE FUNCTION validate_win5_evaluation_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_product UUID; latest_version INTEGER;
BEGIN
  SELECT "productId" INTO source_product FROM "prediction_product_versions" WHERE "id" = NEW."productVersionId" FOR SHARE;
  IF source_product IS DISTINCT FROM NEW."productId" THEN RAISE EXCEPTION 'WIN5 evaluation product version mismatch'; END IF;
  SELECT coalesce(max("version"), 0) INTO latest_version FROM "win5_evaluation_versions" WHERE "productId" = NEW."productId";
  IF NEW."version" <> latest_version + 1 THEN RAISE EXCEPTION 'WIN5 evaluation version is not sequential'; END IF;
  NEW."confirmedAt" := transaction_timestamp();
  NEW."createdTxId" := txid_current();
  RETURN NEW;
END; $$;
CREATE TRIGGER win5_evaluation_version_validate BEFORE INSERT ON "win5_evaluation_versions" FOR EACH ROW EXECUTE FUNCTION validate_win5_evaluation_version();

CREATE FUNCTION validate_win5_evaluation_leg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_tx BIGINT; source_version UUID; snapshot_race UUID; result_race UUID; entry_race UUID; latest_result UUID;
BEGIN
  SELECT "createdTxId", "productVersionId" INTO parent_tx, source_version FROM "win5_evaluation_versions" WHERE "id" = NEW."evaluationVersionId" FOR SHARE;
  IF parent_tx IS NULL OR parent_tx <> txid_current() THEN RAISE EXCEPTION 'WIN5 evaluation legs must be inserted with their parent version'; END IF;
  SELECT (leg->'race'->>'id')::uuid INTO snapshot_race
    FROM "prediction_product_versions" pv, LATERAL jsonb_array_elements(pv."contentSnapshot"->'races') leg
   WHERE pv."id" = source_version AND (leg->>'legNumber')::integer = NEW."legNumber";
  SELECT "raceId" INTO result_race FROM "race_result_versions" WHERE "id" = NEW."raceResultVersionId" FOR SHARE;
  SELECT "id" INTO latest_result FROM "race_result_versions" WHERE "raceId" = NEW."raceId" ORDER BY "version" DESC LIMIT 1 FOR SHARE;
  SELECT "raceId" INTO entry_race FROM "race_entries" WHERE "id" = NEW."winnerEntryId" FOR SHARE;
  IF snapshot_race IS DISTINCT FROM NEW."raceId" OR result_race IS DISTINCT FROM NEW."raceId" OR entry_race IS DISTINCT FROM NEW."raceId" OR latest_result IS DISTINCT FROM NEW."raceResultVersionId" THEN
    RAISE EXCEPTION 'WIN5 evaluation leg sources do not match';
  END IF;
  NEW."createdTxId" := txid_current();
  RETURN NEW;
END; $$;
CREATE TRIGGER win5_evaluation_leg_validate BEFORE INSERT ON "win5_evaluation_legs" FOR EACH ROW EXECUTE FUNCTION validate_win5_evaluation_leg();

CREATE FUNCTION ensure_win5_evaluation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE leg_count INTEGER; recommended INTEGER; stored RECORD;
BEGIN
  SELECT count(*)::integer, count(*) FILTER (WHERE "winnerInRecommended")::integer INTO leg_count, recommended FROM "win5_evaluation_legs" WHERE "evaluationVersionId" = NEW."id";
  SELECT * INTO stored FROM "win5_evaluation_versions" WHERE "id" = NEW."id";
  IF leg_count <> 5 OR recommended <> stored."recommendedLegs"
     OR stored."allWinnersRecommended" IS DISTINCT FROM (stored."status" = 'WIN5_ALL_WINNERS_RECOMMENDED')
     OR (stored."status" = 'WIN5_ALL_WINNERS_RECOMMENDED' AND recommended <> 5)
     OR (stored."status" = 'WIN5_MISSED' AND recommended <> 0)
     OR (stored."status" = 'WIN5_PARTIAL' AND recommended NOT BETWEEN 1 AND 4) THEN
    RAISE EXCEPTION 'WIN5 evaluation calculation or five-leg set is incomplete';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER win5_evaluation_complete AFTER INSERT ON "win5_evaluation_versions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ensure_win5_evaluation_complete();

CREATE FUNCTION reject_evaluation_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Confirmed evaluation history is immutable'; END; $$;
CREATE TRIGGER prediction_evaluations_append_only BEFORE UPDATE OR DELETE ON "prediction_evaluations" FOR EACH ROW EXECUTE FUNCTION reject_evaluation_history_mutation();
CREATE TRIGGER prediction_evaluations_no_truncate BEFORE TRUNCATE ON "prediction_evaluations" FOR EACH STATEMENT EXECUTE FUNCTION reject_evaluation_history_mutation();
CREATE TRIGGER win5_evaluation_versions_append_only BEFORE UPDATE OR DELETE ON "win5_evaluation_versions" FOR EACH ROW EXECUTE FUNCTION reject_evaluation_history_mutation();
CREATE TRIGGER win5_evaluation_versions_no_truncate BEFORE TRUNCATE ON "win5_evaluation_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_evaluation_history_mutation();
CREATE TRIGGER win5_evaluation_legs_append_only BEFORE UPDATE OR DELETE ON "win5_evaluation_legs" FOR EACH ROW EXECUTE FUNCTION reject_evaluation_history_mutation();
CREATE TRIGGER win5_evaluation_legs_no_truncate BEFORE TRUNCATE ON "win5_evaluation_legs" FOR EACH STATEMENT EXECUTE FUNCTION reject_evaluation_history_mutation();
