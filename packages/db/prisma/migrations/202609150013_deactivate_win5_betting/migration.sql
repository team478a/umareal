-- Keep legacy values, but allow new horse-evaluation publications to omit them.
ALTER TABLE "prediction_product_races"
  ALTER COLUMN "strategyType" DROP NOT NULL,
  ALTER COLUMN "comment" DROP NOT NULL,
  DROP CONSTRAINT "prediction_product_races_strategyType_check",
  DROP CONSTRAINT "prediction_product_races_comment_check",
  ADD CONSTRAINT "prediction_product_races_strategyType_legacy_check" CHECK ("strategyType" IS NULL OR "strategyType" IN ('NARROW','NORMAL','SPREAD')),
  ADD CONSTRAINT "prediction_product_races_comment_legacy_check" CHECK ("comment" IS NULL OR length(btrim("comment")) BETWEEN 1 AND 2000);

ALTER TABLE "prediction_product_selections"
  ALTER COLUMN "selectionType" DROP NOT NULL,
  DROP CONSTRAINT "prediction_product_selections_selectionType_check",
  ADD CONSTRAINT "prediction_product_selections_selectionType_legacy_check" CHECK ("selectionType" IS NULL OR "selectionType" IN ('CENTER','SELECTED')),
  ADD CONSTRAINT "prediction_product_selections_current_or_legacy_check" CHECK ("selectionType" IS NOT NULL OR "evaluationType" IS NOT NULL);

ALTER TABLE "prediction_product_versions"
  ALTER COLUMN "combinationCount" DROP NOT NULL,
  ALTER COLUMN "amountPerPointYen" DROP NOT NULL,
  ALTER COLUMN "assumedPurchaseAmountYen" DROP NOT NULL,
  DROP CONSTRAINT "prediction_product_versions_combinationCount_check",
  DROP CONSTRAINT "prediction_product_versions_amountPerPointYen_check",
  DROP CONSTRAINT "prediction_product_versions_check",
  ADD CONSTRAINT "prediction_product_versions_legacy_amounts_check" CHECK (
    ("formatVersion" = 'LEGACY_BETTING_V1' AND "combinationCount" > 0 AND "amountPerPointYen" > 0 AND "amountPerPointYen" % 100 = 0 AND "assumedPurchaseAmountYen" = "combinationCount" * "amountPerPointYen")
    OR
    ("formatVersion" = 'HORSE_EVALUATION_V1' AND "combinationCount" IS NULL AND "amountPerPointYen" IS NULL AND "assumedPurchaseAmountYen" IS NULL)
  );
