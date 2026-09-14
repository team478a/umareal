import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseAuthService } from './supabase-auth.service';

const user = { id: '123e4567-e89b-42d3-a456-426614174000', email: 'member@example.test', email_confirmed_at: '2026-09-14T00:00:00.000Z', identities: [{}] };
const session = { access_token: 'access-token-that-is-long-enough', refresh_token: 'refresh-token', expires_in: 3600, user };

describe('Supabase authentication transport', () => {
  beforeEach(() => {
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'public-anon-key';
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY; });

  it('starts email signup with an S256 challenge and an allow-listed callback', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(user), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    const result = await new SupabaseAuthService().signUp({ email: user.email, password: 'long-test-password' }, 'challenge-value', 'https://members.example.test/api/v1/auth/callback');
    expect(result).toMatchObject({ user, session: null });
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://project.supabase.co/auth/v1/signup?redirect_to=https%3A%2F%2Fmembers.example.test%2Fapi%2Fv1%2Fauth%2Fcallback');
    expect(init.headers).toMatchObject({ apikey: 'public-anon-key' });
    expect(JSON.parse(String(init.body))).toMatchObject({ email: user.email, code_challenge: 'challenge-value', code_challenge_method: 's256' });
  });

  it('exchanges and rotates a PKCE session without logging or returning provider errors', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(session), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    expect(await new SupabaseAuthService().exchangeCode('123e4567-e89b-42d3-a456-426614174001', 'verifier')).toEqual(session);
    expect(request.mock.calls[0][0]).toContain('grant_type=pkce');
    expect(JSON.parse(String((request.mock.calls[0][1] as RequestInit).body))).toEqual({ auth_code: '123e4567-e89b-42d3-a456-426614174001', code_verifier: 'verifier' });
  });

  it('maps rejected password grants to a generic login failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'provider detail must stay internal' }), { status: 400, headers: { 'content-type': 'application/json' } })));
    await expect(new SupabaseAuthService().signIn(user.email, 'wrong-password')).rejects.toMatchObject({ response: { code: 'LOGIN_FAILED' }, status: 401 });
  });
});
