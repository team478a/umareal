CREATE TABLE ai_race_guides (
  id UUID PRIMARY KEY,
  "raceId" UUID NOT NULL UNIQUE REFERENCES races(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  status TEXT NOT NULL DEFAULT 'DATA_PENDING' CHECK (status IN ('DATA_PENDING','QUEUED','GENERATING','VALIDATING','REVIEW_REQUIRED','READY','PUBLISHED','FAILED','STALE')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  "latestGenerationId" UUID UNIQUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ai_race_guides_status_updatedAt_idx ON ai_race_guides(status, "updatedAt");

CREATE TABLE ai_race_guide_generations (
  id UUID PRIMARY KEY,
  "guideId" UUID NOT NULL REFERENCES ai_race_guides(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "attemptNo" INTEGER NOT NULL CHECK ("attemptNo" > 0),
  "structuredInputSnapshot" JSONB NOT NULL,
  "inputHash" TEXT NOT NULL CHECK (char_length("inputHash") = 64),
  "dataCutoffAt" TIMESTAMPTZ(3) NOT NULL,
  "logicVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "sourceVersion" TEXT NOT NULL,
  "modelProvider" TEXT NOT NULL CHECK ("modelProvider" IN ('test','disabled')),
  "modelVersion" TEXT NOT NULL,
  "generatedOutput" JSONB,
  "validationStatus" TEXT NOT NULL CHECK ("validationStatus" IN ('VALID','INVALID','FAILED')),
  "validationErrors" JSONB NOT NULL,
  "failureCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("guideId", "attemptNo")
);
CREATE INDEX ai_race_guide_generations_guideId_createdAt_idx ON ai_race_guide_generations("guideId", "createdAt");
CREATE INDEX ai_race_guide_generations_inputHash_idx ON ai_race_guide_generations("inputHash");
ALTER TABLE ai_race_guides ADD CONSTRAINT ai_race_guides_latest_generation_fkey
  FOREIGN KEY ("latestGenerationId") REFERENCES ai_race_guide_generations(id) ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE TABLE ai_race_guide_versions (
  id UUID PRIMARY KEY,
  "guideId" UUID NOT NULL REFERENCES ai_race_guides(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "generationId" UUID NOT NULL UNIQUE REFERENCES ai_race_guide_generations(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  version INTEGER NOT NULL CHECK (version > 0),
  scope TEXT NOT NULL CHECK (scope = 'FREE_PREVIEW_PAID_FULL'),
  "previewSnapshot" JSONB NOT NULL,
  "fullSnapshot" JSONB NOT NULL,
  "dataCutoffAt" TIMESTAMPTZ(3) NOT NULL,
  "generatedAt" TIMESTAMPTZ(3) NOT NULL,
  "modelVersion" TEXT NOT NULL,
  "logicVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "sourceVersion" TEXT NOT NULL,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedBy" UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "correctionReason" TEXT,
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  UNIQUE ("guideId", version)
);
CREATE INDEX ai_race_guide_versions_publishedAt_idx ON ai_race_guide_versions("publishedAt");

CREATE TABLE ai_race_guide_version_horses (
  "versionId" UUID NOT NULL REFERENCES ai_race_guide_versions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "horseId" UUID NOT NULL REFERENCES horses(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "raceEntryId" UUID NOT NULL REFERENCES race_entries(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  "relationKind" TEXT NOT NULL CHECK ("relationKind" IN ('ATTENTION','POSITIVE','CAUTION','PADDOCK_CHECK')),
  PRIMARY KEY ("versionId", "horseId", "relationKind")
);
CREATE INDEX ai_race_guide_version_horses_horseId_versionId_idx ON ai_race_guide_version_horses("horseId", "versionId");

CREATE FUNCTION enforce_ai_race_guide_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_attempt INTEGER;
BEGIN
  PERFORM 1 FROM ai_race_guides WHERE id = NEW."guideId" FOR UPDATE;
  SELECT COALESCE(MAX("attemptNo"), 0) INTO previous_attempt FROM ai_race_guide_generations WHERE "guideId" = NEW."guideId";
  IF NEW."attemptNo" <> previous_attempt + 1 THEN RAISE EXCEPTION 'AI guide generation sequence is invalid'; END IF;
  IF NEW."modelProvider" <> 'test' OR NEW."validationStatus" = 'VALID' AND NEW."generatedOutput" IS NULL THEN
    RAISE EXCEPTION 'AI guide generation provider or output is invalid';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ai_race_guide_generation_guard BEFORE INSERT ON ai_race_guide_generations FOR EACH ROW EXECUTE FUNCTION enforce_ai_race_guide_generation();
CREATE TRIGGER ai_race_guide_generations_immutable BEFORE UPDATE OR DELETE ON ai_race_guide_generations FOR EACH ROW EXECUTE FUNCTION protect_prediction_version();
CREATE TRIGGER ai_race_guide_generations_no_truncate BEFORE TRUNCATE ON ai_race_guide_generations FOR EACH STATEMENT EXECUTE FUNCTION protect_prediction_version();

CREATE FUNCTION enforce_ai_race_guide_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_version INTEGER; generation_record RECORD; publisher_role TEXT; publisher_disabled TIMESTAMPTZ; race_start TIMESTAMPTZ; race_status TEXT;
BEGIN
  PERFORM 1 FROM ai_race_guides WHERE id = NEW."guideId" FOR UPDATE;
  SELECT COALESCE(MAX(version), 0) INTO previous_version FROM ai_race_guide_versions WHERE "guideId" = NEW."guideId";
  IF NEW.version <> previous_version + 1 OR (previous_version > 0 AND COALESCE(btrim(NEW."correctionReason"), '') = '') THEN
    RAISE EXCEPTION 'AI guide version sequence or correction reason is invalid';
  END IF;
  SELECT * INTO generation_record FROM ai_race_guide_generations WHERE id = NEW."generationId" AND "guideId" = NEW."guideId";
  IF generation_record.id IS NULL OR generation_record."validationStatus" <> 'VALID' OR generation_record."generatedOutput" IS NULL THEN
    RAISE EXCEPTION 'AI guide generation is not publishable';
  END IF;
  IF NEW."fullSnapshot" IS DISTINCT FROM generation_record."generatedOutput" OR NOT (NEW."previewSnapshot" <@ NEW."fullSnapshot") THEN
    RAISE EXCEPTION 'AI guide snapshots do not match the validated generation';
  END IF;
  SELECT role::text, "disabledAt" INTO publisher_role, publisher_disabled FROM users WHERE id = NEW."publishedBy" FOR SHARE;
  IF publisher_role <> 'ADMIN' OR publisher_disabled IS NOT NULL THEN RAISE EXCEPTION 'AI guide publisher is invalid'; END IF;
  SELECT r."startsAt", r.status INTO race_start, race_status FROM races r JOIN ai_race_guides g ON g."raceId" = r.id WHERE g.id = NEW."guideId" FOR SHARE;
  IF race_start IS NULL OR clock_timestamp() >= race_start OR race_status IN ('FINISHED','CANCELLED') THEN RAISE EXCEPTION 'AI guide publication is closed'; END IF;
  NEW."publishedAt" := clock_timestamp(); NEW."createdTxId" := txid_current();
  RETURN NEW;
END $$;
CREATE TRIGGER ai_race_guide_publication_guard BEFORE INSERT ON ai_race_guide_versions FOR EACH ROW EXECUTE FUNCTION enforce_ai_race_guide_publication();
CREATE TRIGGER ai_race_guide_versions_immutable BEFORE UPDATE OR DELETE ON ai_race_guide_versions FOR EACH ROW EXECUTE FUNCTION protect_prediction_version();
CREATE TRIGGER ai_race_guide_versions_no_truncate BEFORE TRUNCATE ON ai_race_guide_versions FOR EACH STATEMENT EXECUTE FUNCTION protect_prediction_version();
CREATE TRIGGER ai_race_guide_version_horses_immutable BEFORE UPDATE OR DELETE ON ai_race_guide_version_horses FOR EACH ROW EXECUTE FUNCTION protect_prediction_version();
CREATE TRIGGER ai_race_guide_version_horses_no_truncate BEFORE TRUNCATE ON ai_race_guide_version_horses FOR EACH STATEMENT EXECUTE FUNCTION protect_prediction_version();

UPDATE system_settings SET "contentAccessPolicy" = jsonb_set(jsonb_set(jsonb_set(
  "contentAccessPolicy", '{monthly,aiRaceGuide}', 'true'::jsonb, true),
  '{dayPass,aiRaceGuide}', 'true'::jsonb, true),
  '{manual,aiRaceGuide}', 'true'::jsonb, true);
ALTER TABLE system_settings ALTER COLUMN "contentAccessPolicy" SET DEFAULT '{"monthly":{"paddock":true,"win5":true,"racePaper":true,"content":true,"aiRaceGuide":true},"dayPass":{"paddock":true,"win5":true,"racePaper":true,"content":false,"aiRaceGuide":true},"manual":{"paddock":true,"win5":true,"racePaper":true,"content":true,"aiRaceGuide":true}}'::jsonb;
CREATE FUNCTION normalize_ai_race_guide_content_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."contentAccessPolicy" := jsonb_set(jsonb_set(jsonb_set(
    NEW."contentAccessPolicy", '{monthly,aiRaceGuide}', COALESCE(NEW."contentAccessPolicy"->'monthly'->'aiRaceGuide', 'false'::jsonb), true),
    '{dayPass,aiRaceGuide}', COALESCE(NEW."contentAccessPolicy"->'dayPass'->'aiRaceGuide', 'false'::jsonb), true),
    '{manual,aiRaceGuide}', COALESCE(NEW."contentAccessPolicy"->'manual'->'aiRaceGuide', 'false'::jsonb), true);
  RETURN NEW;
END $$;
CREATE TRIGGER system_settings_ai_race_guide_policy_compat
  BEFORE INSERT OR UPDATE OF "contentAccessPolicy" ON system_settings
  FOR EACH ROW EXECUTE FUNCTION normalize_ai_race_guide_content_access();
ALTER TABLE system_settings DROP CONSTRAINT system_settings_content_access_policy_shape;
ALTER TABLE system_settings ADD CONSTRAINT system_settings_content_access_policy_shape CHECK ((
  jsonb_typeof("contentAccessPolicy") = 'object'
  AND jsonb_typeof("contentAccessPolicy"->'monthly'->'paddock') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'monthly'->'win5') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'monthly'->'racePaper') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'monthly'->'content') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'monthly'->'aiRaceGuide') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'paddock') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'win5') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'racePaper') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'content') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'dayPass'->'aiRaceGuide') = 'boolean'
  AND jsonb_typeof("contentAccessPolicy"->'manual'->'paddock') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'manual'->'win5') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'manual'->'racePaper') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'manual'->'content') = 'boolean' AND jsonb_typeof("contentAccessPolicy"->'manual'->'aiRaceGuide') = 'boolean'
) IS TRUE);
