CREATE TABLE "rate_limit_buckets" (
  "scope" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "totalHits" INTEGER NOT NULL DEFAULT 0,
  "resetAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("scope", "keyHash"),
  CONSTRAINT "rate_limit_buckets_scope_check" CHECK ("scope" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  CONSTRAINT "rate_limit_buckets_key_hash_check" CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "rate_limit_buckets_total_hits_check" CHECK ("totalHits" >= 0)
);

CREATE INDEX "rate_limit_buckets_resetAt_idx" ON "rate_limit_buckets"("resetAt");
