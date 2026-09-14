import { describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { buildLineAuthorizationUrl, exchangeLineCode, pkceChallenge } from './line-login.service';

describe('LINE Login OAuth protocol', () => {
  it('builds an official authorization request with state, nonce and S256 PKCE', () => {
    const verifier = 'verifier-value';
    const url = new URL(buildLineAuthorizationUrl({ channelId: '123456', callbackUrl: 'https://example.test/api/v1/auth/line/callback', state: 'state-value', nonce: 'nonce-value', verifier }));
    expect(`${url.origin}${url.pathname}`).toBe('https://access.line.me/oauth2/v2.1/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', client_id: '123456', state: 'state-value', nonce: 'nonce-value', scope: 'openid profile', code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' });
    expect(url.toString()).not.toContain('channel-secret');
  });

  it('exchanges the code with PKCE and verifies HS256 issuer, audience and nonce', async () => {
    const secret = '0123456789abcdef0123456789abcdef', now = Math.floor(Date.now() / 1000);
    const idToken = await new SignJWT({ nonce: 'nonce-value' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('https://access.line.me').setAudience('123456').setSubject('U-test-subject').setIssuedAt(now).setExpirationTime(now + 300).sign(new TextEncoder().encode(secret));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    await expect(exchangeLineCode({ channelId: '123456', channelSecret: secret, callbackUrl: 'https://example.test/callback', code: 'one-use-code', verifier: 'verifier', nonce: 'nonce-value' }, fetcher)).resolves.toEqual({ subject: 'U-test-subject' });
    const request = fetcher.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(new URLSearchParams(request.body as string)).toMatchObject(expect.any(URLSearchParams));
    expect(String(request.body)).toContain('code_verifier=verifier');
    await expect(exchangeLineCode({ channelId: '123456', channelSecret: secret, callbackUrl: 'https://example.test/callback', code: 'code', verifier: 'verifier', nonce: 'wrong' }, fetcher)).rejects.toMatchObject({ response: { code: 'LINE_ID_TOKEN_INVALID' } });
  });
});
