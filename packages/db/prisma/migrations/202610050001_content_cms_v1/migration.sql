UPDATE system_settings
SET "contentAccessPolicy" = jsonb_set(
  jsonb_set(
    jsonb_set("contentAccessPolicy", '{monthly,content}', 'true'::jsonb, true),
    '{dayPass,content}', 'false'::jsonb, true
  ),
  '{manual,content}', 'true'::jsonb, true
);

ALTER TABLE system_settings
ALTER COLUMN "contentAccessPolicy" SET DEFAULT '{"monthly":{"paddock":true,"win5":true,"racePaper":true,"content":true},"dayPass":{"paddock":true,"win5":true,"racePaper":true,"content":false},"manual":{"paddock":true,"win5":true,"racePaper":true,"content":true}}'::jsonb;

ALTER TABLE system_settings DROP CONSTRAINT system_settings_content_access_policy_shape;
ALTER TABLE system_settings ADD CONSTRAINT system_settings_content_access_policy_shape CHECK ((
  jsonb_typeof("contentAccessPolicy") = 'object'
  AND jsonb_typeof("contentAccessPolicy"->'monthly') = 'object'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass') = 'object'
  AND jsonb_typeof("contentAccessPolicy"->'manual') = 'object'
  AND jsonb_typeof("contentAccessPolicy"->'monthly'->'paddock') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'monthly'->'win5') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'monthly'->'racePaper') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'monthly'->'content') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'paddock') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'win5') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'racePaper') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'content') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'manual'->'paddock') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'manual'->'win5') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'manual'->'racePaper') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'manual'->'content') = 'boolean'
) IS TRUE);

CREATE TABLE content_items (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ARTICLE','VIDEO','AUDIO')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SCHEDULED','PUBLISHED','ARCHIVED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  summary TEXT NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 500),
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000),
  "thumbnailUrl" TEXT,
  "mediaUrl" TEXT,
  category TEXT NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 80),
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (cardinality(tags) <= 10),
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC','MEMBERS','PAID')),
  "scheduledAt" TIMESTAMPTZ(3),
  "scheduledRevision" INTEGER,
  "scheduleReason" TEXT,
  "scheduleError" TEXT,
  "createdBy" UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "updatedBy" UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT content_items_media_check CHECK ((kind = 'ARTICLE' AND "mediaUrl" IS NULL) OR (kind IN ('VIDEO','AUDIO') AND "mediaUrl" IS NOT NULL)),
  CONSTRAINT content_items_schedule_check CHECK (
    (status = 'SCHEDULED' AND "scheduledAt" IS NOT NULL AND "scheduledRevision" = revision AND char_length(btrim("scheduleReason")) BETWEEN 1 AND 500)
    OR (status <> 'SCHEDULED' AND "scheduledAt" IS NULL AND "scheduledRevision" IS NULL AND "scheduleReason" IS NULL)
  )
);
CREATE INDEX content_items_status_scheduledAt_idx ON content_items(status, "scheduledAt");
CREATE INDEX content_items_updatedAt_idx ON content_items("updatedAt");

CREATE TABLE content_versions (
  id UUID PRIMARY KEY,
  "contentId" UUID NOT NULL REFERENCES content_items(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  version INTEGER NOT NULL CHECK (version > 0),
  kind TEXT NOT NULL CHECK (kind IN ('ARTICLE','VIDEO','AUDIO')),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  summary TEXT NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 500),
  "thumbnailUrl" TEXT,
  category TEXT NOT NULL CHECK (char_length(btrim(category)) BETWEEN 1 AND 80),
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (cardinality(tags) <= 10),
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC','MEMBERS','PAID')),
  snapshot JSONB NOT NULL,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedBy" UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  UNIQUE ("contentId", version)
);
CREATE INDEX content_versions_publishedAt_idx ON content_versions("publishedAt");
CREATE INDEX content_versions_kind_publishedAt_idx ON content_versions(kind, "publishedAt");

CREATE TRIGGER content_versions_immutable BEFORE UPDATE OR DELETE ON content_versions FOR EACH ROW EXECUTE FUNCTION protect_prediction_version();
CREATE TRIGGER content_versions_no_truncate BEFORE TRUNCATE ON content_versions FOR EACH STATEMENT EXECUTE FUNCTION protect_prediction_version();

CREATE FUNCTION enforce_content_publication() RETURNS trigger LANGUAGE plpgsql AS $$
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
  THEN RAISE EXCEPTION 'Content metadata does not match snapshot'; END IF;
  NEW."publishedAt" := clock_timestamp();
  NEW."createdTxId" := txid_current();
  RETURN NEW;
END $$;
CREATE TRIGGER content_publication_guard BEFORE INSERT ON content_versions FOR EACH ROW EXECUTE FUNCTION enforce_content_publication();
