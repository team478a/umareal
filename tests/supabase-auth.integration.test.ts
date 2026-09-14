import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from './helpers';

let authServer: Server;
let apiProcess: ChildProcess;
let apiBase = '';
let authBase = '';
const receivedSignups: Array<{ url: string; body: Record<string, unknown> }> = [];
const providerUsers = new Map<string, { id: string; email: string; identities: unknown[] }>();
let activeProviderUser: { id: string; email: string; identities: unknown[] } | undefined;

async function listen(server: Server) {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not receive a TCP port');
  return address.port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function waitForApi(process: ChildProcess) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Supabase test API exited during startup (${process.exitCode})`);
    try {
      const response = await fetch(`${apiBase}/api/v1/health`);
      if (response.ok) return;
    } catch { /* API is still starting. */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('Supabase test API did not become ready');
}

beforeAll(async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(databaseUrl.hostname)) throw new Error('Supabase integration test is limited to a local development database');

  authServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.startsWith('/auth/v1/')) {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (request.url.startsWith('/auth/v1/signup?')) {
        receivedSignups.push({ url: request.url, body });
        const email = String(body.email);
        const user = { id: randomUUID(), email, identities: email.startsWith('existing-') ? [] : [{ id: randomUUID() }] };
        if (user.identities.length) { providerUsers.set(email, user); activeProviderUser = user; }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(user));
        return;
      }
      if (request.url.startsWith('/auth/v1/token?')) {
        const user = typeof body.email === 'string' ? providerUsers.get(body.email) : activeProviderUser;
        if (!user) { response.writeHead(400, { 'content-type': 'application/json' }).end('{}'); return; }
        activeProviderUser = user;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ access_token: `access-${randomBytes(18).toString('hex')}`, refresh_token: `refresh-${randomBytes(12).toString('hex')}`, expires_in: 3600, user: { ...user, email_confirmed_at: new Date().toISOString() } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  const authPort = await listen(authServer);
  authBase = `http://127.0.0.1:${authPort}`;
  const apiPort = await freePort();
  apiBase = `http://127.0.0.1:${apiPort}`;
  apiProcess = spawn(process.execPath, ['dist/main.js'], {
    cwd: resolve('apps/api'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(apiPort),
      APP_BASE_URL: 'http://localhost:3000',
      AUTH_PROVIDER: 'supabase',
      SUPABASE_URL: authBase,
      SUPABASE_ANON_KEY: 'integration-public-anon-key',
      AUTH_RATE_LIMIT: '1000',
      NOTIFICATION_TRANSPORT: 'test',
      LINE_OAUTH_TRANSPORT: 'test',
      BILLING_TRANSPORT: 'test',
      MAIL_TRANSPORT: 'test'
    },
    stdio: 'ignore'
  });
  await waitForApi(apiProcess);
}, 30_000);

afterAll(async () => {
  apiProcess?.kill();
  if (authServer?.listening) await new Promise<void>(resolveClose => authServer.close(() => resolveClose()));
  await db.$disconnect();
});

describe('Supabase free-member registration boundary', () => {
  it('binds the provider subject to a server-owned MEMBER with immutable consent and acquisition records', async () => {
    const suffix = randomBytes(6).toString('hex');
    const email = `supabase-${suffix}@example.test`;
    const response = await fetch(`${apiBase}/api/v1/auth/register`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        displayName: 'Supabase 登録試験',
        password: 'integration-password-123',
        adult: true,
        terms: true,
        privacy: true,
        termsVersion: 'draft-v1',
        privacyVersion: 'draft-v1',
        acquisition: { source: 'LP', medium: 'Owned', campaign: 'supabase-integration' }
      })
    });
    const result = await response.json() as { user: { id: string; role: string }; requiresEmailVerification: boolean };
    expect(response.status).toBe(201);
    expect(result.user.role).toBe('MEMBER');
    expect(result.requiresEmailVerification).toBe(true);
    expect(response.headers.get('set-cookie')).toContain('keiba_pkce_verifier=');
    const flowCookies = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');

    const signup = receivedSignups.at(-1);
    expect(signup?.url).toContain('redirect_to=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fv1%2Fauth%2Fcallback');
    expect(signup?.body).toMatchObject({ email, code_challenge_method: 's256' });
    expect(String(signup?.body.code_challenge)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const user = await db.user.findUniqueOrThrow({ where: { id: result.user.id }, include: { consents: true, acquisition: true } });
    expect(user).toMatchObject({ email, role: 'MEMBER', passwordHash: null, registrationMethod: 'EMAIL' });
    expect(user.authSubject).toMatch(/^[0-9a-f-]{36}$/);
    expect(user.consents.map(consent => consent.documentType).sort()).toEqual(['AGE_20', 'PRIVACY', 'TERMS']);
    expect(user.acquisition).toMatchObject({ source: 'lp', medium: 'owned', campaign: 'supabase-integration' });
    expect(await db.auditLog.count({ where: { targetId: user.id, action: 'REGISTER' } })).toBe(1);

    const callback = await fetch(`${apiBase}/api/v1/auth/callback?code=${randomUUID()}`, { headers: { Cookie: flowCookies }, redirect: 'manual' });
    expect(callback.status).toBe(303);
    expect(callback.headers.get('location')).toBe('http://localhost:3000/account?email=verified');
    expect(callback.headers.get('set-cookie')).toContain('keiba_access_token=');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeInstanceOf(Date);

    const login = await fetch(`${apiBase}/api/v1/auth/login`, { method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'integration-password-123' }) });
    expect(login.status).toBe(201);
    expect(login.headers.get('set-cookie')).toContain('keiba_refresh_token=');
    const refreshed = await fetch(`${apiBase}/api/v1/auth/refresh`, { method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: 'keiba_refresh_token=refresh-test-token', 'Content-Type': 'application/json' }, body: '{}' });
    expect(refreshed.status).toBe(201);
    expect(refreshed.headers.get('set-cookie')).toContain('keiba_access_token=');
    await expect(db.userConsent.update({ where: { id: user.consents[0].id }, data: { version: 'changed' } })).rejects.toThrow();
  });

  it('does not create a local membership from Supabase identity-less duplicate responses', async () => {
    const email = `existing-${randomBytes(6).toString('hex')}@example.test`;
    const response = await fetch(`${apiBase}/api/v1/auth/register`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, displayName: '既存メール', password: 'integration-password-123', adult: true, terms: true, privacy: true, termsVersion: 'draft-v1', privacyVersion: 'draft-v1' })
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ user: null, requiresEmailVerification: true });
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });
});
