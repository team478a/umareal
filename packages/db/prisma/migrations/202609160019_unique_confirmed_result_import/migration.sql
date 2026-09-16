CREATE UNIQUE INDEX "import_batches_confirmed_result_source_unique"
ON "import_batches" (("rows"->>'providerId'), ("rows"->>'sourceChecksum'))
WHERE "kind" = 'results-batch'
  AND "confirmedAt" IS NOT NULL
  AND "rows"->>'providerId' IS NOT NULL
  AND "rows"->>'sourceChecksum' IS NOT NULL;
