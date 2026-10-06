-- Manual operation may register an entry from number and name without inventing unknown details.
ALTER TABLE "race_entries"
  ALTER COLUMN "gate" DROP NOT NULL,
  ALTER COLUMN "sex" DROP NOT NULL,
  ALTER COLUMN "age" DROP NOT NULL,
  ALTER COLUMN "carriedWeight" DROP NOT NULL,
  ALTER COLUMN "jockey" DROP NOT NULL,
  ALTER COLUMN "trainer" DROP NOT NULL;
