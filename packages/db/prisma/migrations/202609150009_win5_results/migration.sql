CREATE TABLE "win5_result_drafts" (
  "id" UUID PRIMARY KEY,
  "productId" UUID NOT NULL UNIQUE REFERENCES "prediction_products"("id") ON DELETE RESTRICT,
  "productVersionId" UUID NOT NULL REFERENCES "prediction_product_versions"("id") ON DELETE RESTRICT,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "status" TEXT NOT NULL CHECK ("status" IN ('READY','REVIEW_REQUIRED')),
  "officialPayoutYen" INTEGER NOT NULL CHECK ("officialPayoutYen" BETWEEN 1 AND 100000000),
  "sourceHash" TEXT NOT NULL CHECK (length("sourceHash") = 64),
  "legsSnapshot" JSONB NOT NULL CHECK (jsonb_typeof("legsSnapshot") = 'array'),
  "ruleVersion" TEXT NOT NULL,
  "updatedBy" UUID NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "win5_result_drafts_productVersionId_idx" ON "win5_result_drafts"("productVersionId");

CREATE TABLE "win5_result_versions" (
  "id" UUID PRIMARY KEY,
  "productId" UUID NOT NULL REFERENCES "prediction_products"("id") ON DELETE RESTRICT,
  "productVersionId" UUID NOT NULL REFERENCES "prediction_product_versions"("id") ON DELETE RESTRICT,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" > 0),
  "status" TEXT NOT NULL DEFAULT 'CONFIRMED' CHECK ("status" = 'CONFIRMED'),
  "ruleVersion" TEXT NOT NULL,
  "hitLegs" INTEGER NOT NULL CHECK ("hitLegs" BETWEEN 0 AND 5),
  "perfectHit" BOOLEAN NOT NULL,
  "combinationCount" INTEGER NOT NULL CHECK ("combinationCount" > 0),
  "assumedPurchaseAmountYen" INTEGER NOT NULL CHECK ("assumedPurchaseAmountYen" > 0),
  "officialPayoutYen" INTEGER NOT NULL CHECK ("officialPayoutYen" BETWEEN 1 AND 100000000),
  "assumedPayoutYen" INTEGER NOT NULL CHECK ("assumedPayoutYen" >= 0),
  "recoveryRateTenthsPercent" INTEGER NOT NULL CHECK ("recoveryRateTenthsPercent" >= 0),
  "reason" TEXT NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  "confirmedBy" UUID NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "confirmedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  UNIQUE ("productId", "version"),
  UNIQUE ("productId", "sourceRevision")
);
CREATE INDEX "win5_result_versions_confirmedAt_idx" ON "win5_result_versions"("confirmedAt");

CREATE TABLE "win5_result_legs" (
  "resultVersionId" UUID NOT NULL REFERENCES "win5_result_versions"("id") ON DELETE RESTRICT,
  "legNumber" INTEGER NOT NULL CHECK ("legNumber" BETWEEN 1 AND 5),
  "raceId" UUID NOT NULL REFERENCES "races"("id") ON DELETE RESTRICT,
  "raceResultVersionId" UUID NOT NULL REFERENCES "race_result_versions"("id") ON DELETE RESTRICT,
  "winnerEntryId" UUID NOT NULL REFERENCES "race_entries"("id") ON DELETE RESTRICT,
  "winnerNumber" INTEGER NOT NULL CHECK ("winnerNumber" BETWEEN 1 AND 18),
  "winnerHorseName" TEXT NOT NULL CHECK (length(btrim("winnerHorseName")) > 0),
  "hit" BOOLEAN NOT NULL,
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  PRIMARY KEY ("resultVersionId", "legNumber"),
  UNIQUE ("resultVersionId", "raceId"),
  UNIQUE ("resultVersionId", "raceResultVersionId")
);

CREATE FUNCTION validate_win5_result_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_product UUID; latest_product_version UUID; latest_result_version INTEGER;
BEGIN
  SELECT "productId" INTO source_product FROM "prediction_product_versions" WHERE "id" = NEW."productVersionId" FOR SHARE;
  SELECT "id" INTO latest_product_version FROM "prediction_product_versions" WHERE "productId" = NEW."productId" ORDER BY "version" DESC LIMIT 1 FOR SHARE;
  IF source_product IS DISTINCT FROM NEW."productId" OR latest_product_version IS DISTINCT FROM NEW."productVersionId" THEN
    RAISE EXCEPTION 'WIN5 result must use the latest frozen product version';
  END IF;
  SELECT coalesce(max("version"), 0) INTO latest_result_version FROM "win5_result_versions" WHERE "productId" = NEW."productId";
  IF NEW."version" <> latest_result_version + 1 THEN RAISE EXCEPTION 'WIN5 result version is not sequential'; END IF;
  NEW."confirmedAt" := transaction_timestamp();
  NEW."createdTxId" := txid_current();
  RETURN NEW;
END; $$;
CREATE TRIGGER win5_result_version_validate BEFORE INSERT ON "win5_result_versions" FOR EACH ROW EXECUTE FUNCTION validate_win5_result_version();

CREATE FUNCTION validate_win5_result_leg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_tx BIGINT; source_version UUID; snapshot_race UUID; result_race UUID; entry_race UUID; snapshot_selected BOOLEAN; latest_race_result UUID; actual_number INTEGER; actual_name TEXT; winner_valid BOOLEAN;
BEGIN
  SELECT "createdTxId", "productVersionId" INTO parent_tx, source_version FROM "win5_result_versions" WHERE "id" = NEW."resultVersionId" FOR SHARE;
  IF parent_tx IS NULL OR parent_tx <> txid_current() THEN RAISE EXCEPTION 'WIN5 result legs must be inserted with their parent version'; END IF;
  SELECT (leg->'race'->>'id')::uuid,
         EXISTS (SELECT 1 FROM jsonb_array_elements(leg->'selections') selection WHERE selection->>'entryId' = NEW."winnerEntryId"::text)
    INTO snapshot_race, snapshot_selected
    FROM "prediction_product_versions" pv,
         LATERAL jsonb_array_elements(pv."contentSnapshot"->'races') leg
   WHERE pv."id" = source_version AND (leg->>'legNumber')::integer = NEW."legNumber";
  SELECT "raceId", EXISTS (
    SELECT 1 FROM jsonb_array_elements("entriesSnapshot") item
    WHERE item->>'entryId' = NEW."winnerEntryId"::text AND item->>'status' = 'FINISHED' AND (item->>'finishPosition')::integer = 1
  ) INTO result_race, winner_valid FROM "race_result_versions" WHERE "id" = NEW."raceResultVersionId" FOR SHARE;
  SELECT "id" INTO latest_race_result FROM "race_result_versions" WHERE "raceId" = NEW."raceId" ORDER BY "version" DESC LIMIT 1 FOR SHARE;
  SELECT "raceId", "number", "horseName" INTO entry_race, actual_number, actual_name FROM "race_entries" WHERE "id" = NEW."winnerEntryId" FOR SHARE;
  IF snapshot_race IS NULL OR snapshot_race IS DISTINCT FROM NEW."raceId" OR result_race IS DISTINCT FROM NEW."raceId" OR entry_race IS DISTINCT FROM NEW."raceId"
     OR latest_race_result IS DISTINCT FROM NEW."raceResultVersionId" OR NOT coalesce(winner_valid, false)
     OR actual_number IS DISTINCT FROM NEW."winnerNumber" OR actual_name IS DISTINCT FROM NEW."winnerHorseName" THEN
    RAISE EXCEPTION 'WIN5 result leg sources do not match the frozen product version';
  END IF;
  IF NEW."hit" IS DISTINCT FROM snapshot_selected THEN RAISE EXCEPTION 'WIN5 result leg hit does not match the frozen selections'; END IF;
  NEW."createdTxId" := txid_current();
  RETURN NEW;
END; $$;
CREATE TRIGGER win5_result_leg_validate BEFORE INSERT ON "win5_result_legs" FOR EACH ROW EXECUTE FUNCTION validate_win5_result_leg();

CREATE FUNCTION ensure_win5_result_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE leg_count INTEGER; actual_hits INTEGER; expected_payout INTEGER; expected_rate INTEGER; stored RECORD;
BEGIN
  SELECT count(*)::integer, count(*) FILTER (WHERE "hit")::integer INTO leg_count, actual_hits FROM "win5_result_legs" WHERE "resultVersionId" = NEW."id";
  SELECT * INTO stored FROM "win5_result_versions" WHERE "id" = NEW."id";
  expected_payout := CASE WHEN actual_hits = 5 THEN stored."officialPayoutYen" ELSE 0 END;
  expected_rate := round(expected_payout::numeric / stored."assumedPurchaseAmountYen" * 1000)::integer;
  IF leg_count <> 5 OR actual_hits <> stored."hitLegs" OR stored."perfectHit" IS DISTINCT FROM (actual_hits = 5)
     OR stored."assumedPayoutYen" <> expected_payout OR stored."recoveryRateTenthsPercent" <> expected_rate THEN
    RAISE EXCEPTION 'WIN5 result calculation or five-leg set is incomplete';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER win5_result_complete AFTER INSERT ON "win5_result_versions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ensure_win5_result_complete();

CREATE FUNCTION reject_win5_result_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Confirmed WIN5 result history is immutable'; END; $$;
CREATE TRIGGER win5_result_versions_append_only BEFORE UPDATE OR DELETE ON "win5_result_versions" FOR EACH ROW EXECUTE FUNCTION reject_win5_result_history_mutation();
CREATE TRIGGER win5_result_versions_no_truncate BEFORE TRUNCATE ON "win5_result_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_win5_result_history_mutation();
CREATE TRIGGER win5_result_legs_append_only BEFORE UPDATE OR DELETE ON "win5_result_legs" FOR EACH ROW EXECUTE FUNCTION reject_win5_result_history_mutation();
CREATE TRIGGER win5_result_legs_no_truncate BEFORE TRUNCATE ON "win5_result_legs" FOR EACH STATEMENT EXECUTE FUNCTION reject_win5_result_history_mutation();
