CREATE TABLE "race_days" (
  "id" UUID NOT NULL, "raceDate" TEXT NOT NULL, "venue" TEXT NOT NULL,
  CONSTRAINT "race_days_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "race_days_raceDate_venue_key" ON "race_days"("raceDate", "venue");
ALTER TABLE "races" ADD COLUMN "raceDayId" UUID, ADD COLUMN "raceClass" TEXT,
  ADD COLUMN "distance" INTEGER, ADD COLUMN "surface" TEXT, ADD COLUMN "direction" TEXT,
  ADD COLUMN "going" TEXT, ADD COLUMN "weather" TEXT, ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
INSERT INTO "race_days" ("id", "raceDate", "venue") SELECT gen_random_uuid(), "raceDate", "venue" FROM "races" GROUP BY "raceDate", "venue";
UPDATE "races" SET "raceDayId" = d."id" FROM "race_days" d WHERE d."raceDate" = "races"."raceDate" AND d."venue" = "races"."venue";
ALTER TABLE "races" ADD CONSTRAINT "races_raceDayId_fkey" FOREIGN KEY ("raceDayId") REFERENCES "race_days"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "horses" ("id" UUID NOT NULL, "name" TEXT NOT NULL, CONSTRAINT "horses_pkey" PRIMARY KEY ("id"));
CREATE TABLE "race_entries" (
  "id" UUID NOT NULL, "raceId" UUID NOT NULL, "horseId" UUID NOT NULL,
  "number" INTEGER NOT NULL, "gate" INTEGER NOT NULL, "horseName" TEXT NOT NULL, "sex" TEXT NOT NULL,
  "age" INTEGER NOT NULL, "carriedWeight" DECIMAL(4,1) NOT NULL, "jockey" TEXT NOT NULL, "trainer" TEXT NOT NULL,
  "winOdds" DECIMAL(8,1), "popularity" INTEGER, "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT "race_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "entry_number" CHECK ("number" BETWEEN 1 AND 18),
  CONSTRAINT "entry_gate" CHECK ("gate" BETWEEN 1 AND 8),
  CONSTRAINT "entry_weight" CHECK ("carriedWeight" BETWEEN 30 AND 80),
  CONSTRAINT "entry_age" CHECK ("age" BETWEEN 2 AND 30),
  CONSTRAINT "entry_odds" CHECK ("winOdds" >= 1),
  CONSTRAINT "entry_popularity" CHECK ("popularity" BETWEEN 1 AND 18),
  CONSTRAINT "entry_status" CHECK ("status" IN ('ACTIVE','SCRATCHED','EXCLUDED','STOPPED')),
  CONSTRAINT "entry_sex" CHECK ("sex" IN ('MALE','FEMALE','GELDING'))
);
CREATE UNIQUE INDEX "race_entries_raceId_number_key" ON "race_entries"("raceId", "number");
CREATE UNIQUE INDEX "race_entries_raceId_horseId_key" ON "race_entries"("raceId", "horseId");
ALTER TABLE "race_entries" ADD CONSTRAINT "race_entries_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "race_entries" ADD CONSTRAINT "race_entries_horseId_fkey" FOREIGN KEY ("horseId") REFERENCES "horses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "import_batches" (
  "id" UUID NOT NULL, "actorId" UUID NOT NULL, "kind" TEXT NOT NULL, "raceId" UUID,
  "rows" JSONB NOT NULL, "baselineHash" TEXT NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "confirmedAt" TIMESTAMPTZ(3), "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);
