ALTER TABLE "system_settings"
  ADD COLUMN "win5DefaultAmountPerPointYen" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "win5CombinationWarningLimit" INTEGER NOT NULL DEFAULT 1000,
  ADD CONSTRAINT "system_settings_win5_amount_check" CHECK ("win5DefaultAmountPerPointYen" > 0 AND "win5DefaultAmountPerPointYen" % 100 = 0),
  ADD CONSTRAINT "system_settings_win5_warning_check" CHECK ("win5CombinationWarningLimit" > 0);

CREATE TABLE "prediction_products" (
  "id" UUID PRIMARY KEY,
  "type" TEXT NOT NULL DEFAULT 'WIN5_PREVIEW' CHECK ("type" = 'WIN5_PREVIEW'),
  "targetDate" TEXT NOT NULL CHECK ("targetDate" ~ '^\d{4}-\d{2}-\d{2}$'),
  "title" TEXT NOT NULL CHECK (length(trim("title")) BETWEEN 1 AND 120),
  "expertId" UUID NOT NULL REFERENCES "users"("id"),
  "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT','PUBLISHED','CORRECTED')),
  "accessScope" TEXT NOT NULL DEFAULT 'PAID' CHECK ("accessScope" IN ('FREE','PAID')),
  "scheduledPublishAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),
  "closeAt" TIMESTAMPTZ(3),
  "confidence" TEXT NOT NULL CHECK ("confidence" IN ('S','A','B','C')),
  "summary" TEXT NOT NULL DEFAULT '' CHECK (length("summary") <= 5000),
  "showFreeConfidence" BOOLEAN NOT NULL DEFAULT false,
  "amountPerPointYen" INTEGER NOT NULL DEFAULT 100 CHECK ("amountPerPointYen" > 0 AND "amountPerPointYen" % 100 = 0),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "updatedBy" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("type", "targetDate")
);
CREATE INDEX "prediction_products_expertId_targetDate_idx" ON "prediction_products"("expertId", "targetDate");

CREATE TABLE "prediction_product_races" (
  "id" UUID PRIMARY KEY,
  "productId" UUID NOT NULL REFERENCES "prediction_products"("id"),
  "raceId" UUID NOT NULL REFERENCES "races"("id"),
  "legNumber" INTEGER NOT NULL CHECK ("legNumber" BETWEEN 1 AND 5),
  "confidence" TEXT NOT NULL CHECK ("confidence" IN ('S','A','B','C')),
  "strategyType" TEXT NOT NULL CHECK ("strategyType" IN ('NARROW','NORMAL','SPREAD')),
  "comment" TEXT NOT NULL CHECK (length(trim("comment")) BETWEEN 1 AND 2000),
  UNIQUE ("productId", "legNumber"),
  UNIQUE ("productId", "raceId")
);

CREATE FUNCTION validate_prediction_product_race() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE product_date TEXT; race_date TEXT;
BEGIN
  SELECT "targetDate" INTO product_date FROM "prediction_products" WHERE "id" = NEW."productId" FOR SHARE;
  SELECT "raceDate" INTO race_date FROM "races" WHERE "id" = NEW."raceId" FOR SHARE;
  IF product_date IS NULL OR race_date IS NULL OR product_date <> race_date THEN
    RAISE EXCEPTION 'WIN5 race date must match product target date';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER prediction_product_race_date BEFORE INSERT OR UPDATE ON "prediction_product_races" FOR EACH ROW EXECUTE FUNCTION validate_prediction_product_race();

CREATE TABLE "prediction_product_selections" (
  "id" UUID PRIMARY KEY,
  "productRaceId" UUID NOT NULL REFERENCES "prediction_product_races"("id") ON DELETE CASCADE,
  "entryId" UUID NOT NULL REFERENCES "race_entries"("id"),
  "selectionType" TEXT NOT NULL CHECK ("selectionType" IN ('CENTER','SELECTED')),
  "displayOrder" INTEGER NOT NULL CHECK ("displayOrder" > 0),
  UNIQUE ("productRaceId", "entryId")
);
CREATE UNIQUE INDEX "prediction_product_one_center" ON "prediction_product_selections"("productRaceId") WHERE "selectionType" = 'CENTER';

CREATE FUNCTION validate_prediction_product_selection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_race UUID; entry_race UUID;
BEGIN
  SELECT "raceId" INTO expected_race FROM "prediction_product_races" WHERE "id" = NEW."productRaceId" FOR SHARE;
  SELECT "raceId" INTO entry_race FROM "race_entries" WHERE "id" = NEW."entryId" FOR SHARE;
  IF expected_race IS NULL OR entry_race IS NULL OR expected_race <> entry_race THEN
    RAISE EXCEPTION 'WIN5 selection must belong to its race';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER prediction_product_selection_race BEFORE INSERT OR UPDATE ON "prediction_product_selections" FOR EACH ROW EXECUTE FUNCTION validate_prediction_product_selection();

