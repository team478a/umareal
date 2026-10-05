import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PostgresRateLimitStore, RATE_LIMIT_WINDOW_MS } from '../apps/api/src/rate-limit-store';
import { db } from './helpers';

afterAll(() => db.$disconnect());

describe('PostgreSQL shared rate-limit store', () => {
  it('atomically shares a counter between store instances and resets expired windows', async () => {
    const scope = `test-${randomBytes(6).toString('hex')}`;
    const key = randomBytes(32).toString('hex');
    const first = new PostgresRateLimitStore(db, scope);
    const second = new PostgresRateLimitStore(db, scope);
    first.init({ windowMs: RATE_LIMIT_WINDOW_MS } as never);
    second.init({ windowMs: RATE_LIMIT_WINDOW_MS } as never);

    const increments = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).increment(key)));
    expect(increments.map(item => item.totalHits).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    const stored = await db.rateLimitBucket.findUniqueOrThrow({ where: { scope_keyHash: { scope, keyHash: key } } });
    expect(stored.totalHits).toBe(20);
    expect(stored.keyHash).toBe(key);

    await db.rateLimitBucket.update({ where: { scope_keyHash: { scope, keyHash: key } }, data: { resetAt: new Date(Date.now() - 1_000) } });
    const reset = await first.increment(key);
    expect(reset.totalHits).toBe(1);
    expect(reset.resetTime.getTime()).toBeGreaterThan(Date.now());

    await first.decrement(key);
    expect((await db.rateLimitBucket.findUniqueOrThrow({ where: { scope_keyHash: { scope, keyHash: key } } })).totalHits).toBe(0);
    await second.resetKey(key);
    expect(await db.rateLimitBucket.findUnique({ where: { scope_keyHash: { scope, keyHash: key } } })).toBeNull();
  });

  it('enforces anonymized key and bounded scope constraints at the database boundary', async () => {
    await expect(db.rateLimitBucket.create({ data: {
      scope: 'invalid scope', keyHash: 'raw-client-address', totalHits: 1, resetAt: new Date(Date.now() + 60_000)
    } })).rejects.toThrow();
  });
});
