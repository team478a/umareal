CREATE OR REPLACE FUNCTION enforce_content_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_version INTEGER; item_status TEXT; publisher_role TEXT; publisher_disabled TIMESTAMPTZ;
BEGIN
  SELECT status INTO item_status FROM content_items WHERE id = NEW."contentId" FOR UPDATE;
  IF item_status IS NULL OR item_status = 'ARCHIVED' THEN RAISE EXCEPTION 'Content is missing or archived'; END IF;
  SELECT role::text, "disabledAt" INTO publisher_role, publisher_disabled FROM users WHERE id = NEW."publishedBy" FOR SHARE;
  IF publisher_disabled IS NOT NULL OR publisher_role NOT IN ('ADMIN','EDITOR','OPERATOR') THEN RAISE EXCEPTION 'Content publisher is invalid'; END IF;
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
