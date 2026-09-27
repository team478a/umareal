import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppRequest } from './context';
import { AuthSessionService } from './auth-session.service';

const response = () => ({ cookie: vi.fn(), clearCookie: vi.fn() }) as unknown as Response;
const request = (cookies: Record<string, unknown>) => ({ cookies }) as AppRequest;

afterEach(() => vi.unstubAllEnvs());

describe('AuthSessionService', () => {
  it('keeps the local session cookie policy and its existing clear policy in one place', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const service = new AuthSessionService();
    const res = response();

    service.setLocalSession(res, 'local-session-token');
    service.clearLocalSession(res);

    expect(res.cookie).toHaveBeenCalledWith('keiba_session', 'local-session-token', {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 8 * 3600000
    });
    expect(res.clearCookie).toHaveBeenCalledWith('keiba_session', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/'
    });
  });

  it('creates S256 PKCE state and preserves external session and flow cookie attributes', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const service = new AuthSessionService();
    const res = response();
    const flow = service.createPkce();

    expect(flow.verifier).toHaveLength(64);
    expect(flow.challenge).toBe(createHash('sha256').update(flow.verifier).digest('base64url'));

    service.setExternalFlow(res, flow.verifier, 'signup');
    service.setExternalSession(res, {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      user: { id: 'provider-user', email: 'member@example.test' }
    });

    const secure = { httpOnly: true, sameSite: 'lax', secure: true, path: '/' };
    expect(res.cookie).toHaveBeenCalledWith('keiba_pkce_verifier', flow.verifier, { ...secure, maxAge: 24 * 3600000 });
    expect(res.cookie).toHaveBeenCalledWith('keiba_auth_flow', 'signup', { ...secure, maxAge: 24 * 3600000 });
    expect(res.cookie).toHaveBeenCalledWith('keiba_access_token', 'access-token', { ...secure, maxAge: 3600 * 1000 });
    expect(res.cookie).toHaveBeenCalledWith('keiba_refresh_token', 'refresh-token', { ...secure, maxAge: 30 * 86400 * 1000 });
    expect(service.readExternalFlow(request({ keiba_pkce_verifier: flow.verifier, keiba_auth_flow: 'signup' }))).toEqual({ verifier: flow.verifier, flow: 'signup' });
    expect(service.readExternalFlow(request({ keiba_pkce_verifier: 'short', keiba_auth_flow: 'signup' }))).toBeNull();
    expect(service.readExternalFlow(request({ keiba_pkce_verifier: flow.verifier, keiba_auth_flow: 'other' }))).toBeNull();
  });

  it('keeps token size checks and clears every external authentication cookie', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const service = new AuthSessionService();
    const req = request({ keiba_access_token: 'access-token', keiba_refresh_token: 'refresh-token' });
    const res = response();

    expect(service.requireExternalAccessToken(req, 8192)).toBe('access-token');
    expect(service.readExternalRefreshToken(req)).toBe('refresh-token');
    expect(service.requireExternalAccessToken(request({ keiba_access_token: '' }), 8192)).toBe('');
    expect(service.readExternalRefreshToken(request({ keiba_refresh_token: '' }))).toBe('');
    expect(() => service.requireExternalAccessToken(request({ keiba_access_token: 'x'.repeat(8193) }), 8192)).toThrow();
    expect(service.readExternalRefreshToken(request({ keiba_refresh_token: 'x'.repeat(4097) }))).toBeNull();

    service.clearExternalSession(res);
    expect(res.clearCookie).toHaveBeenCalledTimes(4);
    for (const name of ['keiba_access_token', 'keiba_refresh_token', 'keiba_pkce_verifier', 'keiba_auth_flow']) {
      expect(res.clearCookie).toHaveBeenCalledWith(name, { httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
    }
  });
});
