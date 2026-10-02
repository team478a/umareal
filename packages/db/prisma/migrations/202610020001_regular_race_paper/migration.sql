CREATE TABLE "race_papers" (
  id UUID PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), draft JSONB NOT NULL,
  "updatedBy" UUID NOT NULL REFERENCES users(id), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "race_paper_versions" (
  id UUID PRIMARY KEY, "paperId" UUID NOT NULL REFERENCES race_papers(id), version INTEGER NOT NULL CHECK (version > 0),
  "targetDate" TEXT NOT NULL, title TEXT NOT NULL, "accessScope" TEXT NOT NULL CHECK ("accessScope" IN ('MEMBERS','PAID')),
  snapshot JSONB NOT NULL, "deadlineAt" TIMESTAMPTZ(3) NOT NULL, "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedBy" UUID NOT NULL REFERENCES users(id), "correctionReason" TEXT, "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  UNIQUE ("paperId", version)
);
CREATE INDEX "race_paper_versions_targetDate_publishedAt_idx" ON race_paper_versions("targetDate", "publishedAt");
CREATE TABLE "race_paper_previews" (
  id UUID PRIMARY KEY, "paperId" UUID NOT NULL REFERENCES race_papers(id), "actorId" UUID NOT NULL REFERENCES users(id),
  "baselineHash" TEXT NOT NULL, version INTEGER NOT NULL, "correctionReason" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL, "confirmedVersionId" UUID REFERENCES race_paper_versions(id)
);
ALTER TABLE notification_events ADD COLUMN "paperVersionId" UUID REFERENCES race_paper_versions(id);
CREATE UNIQUE INDEX "notification_events_paperVersionId_key" ON notification_events("paperVersionId");
ALTER TABLE notification_events DROP CONSTRAINT notification_events_target_check;
ALTER TABLE notification_events ADD CONSTRAINT notification_events_target_check CHECK (
  num_nonnulls("versionId", "announcementId", "freeReportVersionId", "productVersionId",
    "raceResultVersionId", "win5EvaluationVersionId", "supportEventId", "billingEventId", "paperVersionId") = 1
);
CREATE TRIGGER race_paper_versions_immutable BEFORE UPDATE OR DELETE ON race_paper_versions FOR EACH ROW EXECUTE FUNCTION protect_prediction_version();
CREATE TRIGGER race_paper_versions_no_truncate BEFORE TRUNCATE ON race_paper_versions FOR EACH STATEMENT EXECUTE FUNCTION protect_prediction_version();

CREATE FUNCTION enforce_race_paper_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_version INTEGER; earliest TIMESTAMPTZ; previous_deadline TIMESTAMPTZ; actual_count INTEGER; expected_count INTEGER;
BEGIN
  PERFORM 1 FROM race_papers WHERE id = NEW."paperId" FOR UPDATE;
  SELECT COALESCE(MAX(version), 0), MIN("deadlineAt") INTO previous_version, previous_deadline FROM race_paper_versions WHERE "paperId" = NEW."paperId";
  IF NEW.version <> previous_version + 1 OR (previous_version > 0 AND COALESCE(btrim(NEW."correctionReason"), '') = '') THEN
    RAISE EXCEPTION 'Paper version sequence or correction reason is invalid';
  END IF;
  IF NEW.snapshot->>'targetDate' IS DISTINCT FROM NEW."targetDate" OR NEW.snapshot->>'title' IS DISTINCT FROM NEW.title OR NEW.snapshot->>'accessScope' IS DISTINCT FROM NEW."accessScope" THEN
    RAISE EXCEPTION 'Paper metadata does not match snapshot';
  END IF;
  IF EXISTS (SELECT 1 FROM race_paper_versions WHERE "paperId" = NEW."paperId" AND "targetDate" <> NEW."targetDate") THEN
    RAISE EXCEPTION 'Published paper target date is frozen';
  END IF;
  PERFORM 1 FROM races r WHERE r.id IN (
    SELECT (item->>'raceId')::uuid FROM jsonb_array_elements(NEW.snapshot->'races') item
    UNION SELECT (item->>'raceId')::uuid FROM race_paper_versions pv,
      jsonb_array_elements(pv.snapshot->'races') item WHERE pv."paperId" = NEW."paperId"
  ) ORDER BY r.id FOR SHARE;
  expected_count := jsonb_array_length(NEW.snapshot->'races');
  SELECT count(DISTINCT r.id), MIN(LEAST(r."startsAt", (item->>'startsAt')::timestamptz)) INTO actual_count, earliest
    FROM jsonb_array_elements(NEW.snapshot->'races') item JOIN races r ON r.id = (item->>'raceId')::uuid
    WHERE r."raceDate" = NEW."targetDate" AND r.status NOT IN ('FINISHED','CANCELLED');
  IF expected_count IS NULL OR expected_count NOT BETWEEN 1 AND 12 OR actual_count <> expected_count THEN RAISE EXCEPTION 'Paper race targets are invalid'; END IF;
  -- An earlier published race cannot be removed to reopen the correction window.
  SELECT LEAST(earliest, MIN(r."startsAt")) INTO earliest FROM race_paper_versions pv,
    jsonb_array_elements(pv.snapshot->'races') item JOIN races r ON r.id = (item->>'raceId')::uuid WHERE pv."paperId" = NEW."paperId";
  earliest := LEAST(earliest, previous_deadline);
  IF earliest IS NULL OR clock_timestamp() >= earliest OR NEW."deadlineAt" > earliest OR NEW."publishedAt" > clock_timestamp() THEN RAISE EXCEPTION 'Paper publication deadline has passed or is invalid'; END IF;
  NEW."publishedAt" := clock_timestamp();
  NEW."createdTxId" := txid_current();
  RETURN NEW;
END $$;
CREATE TRIGGER race_paper_publication_guard BEFORE INSERT ON race_paper_versions FOR EACH ROW EXECUTE FUNCTION enforce_race_paper_publication();

CREATE FUNCTION enforce_race_paper_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_tx BIGINT; source_version INTEGER;
BEGIN
  IF NEW."paperVersionId" IS NULL THEN RETURN NEW; END IF;
  SELECT "createdTxId", version INTO source_tx, source_version FROM race_paper_versions WHERE id = NEW."paperVersionId";
  IF source_tx IS NULL OR source_tx <> txid_current() OR NEW."eventType" <> (CASE WHEN source_version = 1 THEN 'RACE_PAPER_PUBLISHED' ELSE 'RACE_PAPER_CORRECTED' END) THEN
    RAISE EXCEPTION 'Paper notification must match its publication transaction and version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER race_paper_notification_guard BEFORE INSERT ON notification_events FOR EACH ROW EXECUTE FUNCTION enforce_race_paper_notification();
