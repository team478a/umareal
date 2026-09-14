ALTER TABLE "system_settings"
  ADD COLUMN "newRegistrationsEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "registrationPauseMessage" TEXT NOT NULL DEFAULT '';

ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_registration_pause_message_length"
    CHECK (length("registrationPauseMessage") <= 500),
  ADD CONSTRAINT "system_settings_registration_pause_message_required"
    CHECK ("newRegistrationsEnabled" OR length(btrim("registrationPauseMessage")) > 0);
