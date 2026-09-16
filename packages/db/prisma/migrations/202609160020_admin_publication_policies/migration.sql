ALTER TABLE "system_settings"
  ADD COLUMN "predictionCorrectionPolicy" TEXT NOT NULL DEFAULT 'ADMIN_ONLY',
  ADD COLUMN "delayedPublicationPolicy" TEXT NOT NULL DEFAULT 'CLOSED';

ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_prediction_correction_policy_check"
    CHECK ("predictionCorrectionPolicy" IN ('ADMIN_ONLY', 'EXPERT_OR_ADMIN')),
  ADD CONSTRAINT "system_settings_delayed_publication_policy_check"
    CHECK ("delayedPublicationPolicy" IN ('CLOSED', 'LATEST_STARTS_AT'));
