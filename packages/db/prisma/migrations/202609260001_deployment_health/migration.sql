CREATE TABLE "service_heartbeats" (
  "service" VARCHAR(32) NOT NULL,
  "releaseCommit" VARCHAR(40),
  "heartbeatAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "service_heartbeats_pkey" PRIMARY KEY ("service"),
  CONSTRAINT "service_heartbeats_service_check" CHECK (char_length("service") BETWEEN 1 AND 32),
  CONSTRAINT "service_heartbeats_release_commit_check" CHECK ("releaseCommit" IS NULL OR "releaseCommit" ~ '^[0-9a-f]{40}$')
);
