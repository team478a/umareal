ALTER TABLE content_items
  ADD COLUMN "relatedHorseIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ADD CONSTRAINT content_items_related_horses_limit CHECK (cardinality("relatedHorseIds") <= 10);

ALTER TABLE content_versions
  ADD COLUMN "relatedHorseIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  ADD CONSTRAINT content_versions_related_horses_limit CHECK (cardinality("relatedHorseIds") <= 10);

CREATE INDEX content_versions_relatedHorseIds_idx ON content_versions USING GIN ("relatedHorseIds");

CREATE FUNCTION validate_content_horse_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE horse_id UUID;
BEGIN
  IF cardinality(NEW."relatedHorseIds") <> cardinality(ARRAY(SELECT DISTINCT value FROM unnest(NEW."relatedHorseIds") AS value)) THEN
    RAISE EXCEPTION 'Content related horses must be unique';
  END IF;
  FOREACH horse_id IN ARRAY NEW."relatedHorseIds" LOOP
    IF NOT EXISTS (SELECT 1 FROM horses WHERE id = horse_id) THEN
      RAISE EXCEPTION 'Content related horse does not exist';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER content_items_horse_links_guard
  BEFORE INSERT OR UPDATE OF "relatedHorseIds" ON content_items
  FOR EACH ROW EXECUTE FUNCTION validate_content_horse_links();

CREATE TRIGGER content_versions_horse_links_guard
  BEFORE INSERT ON content_versions
  FOR EACH ROW EXECUTE FUNCTION validate_content_horse_links();

CREATE OR REPLACE FUNCTION enforce_content_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_version INTEGER; item_status TEXT; publisher_role TEXT; publisher_disabled TIMESTAMPTZ;
BEGIN
  SELECT status INTO item_status FROM content_items WHERE id = NEW."contentId" FOR UPDATE;
  IF item_status IS NULL OR item_status = 'ARCHIVED' THEN RAISE EXCEPTION 'Content is missing or archived'; END IF;
  SELECT role::text, "disabledAt" INTO publisher_role, publisher_disabled FROM users WHERE id = NEW."publishedBy" FOR SHARE;
  IF publisher_disabled IS NOT NULL OR publisher_role NOT IN ('ADMIN','EDITOR') THEN RAISE EXCEPTION 'Content publisher is invalid'; END IF;
  SELECT COALESCE(MAX(version), 0) INTO previous_version FROM content_versions WHERE "contentId" = NEW."contentId";
  IF NEW.version <> previous_version + 1 THEN RAISE EXCEPTION 'Content version sequence is invalid'; END IF;
  IF jsonb_typeof(NEW.snapshot) <> 'object'
    OR NEW.snapshot->>'kind' IS DISTINCT FROM NEW.kind
    OR NEW.snapshot->>'title' IS DISTINCT FROM NEW.title
    OR NEW.snapshot->>'summary' IS DISTINCT FROM NEW.summary
    OR NEW.snapshot->>'category' IS DISTINCT FROM NEW.category
    OR NEW.snapshot->>'visibility' IS DISTINCT FROM NEW.visibility
    OR COALESCE(NEW.snapshot->'relatedRaceIds', '[]'::jsonb) IS DISTINCT FROM to_jsonb(NEW."relatedRaceIds")
    OR COALESCE(NEW.snapshot->'relatedHorseIds', '[]'::jsonb) IS DISTINCT FROM to_jsonb(NEW."relatedHorseIds")
  THEN RAISE EXCEPTION 'Content metadata does not match snapshot'; END IF;
  NEW."publishedAt" := clock_timestamp();
  NEW."createdTxId" := txid_current();
  RETURN NEW;
END $$;
