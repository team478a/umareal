import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterEach, describe, expect, it } from 'vitest';
import { config, proxy } from './proxy';

const previousMode = process.env.LAUNCH_MODE;
afterEach(() => {
  if (previousMode === undefined) delete process.env.LAUNCH_MODE; else process.env.LAUNCH_MODE = previousMode;
});

describe('cloud staging indexing protection', () => {
  it('allows requests without Basic authentication and prevents caching and indexing', () => {
    process.env.LAUNCH_MODE = 'CLOUD_STAGING';
    const allowed = proxy();
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    expect(allowed.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('applies staging headers to pages and same-origin APIs while leaving health and signed webhooks untouched', () => {
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, nextConfig: {}, url });
    expect(matches('/')).toBe(true);
    expect(matches('/admin/settings')).toBe(true);
    expect(matches('/api/v1/auth/config')).toBe(true);
    expect(matches('/health')).toBe(false);
    expect(matches('/api/v1/webhooks/resend')).toBe(false);
    expect(matches('/api/v1/webhooks/line')).toBe(false);
    expect(matches('/api/v1/webhooks/stripe')).toBe(false);
    expect(matches('/_next/static/chunk.js')).toBe(false);
  });
});
