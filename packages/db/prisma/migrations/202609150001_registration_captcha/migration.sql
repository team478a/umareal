ALTER TABLE "system_settings"
  ADD COLUMN "registrationCaptchaEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "turnstileSiteKey" TEXT,
  ADD COLUMN "turnstileSecretEncrypted" TEXT;

ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_turnstile_site_key_length"
    CHECK ("turnstileSiteKey" IS NULL OR char_length("turnstileSiteKey") <= 100),
  ADD CONSTRAINT "system_settings_registration_captcha_configuration"
    CHECK (
      NOT "registrationCaptchaEnabled"
      OR (
        length(btrim(COALESCE("turnstileSiteKey", ''))) > 0
        AND length(btrim(COALESCE("turnstileSecretEncrypted", ''))) > 0
      )
    );
