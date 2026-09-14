CREATE TABLE "race_result_drafts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "raceId" UUID NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
  "content" JSONB NOT NULL, "updatedBy" UUID NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_result_drafts_pkey" PRIMARY KEY ("id"), CONSTRAINT "race_result_drafts_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "race_result_drafts_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "race_result_drafts_raceId_key" ON "race_result_drafts"("raceId");

CREATE TABLE "race_result_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "raceId" UUID NOT NULL, "version" INTEGER NOT NULL, "sourceRevision" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
  "ruleVersion" TEXT NOT NULL, "raceCanceled" BOOLEAN NOT NULL DEFAULT false, "entriesSnapshot" JSONB NOT NULL, "payoutsSnapshot" JSONB NOT NULL,
  "reason" TEXT NOT NULL, "confirmedBy" UUID NOT NULL, "confirmedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  CONSTRAINT "race_result_versions_pkey" PRIMARY KEY ("id"), CONSTRAINT "race_result_versions_status_check" CHECK ("status" = 'CONFIRMED'),
  CONSTRAINT "race_result_versions_version_check" CHECK ("version" > 0), CONSTRAINT "race_result_versions_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "race_result_versions_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "race_result_versions_raceId_version_key" ON "race_result_versions"("raceId", "version");
CREATE UNIQUE INDEX "race_result_versions_raceId_sourceRevision_key" ON "race_result_versions"("raceId", "sourceRevision");
CREATE INDEX "race_result_versions_confirmedAt_idx" ON "race_result_versions"("confirmedAt");

CREATE TABLE "prediction_performances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "resultVersionId" UUID NOT NULL, "predictionVersionId" UUID NOT NULL,
  "excluded" BOOLEAN NOT NULL, "hit" BOOLEAN NOT NULL, "stakeYen" INTEGER NOT NULL, "refundYen" INTEGER NOT NULL,
  "payoutYen" INTEGER NOT NULL, "returnYen" INTEGER NOT NULL, "honmeiPosition" INTEGER, "createdTxId" BIGINT NOT NULL DEFAULT txid_current(),
  CONSTRAINT "prediction_performances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prediction_performances_amounts_check" CHECK ("stakeYen" >= 0 AND "refundYen" >= 0 AND "payoutYen" >= 0 AND "returnYen" = "refundYen" + "payoutYen"),
  CONSTRAINT "prediction_performances_resultVersionId_fkey" FOREIGN KEY ("resultVersionId") REFERENCES "race_result_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "prediction_performances_predictionVersionId_fkey" FOREIGN KEY ("predictionVersionId") REFERENCES "prediction_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "prediction_performances_result_prediction_key" ON "prediction_performances"("resultVersionId", "predictionVersionId");

CREATE TABLE "bet_performances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "performanceId" UUID NOT NULL, "predictionBetId" UUID NOT NULL,
  "hit" BOOLEAN NOT NULL, "stakeYen" INTEGER NOT NULL, "refundYen" INTEGER NOT NULL, "payoutYen" INTEGER NOT NULL, "returnYen" INTEGER NOT NULL, "settlement" JSONB NOT NULL,
  CONSTRAINT "bet_performances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bet_performances_amounts_check" CHECK ("stakeYen" >= 0 AND "refundYen" >= 0 AND "payoutYen" >= 0 AND "returnYen" = "refundYen" + "payoutYen"),
  CONSTRAINT "bet_performances_performanceId_fkey" FOREIGN KEY ("performanceId") REFERENCES "prediction_performances"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "bet_performances_predictionBetId_fkey" FOREIGN KEY ("predictionBetId") REFERENCES "prediction_bets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "bet_performances_performance_bet_key" ON "bet_performances"("performanceId", "predictionBetId");

CREATE OR REPLACE FUNCTION enforce_result_child_insert_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_tx BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'prediction_performances' THEN SELECT "createdTxId" INTO parent_tx FROM "race_result_versions" WHERE id = NEW."resultVersionId";
  ELSE SELECT "createdTxId" INTO parent_tx FROM "prediction_performances" WHERE id = NEW."performanceId";
  END IF;
  IF parent_tx IS NULL OR parent_tx <> txid_current() THEN RAISE EXCEPTION '% can only be inserted with its parent', TG_TABLE_NAME USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prediction_performances_insert_guard BEFORE INSERT ON "prediction_performances" FOR EACH ROW EXECUTE FUNCTION enforce_result_child_insert_transaction();
CREATE TRIGGER bet_performances_insert_guard BEFORE INSERT ON "bet_performances" FOR EACH ROW EXECUTE FUNCTION enforce_result_child_insert_transaction();

CREATE OR REPLACE FUNCTION reject_result_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '42501'; END $$;
CREATE TRIGGER race_result_versions_append_only BEFORE UPDATE OR DELETE ON "race_result_versions" FOR EACH ROW EXECUTE FUNCTION reject_result_history_mutation();
CREATE TRIGGER race_result_versions_no_truncate BEFORE TRUNCATE ON "race_result_versions" FOR EACH STATEMENT EXECUTE FUNCTION reject_result_history_mutation();
CREATE TRIGGER prediction_performances_append_only BEFORE UPDATE OR DELETE ON "prediction_performances" FOR EACH ROW EXECUTE FUNCTION reject_result_history_mutation();
CREATE TRIGGER prediction_performances_no_truncate BEFORE TRUNCATE ON "prediction_performances" FOR EACH STATEMENT EXECUTE FUNCTION reject_result_history_mutation();
CREATE TRIGGER bet_performances_append_only BEFORE UPDATE OR DELETE ON "bet_performances" FOR EACH ROW EXECUTE FUNCTION reject_result_history_mutation();
CREATE TRIGGER bet_performances_no_truncate BEFORE TRUNCATE ON "bet_performances" FOR EACH STATEMENT EXECUTE FUNCTION reject_result_history_mutation();
