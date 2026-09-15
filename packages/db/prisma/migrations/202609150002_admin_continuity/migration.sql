ALTER TABLE "users"
  ADD COLUMN "externalBackupMfaFactorId" UUID,
  ADD COLUMN "pendingExternalMfaFactorId" UUID,
  ADD COLUMN "pendingExternalMfaKind" TEXT,
  ADD COLUMN "pendingExternalMfaExpiresAt" TIMESTAMPTZ(3);

ALTER TABLE "users"
  ADD CONSTRAINT "users_external_mfa_factors_distinct"
    CHECK (
      "externalBackupMfaFactorId" IS NULL
      OR "externalMfaFactorId" IS NULL
      OR "externalBackupMfaFactorId" <> "externalMfaFactorId"
    ),
  ADD CONSTRAINT "users_pending_external_mfa_complete"
    CHECK (
      ("pendingExternalMfaFactorId" IS NULL AND "pendingExternalMfaKind" IS NULL AND "pendingExternalMfaExpiresAt" IS NULL)
      OR
      ("pendingExternalMfaFactorId" IS NOT NULL AND "pendingExternalMfaKind" IN ('PRIMARY', 'BACKUP') AND "pendingExternalMfaExpiresAt" IS NOT NULL)
    );

CREATE UNIQUE INDEX "users_externalMfaFactorId_key" ON "users"("externalMfaFactorId") WHERE "externalMfaFactorId" IS NOT NULL;
CREATE UNIQUE INDEX "users_externalBackupMfaFactorId_key" ON "users"("externalBackupMfaFactorId") WHERE "externalBackupMfaFactorId" IS NOT NULL;
CREATE UNIQUE INDEX "users_pendingExternalMfaFactorId_key" ON "users"("pendingExternalMfaFactorId") WHERE "pendingExternalMfaFactorId" IS NOT NULL;
