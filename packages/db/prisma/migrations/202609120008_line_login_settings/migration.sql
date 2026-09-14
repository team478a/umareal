ALTER TABLE "system_settings"
  ADD COLUMN "lineLoginEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "lineLoginChannelId" TEXT,
  ADD COLUMN "lineLoginChannelSecretEncrypted" TEXT,
  ADD COLUMN "lineLoginCallbackUrl" TEXT,
  ADD CONSTRAINT "system_settings_line_login_complete" CHECK (
    NOT "lineLoginEnabled" OR (
      "lineLoginChannelId" IS NOT NULL AND
      "lineLoginChannelSecretEncrypted" IS NOT NULL AND
      "lineLoginCallbackUrl" IS NOT NULL
    )
  );
