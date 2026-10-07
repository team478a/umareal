ALTER TABLE system_settings
  ADD COLUMN "freePredictionTrialEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "freePredictionTrialEndsAt" TIMESTAMPTZ(3);

ALTER TABLE system_settings
  ADD CONSTRAINT "system_settings_free_prediction_trial_window_check"
  CHECK (
    ("freePredictionTrialEnabled" = true AND "freePredictionTrialEndsAt" IS NOT NULL)
    OR
    ("freePredictionTrialEnabled" = false AND "freePredictionTrialEndsAt" IS NULL)
  );
