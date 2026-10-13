import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
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
    const registered = await client.call('auth/line/register', 'POST', { token, displayName: 'LINE登録会員', adult: true, terms: true, privacy: true, termsVersion: '2026-10-01-v1', privacyVersion: '2026-10-01-v1' });
    expect(registered.status).toBe(201);
    expect(await db.memberAcquisition.findUnique({ where: { userId: registered.body.user.id } })).toMatchObject({ source: 'line_ad', medium: 'social', campaign: 'integration-line', landingPath: '/register' });
    expect((await client.call('auth/line/register', 'POST', { token, displayName: '再利用', adult: true, terms: true, privacy: true, termsVersion: '2026-10-01-v1', privacyVersion: '2026-10-01-v1' })).status).toBe(400);
    const me = await client.call('me');
    expect(me.body).toMatchObject({ email: null, emailVerified: false, hasPassword: false, registrationMethod: 'LINE', lineLinked: true, lineNotificationReady: true, lineNotificationState: 'READY' });
    await client.call('me/preferences', 'PATCH', { predictions: false, changes: true, articles: false, billing: true });
    expect((await client.call('me')).body).toMatchObject({ lineNotificationReady: false, lineNotificationState: 'DISABLED' });
    await client.call('me/preferences', 'PATCH', { predictions: true, changes: true, articles: false, billing: true });
    expect((await client.call('auth/line/unlink', 'POST')).status).toBe(409);
    const checkout = await client.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': randomUUID() });
    const freeLaunch = process.env.LAUNCH_MODE === 'FREE_REGISTRATION';
    expect(checkout.status).toBe(freeLaunch ? 503 : 403);
    expect(checkout.body.code).toBe(freeLaunch ? 'BILLING_NOT_IN_LAUNCH' : 'VERIFIED_LOGIN_REQUIRED');
    expect(await db.billingCheckout.count({ where: { userId: registered.body.user.id } })).toBe(0);

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
    const loginStart = await loginClient.call('auth/line/start', 'POST', { purpose: 'LOGIN', returnTo: '/benefit' });
    const loginState = new URL(loginStart.body.authorizationUrl).searchParams.get('state')!;
    expect(await db.lineOAuthFlow.findUniqueOrThrow({ where: { stateHash: createHash('sha256').update(loginState).digest('hex') } })).toMatchObject({ returnPath: '/benefit' });
    const loggedIn = await callback(loginClient, loginState, saved.subject);
    expect(loggedIn.status).toBe(303);
    expect(new URL(loggedIn.headers.get('location')!).pathname).toBe('/benefit');
    const setCookie = loggedIn.headers.get('set-cookie'); expect(setCookie).toContain('HttpOnly');
    loginClient.cookie = setCookie!.split(';')[0];
    expect((await loginClient.call('me')).body.id).toBe(fixture.user.id);
    expect((await new Client().call('auth/line/start', 'POST', { purpose: 'LOGIN', returnTo: 'https://evil.example/' })).status).toBe(400);

    expect((await member.call('auth/line/unlink', 'POST')).body).toEqual({ linked: false });
    expect((await member.call('me')).body.lineLinked).toBe(false);
    const tombstone = await db.lineAccount.findUniqueOrThrow({ where: { userId: fixture.user.id } });
    expect(tombstone.unlinkedAt).toBeInstanceOf(Date);
    expect(tombstone.notificationDisabledAt).toBeInstanceOf(Date);
    const afterUnlink = new Client();
    const afterStart = await afterUnlink.call('auth/line/start', 'POST', { purpose: 'LOGIN', returnTo: '/benefit' });
    const afterState = new URL(afterStart.body.authorizationUrl).searchParams.get('state')!;
    const afterLogin = await callback(afterUnlink, afterState, saved.subject);
    expect(afterLogin.status).toBe(303);
    const afterLocation = new URL(afterLogin.headers.get('location')!);
    expect(afterLocation.pathname).toBe('/login');
    expect(afterLocation.searchParams.get('line')).toBe('not-linked');
    expect(afterLocation.searchParams.get('returnTo')).toBe('/benefit');
  });

  it('returns an unlinked LINE user to the login guidance instead of exposing an API error', async () => {
    const client = new Client();
    const started = await client.call('auth/line/start', 'POST', { purpose: 'LOGIN', returnTo: '/account' });
    const state = new URL(started.body.authorizationUrl).searchParams.get('state')!;
    const response = await callback(client, state, `U-unlinked-${randomUUID()}`);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe(origin);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('line')).toBe('not-linked');
    expect(location.searchParams.get('returnTo')).toBe('/account');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('allows a closed LINE identity to create a new member while preserving the old account and consuming referral credit only once', async () => {
    const subject = `U-closed-${randomUUID()}`;
    const closed = await account();
    const referrer = await account();
    const closedAt = new Date();
    await db.lineAccount.create({ data: { userId: closed.user.id, subject, unlinkedAt: closedAt, notificationDisabledAt: closedAt } });
    await db.user.update({ where: { id: closed.user.id }, data: { disabledAt: closedAt } });
    const originalClosure = await db.accountClosure.create({ data: { userId: closed.user.id, reasonCode: 'SERVICE_NO_LONGER_NEEDED', requestedAt: closedAt, accessRevokedAt: closedAt, retentionPolicyVersion: 'test-v1' } });

    const registerClient = new Client();
    const registerStart = await registerClient.call('auth/line/start', 'POST', { purpose: 'REGISTER', memberReferralCode: referrer.user.referralCode });
    const registerState = new URL(registerStart.body.authorizationUrl).searchParams.get('state')!;
    const registerResponse = await callback(registerClient, registerState, subject);
    expect(registerResponse.status).toBe(303);
    const registerLocation = new URL(registerResponse.headers.get('location')!);
    expect(registerLocation.pathname).toBe('/register/line');
    expect(registerLocation.searchParams.get('re-register')).toBe('1');
    expect(registerResponse.headers.get('set-cookie')).toBeNull();
    const token = registerLocation.searchParams.get('token');
    const newMember = await registerClient.call('auth/line/register', 'POST', { token, displayName: '再登録会員', adult: true, terms: true, privacy: true, termsVersion: '2026-10-01-v1', privacyVersion: '2026-10-01-v1' });
    expect(newMember.status).toBe(201);
    expect(newMember.body.user.id).not.toBe(closed.user.id);
    expect(await db.user.findUniqueOrThrow({ where: { id: closed.user.id } })).toMatchObject({ disabledAt: closedAt });
    expect(await db.accountClosure.findUniqueOrThrow({ where: { id: originalClosure.id } })).toMatchObject({ userId: closed.user.id });
    expect(await db.referral.findUnique({ where: { referredUserId: newMember.body.user.id } })).toMatchObject({ referrerUserId: referrer.user.id, status: 'QUALIFIED' });
    const reassigned = await db.lineAccount.findUniqueOrThrow({ where: { subject } });
    expect(reassigned).toMatchObject({ userId: newMember.body.user.id, identityOwnerUserId: closed.user.id, referralIdentityConsumedAt: expect.any(Date), unlinkedAt: null });
    expect(reassigned.notificationDisabledAt).toBeNull();

    const loginClient = new Client();
    const loginStart = await loginClient.call('auth/line/start', 'POST', { purpose: 'LOGIN' });
    const loginState = new URL(loginStart.body.authorizationUrl).searchParams.get('state')!;
    const loginResponse = await callback(loginClient, loginState, subject);
    expect(loginResponse.status).toBe(303);
    const loginLocation = new URL(loginResponse.headers.get('location')!);
    expect(loginLocation.pathname).toBe('/account');
    expect(loginLocation.searchParams.get('line')).toBe('login');
    expect(loginResponse.headers.get('set-cookie')).toContain('HttpOnly');

    const reClosedAt = new Date();
    await db.lineAccount.update({ where: { userId: newMember.body.user.id }, data: { unlinkedAt: reClosedAt, notificationDisabledAt: reClosedAt } });
    await db.user.update({ where: { id: newMember.body.user.id }, data: { disabledAt: reClosedAt } });
    await db.accountClosure.create({ data: { userId: newMember.body.user.id, reasonCode: 'SERVICE_NO_LONGER_NEEDED', requestedAt: reClosedAt, accessRevokedAt: reClosedAt, retentionPolicyVersion: 'test-v1' } });
    const secondReferrer = await account();
    const repeatClient = new Client();
    const repeatStart = await repeatClient.call('auth/line/start', 'POST', { purpose: 'REGISTER', memberReferralCode: secondReferrer.user.referralCode });
    const repeatState = new URL(repeatStart.body.authorizationUrl).searchParams.get('state')!;
    const repeatCallback = await callback(repeatClient, repeatState, subject);
    const repeatLocation = new URL(repeatCallback.headers.get('location')!);
    expect(repeatLocation.pathname).toBe('/register/line');
    expect(repeatLocation.searchParams.get('referral')).toBe('already-used');
    const repeated = await repeatClient.call('auth/line/register', 'POST', { token: repeatLocation.searchParams.get('token'), displayName: '再々登録会員', adult: true, terms: true, privacy: true, termsVersion: '2026-10-01-v1', privacyVersion: '2026-10-01-v1' });
    expect(repeated.status).toBe(201);
    expect(await db.referral.findUnique({ where: { referredUserId: repeated.body.user.id } })).toBeNull();
    expect(await db.referral.count({ where: { referrerUserId: secondReferrer.user.id } })).toBe(0);
  });

  it('does not treat an ordinary unlinked LINE tombstone as a closed-account re-registration', async () => {
    const member = await account();
    const subject = `U-active-unlinked-${randomUUID()}`;
    const unlinkedAt = new Date();
    await db.lineAccount.create({ data: { userId: member.user.id, subject, unlinkedAt, notificationDisabledAt: unlinkedAt } });
    const client = new Client();
    const started = await client.call('auth/line/start', 'POST', { purpose: 'REGISTER' });
    const state = new URL(started.body.authorizationUrl).searchParams.get('state')!;
    const response = await callback(client, state, subject);
    expect(new URL(response.headers.get('location')!, origin).searchParams.get('line')).toBe('already-linked');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await db.lineAccount.findUniqueOrThrow({ where: { subject } })).toMatchObject({ userId: member.user.id, unlinkedAt });
  });

  it('binds a link flow to the starting session and prevents subject reassignment', async () => {
    const ownerFixture = await account(), attackerFixture = await account();
    const owner = new Client(), attacker = new Client(); await owner.login(ownerFixture); await attacker.login(attackerFixture);
    const ownedSubject = `U-owned-${randomUUID()}`;
    await db.lineAccount.create({ data: { userId: ownerFixture.user.id, subject: ownedSubject } });
    const started = await attacker.call('auth/line/start', 'POST', { purpose: 'LINK' });
    const state = new URL(started.body.authorizationUrl).searchParams.get('state')!;
    const conflict = await callback(attacker, state, ownedSubject);
    expect(conflict.status).toBe(303);
    const conflictLocation = new URL(conflict.headers.get('location')!);
    expect(conflictLocation.pathname).toBe('/account');
    expect(conflictLocation.searchParams.get('line')).toBe('already-linked');
    expect(await db.lineAccount.findUnique({ where: { userId: attackerFixture.user.id } })).toBeNull();

    const victimStart = await owner.call('auth/line/start', 'POST', { purpose: 'LINK' });
    const victimState = new URL(victimStart.body.authorizationUrl).searchParams.get('state')!;
    expect((await callback(attacker, victimState, `U-new-${randomUUID()}`)).status).toBe(401);
    expect((await db.lineAccount.findUniqueOrThrow({ where: { userId: ownerFixture.user.id } })).subject).toBe(ownedSubject);
  });
});
