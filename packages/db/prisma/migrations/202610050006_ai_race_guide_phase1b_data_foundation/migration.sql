CREATE TABLE "horse_external_identities" (
  "id" UUID NOT NULL,
  "horseId" UUID,
  "provider" TEXT NOT NULL,
  "externalKeyHash" TEXT NOT NULL,
  "sourceVersion" TEXT NOT NULL,
  "observedName" TEXT NOT NULL,
  "matchStatus" TEXT NOT NULL DEFAULT 'UNRESOLVED',
  "firstObservedAt" TIMESTAMPTZ(3) NOT NULL,
  "lastObservedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "horse_external_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "horse_external_identities_status_check" CHECK ("matchStatus" IN ('MATCHED', 'POSSIBLE_DUPLICATE', 'UNRESOLVED')),
  CONSTRAINT "horse_external_identities_hash_check" CHECK ("externalKeyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "horse_external_identities_matched_horse_check" CHECK ("matchStatus" <> 'MATCHED' OR "horseId" IS NOT NULL),
  CONSTRAINT "horse_external_identities_observed_at_check" CHECK ("firstObservedAt" <= "lastObservedAt")
);

CREATE UNIQUE INDEX "horse_external_identities_provider_externalKeyHash_key"
  ON "horse_external_identities"("provider", "externalKeyHash");
CREATE INDEX "horse_external_identities_horseId_provider_idx"
  ON "horse_external_identities"("horseId", "provider");
CREATE INDEX "horse_external_identities_observedName_matchStatus_idx"
  ON "horse_external_identities"("observedName", "matchStatus");

ALTER TABLE "horse_external_identities"
  ADD CONSTRAINT "horse_external_identities_horseId_fkey"
  FOREIGN KEY ("horseId") REFERENCES "horses"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE "data_license_policies" (
  "id" UUID NOT NULL,
  "provider" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "fieldName" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "storageUse" TEXT NOT NULL,
  "derivationUse" TEXT NOT NULL,
  "memberDisplayUse" TEXT NOT NULL,
  "externalAiUse" TEXT NOT NULL,
  "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
  "effectiveUntil" TIMESTAMPTZ(3),
  "decisionReference" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "data_license_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "data_license_policies_window_check" CHECK ("effectiveUntil" IS NULL OR "effectiveFrom" < "effectiveUntil"),
  CONSTRAINT "data_license_policies_storage_check" CHECK ("storageUse" IN ('APPROVED', 'INTERNAL_ONLY', 'LICENSE_REVIEW_REQUIRED', 'PROHIBITED')),
  CONSTRAINT "data_license_policies_derivation_check" CHECK ("derivationUse" IN ('APPROVED', 'INTERNAL_ONLY', 'LICENSE_REVIEW_REQUIRED', 'PROHIBITED')),
  CONSTRAINT "data_license_policies_member_display_check" CHECK ("memberDisplayUse" IN ('APPROVED', 'INTERNAL_ONLY', 'LICENSE_REVIEW_REQUIRED', 'PROHIBITED')),
  CONSTRAINT "data_license_policies_external_ai_check" CHECK ("externalAiUse" IN ('APPROVED', 'INTERNAL_ONLY', 'LICENSE_REVIEW_REQUIRED', 'PROHIBITED'))
);

CREATE UNIQUE INDEX "data_license_policies_provider_sourceKind_fieldName_policyVersion_key"
  ON "data_license_policies"("provider", "sourceKind", "fieldName", "policyVersion");
CREATE INDEX "data_license_policies_provider_sourceKind_fieldName_effectiveFrom_idx"
  ON "data_license_policies"("provider", "sourceKind", "fieldName", "effectiveFrom");

CREATE TABLE "race_entry_performances" (
  "id" UUID NOT NULL,
  "resultVersionId" UUID NOT NULL,
  "raceEntryId" UUID NOT NULL,
  "finishTimeMs" INTEGER,
  "marginText" TEXT,
  "finalSectionTimeMs" INTEGER,
  "bodyWeightKg" INTEGER,
  "bodyWeightChangeKg" INTEGER,
  "cornerPositions" JSONB,
  "sourceProvider" TEXT NOT NULL,
  "sourceVersion" TEXT NOT NULL,
  "sourceRecordReference" TEXT NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "importedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "licensePolicyId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_entry_performances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_entry_performances_finish_time_check" CHECK ("finishTimeMs" IS NULL OR "finishTimeMs" > 0),
  CONSTRAINT "race_entry_performances_final_section_check" CHECK ("finalSectionTimeMs" IS NULL OR "finalSectionTimeMs" > 0),
  CONSTRAINT "race_entry_performances_body_weight_check" CHECK ("bodyWeightKg" IS NULL OR "bodyWeightKg" BETWEEN 200 AND 800),
  CONSTRAINT "race_entry_performances_import_time_check" CHECK ("observedAt" <= "importedAt"),
  CONSTRAINT "race_entry_performances_has_extension_check" CHECK (
    "finishTimeMs" IS NOT NULL OR "marginText" IS NOT NULL OR "finalSectionTimeMs" IS NOT NULL OR
    "bodyWeightKg" IS NOT NULL OR "bodyWeightChangeKg" IS NOT NULL OR "cornerPositions" IS NOT NULL
  )
);

CREATE UNIQUE INDEX "race_entry_performances_resultVersionId_raceEntryId_key"
  ON "race_entry_performances"("resultVersionId", "raceEntryId");
CREATE INDEX "race_entry_performances_raceEntryId_observedAt_idx"
  ON "race_entry_performances"("raceEntryId", "observedAt");
CREATE INDEX "race_entry_performances_sourceProvider_sourceVersion_idx"
  ON "race_entry_performances"("sourceProvider", "sourceVersion");

ALTER TABLE "race_entry_performances"
  ADD CONSTRAINT "race_entry_performances_resultVersionId_fkey"
  FOREIGN KEY ("resultVersionId") REFERENCES "race_result_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "race_entry_performances"
  ADD CONSTRAINT "race_entry_performances_raceEntryId_fkey"
  FOREIGN KEY ("raceEntryId") REFERENCES "race_entries"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "race_entry_performances"
  ADD CONSTRAINT "race_entry_performances_licensePolicyId_fkey"
  FOREIGN KEY ("licensePolicyId") REFERENCES "data_license_policies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE OR REPLACE FUNCTION reject_ai_data_foundation_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER data_license_policies_append_only
  BEFORE UPDATE OR DELETE ON "data_license_policies"
  FOR EACH ROW EXECUTE FUNCTION reject_ai_data_foundation_mutation();
CREATE TRIGGER data_license_policies_no_truncate
  BEFORE TRUNCATE ON "data_license_policies"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ai_data_foundation_mutation();
CREATE TRIGGER race_entry_performances_append_only
  BEFORE UPDATE OR DELETE ON "race_entry_performances"
  FOR EACH ROW EXECUTE FUNCTION reject_ai_data_foundation_mutation();
CREATE TRIGGER race_entry_performances_no_truncate
  BEFORE TRUNCATE ON "race_entry_performances"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_ai_data_foundation_mutation();

CREATE OR REPLACE FUNCTION protect_horse_external_identity_key()
RETURNS trigger AS $$
BEGIN
  IF NEW."provider" <> OLD."provider" OR NEW."externalKeyHash" <> OLD."externalKeyHash" THEN
    RAISE EXCEPTION 'horse external identity key is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER horse_external_identity_key_immutable
  BEFORE UPDATE ON "horse_external_identities"
  FOR EACH ROW EXECUTE FUNCTION protect_horse_external_identity_key();
