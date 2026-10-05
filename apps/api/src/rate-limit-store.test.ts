import { describe, expect, it } from 'vitest';
import { hashRateLimitKey, PostgresRateLimitStore, rateLimitIdentity, RateLimitStoreUnavailableError, validateRateLimitScope } from './rate-limit-store';

const secret = Buffer.alloc(32, 7).toString('base64');

describe('shared rate-limit identity', () => {
  it('creates stable scope-separated hashes without retaining the input', () => {
    const first = hashRateLimitKey(secret, 'auth', 'proxy:member-network');
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(hashRateLimitKey(secret, 'auth', 'proxy:member-network'));
    expect(first).not.toBe(hashRateLimitKey(secret, 'admin', 'proxy:member-network'));
    expect(first).not.toContain('member-network');
  });

  it('accepts only bounded operational scopes', () => {
    expect(validateRateLimitScope('webhook-line')).toBe('webhook-line');
    expect(() => validateRateLimitScope('../auth')).toThrow('Invalid rate-limit scope');
  });

  it('prefers the private proxy key and rejects malformed values', () => {
    const request = {
      header: (name: string) => name === 'x-umareal-client-key' ? 'a'.repeat(64) : undefined,
      ip: '192.0.2.1', socket: {}
    };
    expect(rateLimitIdentity(request as never)).toBe(`proxy:${'a'.repeat(64)}`);
    expect(rateLimitIdentity({ ...request, header: () => 'not-a-key' } as never)).toBe('ip:192.0.2.1');
  });

  it('fails closed with a safe error when the shared database is unavailable', async () => {
    const store = new PostgresRateLimitStore({
      $queryRaw: async () => { throw new Error('database connection details'); },
      $executeRaw: async () => 0
    }, 'auth');
    await expect(store.increment('a'.repeat(64))).rejects.toBeInstanceOf(RateLimitStoreUnavailableError);
  });
});
