CREATE TABLE "system_settings" (
  "id" TEXT PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "predictionPublicationEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "csvImportEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "lineNotificationsEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "newPurchasesEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "maintenanceMessage" TEXT NOT NULL DEFAULT '' CHECK (length("maintenanceMessage") <= 500),
  "notificationMaxAttempts" INTEGER NOT NULL DEFAULT 5 CHECK ("notificationMaxAttempts" BETWEEN 1 AND 10),
  "notificationBaseDelaySeconds" INTEGER NOT NULL DEFAULT 30 CHECK ("notificationBaseDelaySeconds" BETWEEN 10 AND 3600),
  "lineChannelId" TEXT,
  "lineChannelSecretEncrypted" TEXT,
  "lineAccessTokenEncrypted" TEXT,
  "updatedBy" UUID,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("id" = 'global'),
  CHECK (NOT "lineNotificationsEnabled" OR ("lineChannelId" IS NOT NULL AND "lineChannelSecretEncrypted" IS NOT NULL AND "lineAccessTokenEncrypted" IS NOT NULL))
);

INSERT INTO "system_settings" ("id") VALUES ('global');
