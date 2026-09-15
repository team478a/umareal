CREATE FUNCTION lock_race_result_stream() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW."raceId"::text));
  RETURN NEW;
END; $$;
CREATE TRIGGER race_result_version_stream_lock BEFORE INSERT ON "race_result_versions" FOR EACH ROW EXECUTE FUNCTION lock_race_result_stream();

CREATE OR REPLACE FUNCTION validate_win5_result_leg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_tx BIGINT; source_version UUID; snapshot_race UUID; result_race UUID; entry_race UUID; snapshot_selected BOOLEAN; latest_race_result UUID; actual_number INTEGER; actual_name TEXT; winner_valid BOOLEAN;
BEGIN
  SELECT "createdTxId", "productVersionId" INTO parent_tx, source_version FROM "win5_result_versions" WHERE "id" = NEW."resultVersionId" FOR SHARE;
  IF parent_tx IS NULL OR parent_tx <> txid_current() THEN RAISE EXCEPTION 'WIN5 result legs must be inserted with their parent version'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW."raceId"::text));
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
