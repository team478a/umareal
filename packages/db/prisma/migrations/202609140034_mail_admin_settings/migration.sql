ALTER TABLE "system_settings"
  ADD COLUMN "mailApiKeyEncrypted" TEXT,
  ADD COLUMN "mailFrom" TEXT;

ALTER TABLE "system_settings"
  ADD CONSTRAINT "system_settings_mail_from_length"
  CHECK ("mailFrom" IS NULL OR char_length("mailFrom") <= 320);
