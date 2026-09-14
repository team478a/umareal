CREATE TABLE "predictions" (
  "id" UUID PRIMARY KEY, "raceId" UUID NOT NULL UNIQUE REFERENCES "races"("id"),
  "draft" JSONB NOT NULL CHECK (jsonb_typeof("draft") = 'object'), "revision" INTEGER NOT NULL CHECK ("revision" > 0),
  "updatedBy" UUID NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "prediction_versions" (
  "id" UUID PRIMARY KEY, "predictionId" UUID NOT NULL REFERENCES "predictions"("id"), "version" INTEGER NOT NULL CHECK ("version" > 0),
  "status" TEXT NOT NULL CHECK ("status" IN ('PUBLISHED','CORRECTED')), "visibility" TEXT NOT NULL CHECK ("visibility" IN ('FREE','PAID')),
  "confidence" TEXT NOT NULL CHECK ("confidence" IN ('S','A','B','C')), "stance" TEXT NOT NULL CHECK ("stance" IN ('BET','NORMAL','SMALL','SKIP')),
  "summary" TEXT NOT NULL, "estimatedTotalYen" INTEGER NOT NULL CHECK ("estimatedTotalYen" >= 0),
  "contentSnapshot" JSONB NOT NULL, "assessmentSnapshot" JSONB NOT NULL, "publisherId" UUID NOT NULL,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "correctionReason" TEXT, "previousVersionId" UUID UNIQUE REFERENCES "prediction_versions"("id"),
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(), UNIQUE ("predictionId", "version"),
  CHECK (("version" = 1 AND "status" = 'PUBLISHED' AND "previousVersionId" IS NULL AND "correctionReason" IS NULL)
    OR ("version" > 1 AND "status" = 'CORRECTED' AND "previousVersionId" IS NOT NULL AND length(trim("correctionReason")) > 0))
);
CREATE TABLE "prediction_marks" (
  "id" UUID PRIMARY KEY, "versionId" UUID NOT NULL REFERENCES "prediction_versions"("id"), "entryId" UUID NOT NULL,
  "horseId" UUID NOT NULL, "horseNumber" INTEGER NOT NULL CHECK ("horseNumber" BETWEEN 1 AND 18), "horseName" TEXT NOT NULL,
  "mark" TEXT NOT NULL CHECK ("mark" IN ('HONMEI','TAIKO','TANANA','RENKA','ANA','DANGER')), "reason" TEXT NOT NULL,
  UNIQUE ("versionId", "entryId")
);
CREATE TABLE "prediction_bets" (
  "id" UUID PRIMARY KEY, "versionId" UUID NOT NULL REFERENCES "prediction_versions"("id"),
  "betType" TEXT NOT NULL CHECK ("betType" IN ('WIN','PLACE','QUINELLA','EXACTA','WIDE','TRIO','TRIFECTA')),
  "combination" JSONB NOT NULL CHECK (jsonb_typeof("combination") = 'array'), "amountPerPointYen" INTEGER NOT NULL CHECK ("amountPerPointYen" > 0 AND "amountPerPointYen" % 100 = 0),
  "points" INTEGER NOT NULL CHECK ("points" > 0), "totalYen" INTEGER NOT NULL CHECK ("totalYen" = "amountPerPointYen" * "points")
);
CREATE TABLE "publication_previews" (
  "id" UUID PRIMARY KEY, "actorId" UUID NOT NULL, "predictionId" UUID NOT NULL REFERENCES "predictions"("id"),
  "baselineHash" TEXT NOT NULL, "snapshot" JSONB NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "confirmedVersionId" UUID UNIQUE REFERENCES "prediction_versions"("id"), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "notification_events" (
  "id" UUID PRIMARY KEY, "versionId" UUID NOT NULL UNIQUE REFERENCES "prediction_versions"("id"),
  "eventType" TEXT NOT NULL, "status" TEXT NOT NULL CHECK ("status" IN ('QUEUED','SENDING','SENT','FAILED','RETRIED','SKIPPED')),
  "payload" JSONB NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION enforce_prediction_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE race_start TIMESTAMPTZ; race_state TEXT;
BEGIN
  SELECT r."startsAt", r."status" INTO race_start, race_state FROM "races" r JOIN "predictions" p ON p."raceId" = r."id" WHERE p."id" = NEW."predictionId" FOR SHARE;
  IF race_start IS NULL OR race_state IN ('FINISHED','CANCELLED') OR transaction_timestamp() >= race_start THEN
    RAISE EXCEPTION 'Prediction publication deadline has passed';
  END IF;
  NEW."publishedAt" := transaction_timestamp(); NEW."deadlineAt" := race_start; NEW."createdTxId" := txid_current();
  RETURN NEW;
END; $$;
CREATE TRIGGER prediction_deadline BEFORE INSERT ON "prediction_versions" FOR EACH ROW EXECUTE FUNCTION enforce_prediction_deadline();
CREATE FUNCTION protect_prediction_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Published prediction data is immutable'; END; $$;
CREATE TRIGGER prediction_version_immutable BEFORE UPDATE OR DELETE ON "prediction_versions" FOR EACH ROW EXECUTE FUNCTION protect_prediction_version();
CREATE TRIGGER prediction_version_no_truncate BEFORE TRUNCATE ON "prediction_versions" FOR EACH STATEMENT EXECUTE FUNCTION protect_prediction_version();
CREATE FUNCTION protect_prediction_children() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_tx BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "createdTxId" INTO owner_tx FROM "prediction_versions" WHERE "id" = NEW."versionId";
    IF owner_tx = txid_current() THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Published prediction child data is immutable';
END; $$;
CREATE TRIGGER prediction_marks_immutable BEFORE INSERT OR UPDATE OR DELETE ON "prediction_marks" FOR EACH ROW EXECUTE FUNCTION protect_prediction_children();
CREATE TRIGGER prediction_marks_no_truncate BEFORE TRUNCATE ON "prediction_marks" FOR EACH STATEMENT EXECUTE FUNCTION protect_prediction_version();
CREATE TRIGGER prediction_bets_immutable BEFORE INSERT OR UPDATE OR DELETE ON "prediction_bets" FOR EACH ROW EXECUTE FUNCTION protect_prediction_children();
CREATE TRIGGER prediction_bets_no_truncate BEFORE TRUNCATE ON "prediction_bets" FOR EACH STATEMENT EXECUTE FUNCTION protect_prediction_version();