CREATE TABLE "prediction_product_versions" (
  "id" UUID PRIMARY KEY,
  "productId" UUID NOT NULL REFERENCES "prediction_products"("id"),
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "status" TEXT NOT NULL CHECK ("status" IN ('PUBLISHED','CORRECTED')),
  "accessScope" TEXT NOT NULL CHECK ("accessScope" IN ('FREE','PAID')),
  "confidence" TEXT NOT NULL CHECK ("confidence" IN ('S','A','B','C')),
  "combinationCount" INTEGER NOT NULL CHECK ("combinationCount" > 0),
  "amountPerPointYen" INTEGER NOT NULL CHECK ("amountPerPointYen" > 0 AND "amountPerPointYen" % 100 = 0),
  "assumedPurchaseAmountYen" INTEGER NOT NULL CHECK ("assumedPurchaseAmountYen" = "combinationCount" * "amountPerPointYen"),
  "contentSnapshot" JSONB NOT NULL CHECK (jsonb_typeof("contentSnapshot") = 'object'),
  "publisherId" UUID NOT NULL REFERENCES "users"("id"),
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "correctionReason" TEXT,
  "previousVersionId" UUID UNIQUE REFERENCES "prediction_product_versions"("id"),
  "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  UNIQUE ("productId", "version"),
  CHECK (("version" = 1 AND "status" = 'PUBLISHED' AND "previousVersionId" IS NULL AND "correctionReason" IS NULL)
    OR ("version" > 1 AND "status" = 'CORRECTED' AND "previousVersionId" IS NOT NULL AND length(trim("correctionReason")) > 0))
);
CREATE INDEX "prediction_product_versions_publishedAt_idx" ON "prediction_product_versions"("publishedAt");

CREATE TABLE "prediction_product_previews" (
  "id" UUID PRIMARY KEY,
  "actorId" UUID NOT NULL,
  "productId" UUID NOT NULL REFERENCES "prediction_products"("id"),
  "baselineHash" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL CHECK (jsonb_typeof("snapshot") = 'object'),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "confirmedVersionId" UUID UNIQUE REFERENCES "prediction_product_versions"("id"),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "prediction_product_previews_productId_expiresAt_idx" ON "prediction_product_previews"("productId", "expiresAt");

CREATE FUNCTION enforce_prediction_product_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE calculated_deadline TIMESTAMPTZ; leg_count INTEGER; latest_version INTEGER; previous_product UUID;
BEGIN
  SELECT min(r."startsAt"), count(*)::int INTO calculated_deadline, leg_count
  FROM "prediction_product_races" pr JOIN "races" r ON r."id" = pr."raceId"
  WHERE pr."productId" = NEW."productId";
  IF leg_count <> 5 OR calculated_deadline IS NULL OR transaction_timestamp() >= calculated_deadline THEN
    RAISE EXCEPTION 'WIN5 publication deadline has passed or five races are incomplete';
  END IF;
  SELECT coalesce(max("version"), 0) INTO latest_version FROM "prediction_product_versions" WHERE "productId" = NEW."productId";
  IF NEW."version" <> latest_version + 1 THEN RAISE EXCEPTION 'WIN5 version is not sequential'; END IF;
  IF NEW."previousVersionId" IS NOT NULL THEN
    SELECT "productId" INTO previous_product FROM "prediction_product_versions" WHERE "id" = NEW."previousVersionId";
    IF previous_product IS DISTINCT FROM NEW."productId" THEN RAISE EXCEPTION 'WIN5 previous version belongs to another product'; END IF;
  END IF;
  NEW."publishedAt" := transaction_timestamp();
  NEW."deadlineAt" := calculated_deadline;
  NEW."createdTxId" := txid_current();
  RETURN NEW;
END; $$;
CREATE TRIGGER prediction_product_deadline BEFORE INSERT ON "prediction_product_versions" FOR EACH ROW EXECUTE FUNCTION enforce_prediction_product_deadline();

CREATE FUNCTION protect_prediction_product_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published WIN5 prediction data is immutable'; END; $$;
CREATE TRIGGER prediction_product_version_immutable BEFORE UPDATE OR DELETE ON "prediction_product_versions" FOR EACH ROW EXECUTE FUNCTION protect_prediction_product_version();
CREATE TRIGGER prediction_product_version_no_truncate BEFORE TRUNCATE ON "prediction_product_versions" FOR EACH STATEMENT EXECUTE FUNCTION protect_prediction_product_version();
