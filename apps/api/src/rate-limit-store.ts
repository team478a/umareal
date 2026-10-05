import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { ipKeyGenerator, type ClientRateLimitInfo, type Options, type Store } from 'express-rate-limit';
import { Prisma } from '@keiba/db';

type RateLimitDatabase = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

type BucketRow = { totalHits: number; resetAt: Date };

export const RATE_LIMIT_WINDOW_MS = 60_000;

export class RateLimitStoreUnavailableError extends Error {
  constructor(cause?: unknown) { super('Shared rate-limit store is unavailable', { cause }); this.name = 'RateLimitStoreUnavailableError'; }
}

export function validateRateLimitScope(scope: string) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(scope)) throw new Error('Invalid rate-limit scope');
  return scope;
}

export function rateLimitIdentity(request: Request) {
  const proxied = request.header('x-umareal-client-key');
  if (proxied && /^[0-9a-f]{64}$/.test(proxied)) return `proxy:${proxied}`;
  return `ip:${ipKeyGenerator(request.ip || request.socket.remoteAddress || 'unknown', 56)}`;
}

export function hashRateLimitKey(secret: string, scope: string, identity: string) {
  if (Buffer.from(secret, 'base64').length !== 32) throw new Error('Configure ENCRYPTION_KEY');
  return createHmac('sha256', Buffer.from(secret, 'base64')).update(`${validateRateLimitScope(scope)}\0${identity}`).digest('hex');
}

export class PostgresRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = RATE_LIMIT_WINDOW_MS;

  constructor(private readonly db: RateLimitDatabase, readonly scope: string) {
    this.scope = validateRateLimitScope(scope);
    this.prefix = `${scope}:`;
  }

  init(options: Options) {
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) throw new Error('Invalid rate-limit window');
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Rate-limit store requires a hashed key');
    try {
      const rows = await this.db.$queryRaw<BucketRow[]>(Prisma.sql`
        INSERT INTO "rate_limit_buckets" ("scope", "keyHash", "totalHits", "resetAt", "updatedAt")
        VALUES (${this.scope}, ${key}, 1, CURRENT_TIMESTAMP + (${this.windowMs} * INTERVAL '1 millisecond'), CURRENT_TIMESTAMP)
        ON CONFLICT ("scope", "keyHash") DO UPDATE SET
          "totalHits" = CASE
            WHEN "rate_limit_buckets"."resetAt" <= CURRENT_TIMESTAMP THEN 1
            ELSE "rate_limit_buckets"."totalHits" + 1
          END,
          "resetAt" = CASE
            WHEN "rate_limit_buckets"."resetAt" <= CURRENT_TIMESTAMP
              THEN CURRENT_TIMESTAMP + (${this.windowMs} * INTERVAL '1 millisecond')
            ELSE "rate_limit_buckets"."resetAt"
          END,
          "updatedAt" = CURRENT_TIMESTAMP
        RETURNING "totalHits", "resetAt"
      `);
      const bucket = rows[0];
      if (!bucket) throw new Error('missing bucket');
      return { totalHits: bucket.totalHits, resetTime: bucket.resetAt };
    } catch (error) {
      throw new RateLimitStoreUnavailableError(error);
    }
  }

  async decrement(key: string) {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "rate_limit_buckets"
      SET "totalHits" = GREATEST("totalHits" - 1, 0), "updatedAt" = CURRENT_TIMESTAMP
      WHERE "scope" = ${this.scope} AND "keyHash" = ${key} AND "resetAt" > CURRENT_TIMESTAMP
    `);
  }

  async resetKey(key: string) {
    await this.db.$executeRaw(Prisma.sql`
      DELETE FROM "rate_limit_buckets" WHERE "scope" = ${this.scope} AND "keyHash" = ${key}
    `);
  }
}

export async function assertSharedRateLimitStoreReady(db: RateLimitDatabase) {
  const rows = await db.$queryRaw<Array<{ ready: boolean }>>(Prisma.sql`
    SELECT to_regclass('public.rate_limit_buckets') IS NOT NULL AS ready
  `);
  if (rows[0]?.ready !== true) throw new Error('Shared rate-limit store migration is required');
}
