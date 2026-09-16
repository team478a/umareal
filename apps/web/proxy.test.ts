import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { afterEach, describe, expect, it } from 'vitest';
import { config, proxy, stagingCookieValue, stagingCredentialsValid } from './proxy';

const previousMode = process.env.LAUNCH_MODE;
const previousUsername = process.env.STAGING_ACCESS_USERNAME;
const previousPassword = process.env.STAGING_ACCESS_PASSWORD;
afterEach(() => {
  if (previousMode === undefined) delete process.env.LAUNCH_MODE; else process.env.LAUNCH_MODE = previousMode;
  if (previousUsername === undefined) delete process.env.STAGING_ACCESS_USERNAME; else process.env.STAGING_ACCESS_USERNAME = previousUsername;
  if (previousPassword === undefined) delete process.env.STAGING_ACCESS_PASSWORD; else process.env.STAGING_ACCESS_PASSWORD = previousPassword;
});

describe('cloud staging access gate', () => {
  const username = 'staging-reviewer';
  const password = 'a-long-random-staging-password';
  const basic = (user: string, secret: string) => `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;

  it('accepts only the complete configured credential pair', () => {
    expect(stagingCredentialsValid(basic(username, password), username, password)).toBe(true);
    expect(stagingCredentialsValid(basic(username, 'wrong'), username, password)).toBe(false);
    expect(stagingCredentialsValid(basic('wrong', password), username, password)).toBe(false);
  });

  it('rejects missing and malformed authorization headers', () => {
    expect(stagingCredentialsValid(null, username, password)).toBe(false);
    expect(stagingCredentialsValid('Bearer token', username, password)).toBe(false);
    expect(stagingCredentialsValid('Basic !!!', username, password)).toBe(false);
  });

  it('returns a no-store challenge and persists a successful review session in a secure cookie', () => {
    process.env.LAUNCH_MODE = 'CLOUD_STAGING';
    process.env.STAGING_ACCESS_USERNAME = username;
    process.env.STAGING_ACCESS_PASSWORD = password;
    const denied = proxy(new NextRequest('https://staging.example.test/'));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('Umareal Staging');
    const allowed = proxy(new NextRequest('https://staging.example.test/', { headers: { authorization: basic(username, password) } }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const cookie = allowed.cookies.get('__Host-umareal_staging_access');
    expect(cookie?.value).toBe(stagingCookieValue(username, password));
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('strict');

    const followUp = proxy(new NextRequest('https://staging.example.test/admin/settings', {
      headers: { cookie: `__Host-umareal_staging_access=${cookie?.value}` }
    }));
    expect(followUp.status).toBe(200);
    expect(followUp.headers.get('www-authenticate')).toBeNull();
  });

  it('rejects a forged or stale staging access cookie', () => {
    process.env.LAUNCH_MODE = 'CLOUD_STAGING';
    process.env.STAGING_ACCESS_USERNAME = username;
    process.env.STAGING_ACCESS_PASSWORD = password;
    const forged = proxy(new NextRequest('https://staging.example.test/', {
      headers: { cookie: '__Host-umareal_staging_access=forged' }
    }));
    expect(forged.status).toBe(401);

    const staleValue = stagingCookieValue(username, password);
    process.env.STAGING_ACCESS_PASSWORD = 'a-different-long-random-password';
    const stale = proxy(new NextRequest('https://staging.example.test/', {
      headers: { cookie: `__Host-umareal_staging_access=${staleValue}` }
    }));
    expect(stale.status).toBe(401);
  });

  it('fails closed when staging credentials are absent or too short', () => {
    process.env.LAUNCH_MODE = 'CLOUD_STAGING';
    process.env.STAGING_ACCESS_USERNAME = username;
    process.env.STAGING_ACCESS_PASSWORD = 'short';
    expect(proxy(new NextRequest('https://staging.example.test/')).status).toBe(503);
  });

  it('protects pages and same-origin APIs while leaving health and signed webhooks reachable', () => {
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
