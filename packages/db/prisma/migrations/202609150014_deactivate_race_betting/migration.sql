ALTER TABLE "prediction_versions"
  ALTER COLUMN "stance" DROP NOT NULL,
  ALTER COLUMN "estimatedTotalYen" DROP NOT NULL,
  DROP CONSTRAINT "prediction_versions_stance_check",
  DROP CONSTRAINT "prediction_versions_estimatedTotalYen_check",
  ADD COLUMN "formatVersion" TEXT NOT NULL DEFAULT 'LEGACY_BETTING_V1',
  ADD CONSTRAINT "prediction_versions_stance_legacy_check" CHECK ("stance" IS NULL OR "stance" IN ('BET','NORMAL','SMALL','SKIP')),
  ADD CONSTRAINT "prediction_versions_format_check" CHECK ("formatVersion" IN ('LEGACY_BETTING_V1','HORSE_EVALUATION_V1')),
  ADD CONSTRAINT "prediction_versions_format_values_check" CHECK (
    ("formatVersion" = 'LEGACY_BETTING_V1' AND "stance" IS NOT NULL AND "estimatedTotalYen" IS NOT NULL AND "estimatedTotalYen" >= 0)
    OR
    ("formatVersion" = 'HORSE_EVALUATION_V1' AND "stance" IS NULL AND "estimatedTotalYen" IS NULL)
  );
