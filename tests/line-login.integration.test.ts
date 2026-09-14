import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encryptSecret } from '../packages/db/src';
import { account, base, Client, db, origin } from './helpers';

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || (process.env.LINE_OAUTH_TRANSPORT ?? 'test') !== 'test') throw new Error('LINE Login integration is limited to the local test transport');
  await db.systemSetting.update({ where: { id: 'global' }, data: { lineLoginEnabled: true, lineLoginChannelId: 'integration-channel', lineLoginChannelSecretEncrypted: encryptSecret('integration-channel-secret-value'), lineLoginCallbackUrl: `${base}/api/v1/auth/line/callback` } });
});
afterAll(async () => {
  await db.systemSetting.update({ where: { id: 'global' }, data: { lineLoginEnabled: false, lineLoginChannelId: null, lineLoginChannelSecretEncrypted: null, lineLoginCallbackUrl: null } });
  await db.$disconnect();
});

async function callback(client: Client, state: string, subject: string) {
  return fetch(`${base}/api/v1/auth/line/callback?${new URLSearchParams({ state, code: `test.${subject}` })}`, { headers: { Cookie: client.cookie, Origin: origin }, redirect: 'manual' });
}

describe('LINE Login account lifecycle', () => {
  it('registers a free member directly from LINE and adds verified fallback authentication', async () => {
    const client = new Client();
    const started = await client.call('auth/line/start', 'POST', { purpose: 'REGISTER', acquisition: { source: 'LINE_AD', medium: ' Social ', campaign: 'integration-line', landingPath: '/register' } });
    const authorization = new URL(started.body.authorizationUrl);
    expect(authorization.searchParams.get('bot_prompt')).toBe('aggressive');
    const subject = `U-registration-${randomUUID()}`;
    const completed = await callback(client, authorization.searchParams.get('state')!, subject);
    expect(completed.status).toBe(303);
    const token = new URL(completed.headers.get('location')!, origin).searchParams.get('token');
    const registered = await client.call('auth/line/register', 'POST', { token, displayName: 'LINE登録会員', adult: true, terms: true, privacy: true, termsVersion: 'draft-v1', privacyVersion: 'draft-v1' });
    expect(registered.status).toBe(201);
    expect(await db.memberAcquisition.findUnique({ where: { userId: registered.body.user.id } })).toMatchObject({ source: 'line_ad', medium: 'social', campaign: 'integration-line', landingPath: '/register' });
    expect((await client.call('auth/line/register', 'POST', { token, displayName: '再利用', adult: true, terms: true, privacy: true, termsVersion: 'draft-v1', privacyVersion: 'draft-v1' })).status).toBe(400);
    const me = await client.call('me');
    expect(me.body).toMatchObject({ email: null, emailVerified: false, hasPassword: false, registrationMethod: 'LINE', lineLinked: true, lineNotificationReady: true, lineNotificationState: 'READY' });
    await client.call('me/preferences', 'PATCH', { predictions: false, changes: true, articles: false, billing: true });
    expect((await client.call('me')).body).toMatchObject({ lineNotificationReady: false, lineNotificationState: 'DISABLED' });
    await client.call('me/preferences', 'PATCH', { predictions: true, changes: true, articles: false, billing: true });
    expect((await client.call('auth/line/unlink', 'POST')).status).toBe(409);
    expect((await client.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': randomUUID() })).status).toBe(403);

    const email = `line-fallback-${randomUUID()}@example.test`; const password = 'line-fallback-password-123';
    const requested = await client.call('auth/email/fallback', 'POST', { email, password });
    expect(requested.status).toBe(201);
    const mail = JSON.parse(await readFile(resolve('.local/mail', `${registered.body.user.id}-fallback.json`), 'utf8')) as { url: string };
    const verificationToken = new URL(mail.url).searchParams.get('token');
    expect((await client.call('auth/email/verify', 'POST', { token: verificationToken })).status).toBe(201);
    expect((await client.call('me')).body).toMatchObject({ email, emailVerified: true, hasPassword: true });
    expect((await client.call('auth/line/unlink', 'POST')).status).toBe(201);
    const emailClient = new Client();
    expect((await emailClient.call('auth/login', 'POST', { email, password })).status).toBe(201);
  });

  it('links, signs in, rejects replay and preserves an unlink tombstone', async () => {
    const fixture = await account(); const member = new Client(); await member.login(fixture);
    const started = await member.call('auth/line/start', 'POST', { purpose: 'LINK' });
    expect(started.status).toBe(201);
    const authorization = new URL(started.body.authorizationUrl);
    expect(authorization.origin).toBe('https://access.line.me');
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authorization.searchParams.get('state')!;
    const nonce = authorization.searchParams.get('nonce')!;
    const flow = await db.lineOAuthFlow.findFirstOrThrow({ where: { userId: fixture.user.id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(flow)).not.toContain(state);
    expect(JSON.stringify(flow)).not.toContain(nonce);

    const subject = `U-integration-${randomUUID()}`;
    const linked = await callback(member, state, subject);
    expect(linked.status).toBe(303);
    expect(linked.headers.get('location')).toContain('/account?line=linked');
    expect((await member.call('me')).body.lineLinked).toBe(true);
    const saved = await db.lineAccount.findUniqueOrThrow({ where: { userId: fixture.user.id } });
    expect(saved.unlinkedAt).toBeNull();
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'LINE_ACCOUNT_LINK', targetId: fixture.user.id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.stringify(audit.details)).not.toContain(saved.subject);
    expect((await callback(member, state, subject)).status).toBe(400);

    const loginClient = new Client();
    const loginStart = await loginClient.call('auth/line/start', 'POST', { purpose: 'LOGIN' });
    const loginState = new URL(loginStart.body.authorizationUrl).searchParams.get('state')!;
    const loggedIn = await callback(loginClient, loginState, saved.subject);
    expect(loggedIn.status).toBe(303);
    const setCookie = loggedIn.headers.get('set-cookie'); expect(setCookie).toContain('HttpOnly');
    loginClient.cookie = setCookie!.split(';')[0];
    expect((await loginClient.call('me')).body.id).toBe(fixture.user.id);

    expect((await member.call('auth/line/unlink', 'POST')).body).toEqual({ linked: false });
    expect((await member.call('me')).body.lineLinked).toBe(false);
    const tombstone = await db.lineAccount.findUniqueOrThrow({ where: { userId: fixture.user.id } });
    expect(tombstone.unlinkedAt).toBeInstanceOf(Date);
    expect(tombstone.notificationDisabledAt).toBeInstanceOf(Date);
    const afterUnlink = new Client();
    const afterStart = await afterUnlink.call('auth/line/start', 'POST', { purpose: 'LOGIN' });
    const afterState = new URL(afterStart.body.authorizationUrl).searchParams.get('state')!;
    expect((await callback(afterUnlink, afterState, saved.subject)).status).toBe(401);
  });

  it('binds a link flow to the starting session and prevents subject reassignment', async () => {
    const ownerFixture = await account(), attackerFixture = await account();
    const owner = new Client(), attacker = new Client(); await owner.login(ownerFixture); await attacker.login(attackerFixture);
    const ownedSubject = `U-owned-${randomUUID()}`;
    await db.lineAccount.create({ data: { userId: ownerFixture.user.id, subject: ownedSubject } });
    const started = await attacker.call('auth/line/start', 'POST', { purpose: 'LINK' });
    const state = new URL(started.body.authorizationUrl).searchParams.get('state')!;
    expect((await callback(attacker, state, ownedSubject)).status).toBe(409);
    expect(await db.lineAccount.findUnique({ where: { userId: attackerFixture.user.id } })).toBeNull();

    const victimStart = await owner.call('auth/line/start', 'POST', { purpose: 'LINK' });
    const victimState = new URL(victimStart.body.authorizationUrl).searchParams.get('state')!;
    expect((await callback(attacker, victimState, `U-new-${randomUUID()}`)).status).toBe(401);
    expect((await db.lineAccount.findUniqueOrThrow({ where: { userId: ownerFixture.user.id } })).subject).toBe(ownedSubject);
  });
});
