import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encryptSecret } from '../packages/db/src';
import { account, base, Client, db, origin } from './helpers';

const password = 'referral-integration-password-123';
const jstFutureDate = (days: number) => new Date(Date.now() + days * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
async function emailRegistration(memberReferralCode?: string, acquisitionReferralCode?: string) {
  const client = new Client();
  const email = `referral-${randomBytes(8).toString('hex')}@example.test`;
  const registered = await client.call('auth/register', 'POST', {
    email, password, displayName: '紹介登録テスト', adult: true, terms: true, privacy: true,
    termsVersion: 'draft-v1', privacyVersion: 'draft-v1',
    ...(memberReferralCode ? { memberReferralCode } : {}),
    ...(acquisitionReferralCode ? { acquisition: { source: 'lp', referralCode: acquisitionReferralCode, landingPath: '/register' } } : {})
  });
  expect(registered.status).toBe(201);
  const mail = JSON.parse(await readFile(resolve('.local/mail', `${registered.body.user.id}-verify.json`), 'utf8')) as { url: string };
  const token = new URL(mail.url).searchParams.get('token');
  return { client, userId: registered.body.user.id as string, token: token!, email };
}
async function verify(registration: Awaited<ReturnType<typeof emailRegistration>>) {
  const result = await registration.client.call('auth/email/verify', 'POST', { token: registration.token });
  expect(result.status).toBe(201);
  return result;
}
async function lineCallback(client: Client, state: string, subject: string) {
  return fetch(`${base}/api/v1/auth/line/callback?${new URLSearchParams({ state, code: `test.${subject}` })}`, { headers: { Cookie: client.cookie, Origin: origin }, redirect: 'manual' });
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local') throw new Error('Referral integration is limited to a local database and local authentication');
  expect(await db.referralMilestone.findMany({ orderBy: { requiredReferralCount: 'asc' }, select: { requiredReferralCount: true, rewardType: true, rewardQuantity: true } })).toEqual([
    { requiredReferralCount: 3, rewardType: 'DAY_PASS', rewardQuantity: 1 },
    { requiredReferralCount: 10, rewardType: 'DAY_PASS', rewardQuantity: 1 }
  ]);
});
afterAll(() => db.$disconnect());

describe('friend referral V1', () => {
  let referrer: Awaited<ReturnType<typeof account>>; let referrerClient: Client; let referralId = '';

  it('keeps acquisition attribution separate and qualifies only after email verification', async () => {
    referrer = await account(); referrerClient = new Client(); await referrerClient.login(referrer);
    const registration = await emailRegistration(referrer.user.referralCode, 'marketing_staff_01');
    expect(await db.referral.findUnique({ where: { referredUserId: registration.userId } })).toMatchObject({ referrerUserId: referrer.user.id, status: 'PENDING', qualifiedAt: null });
    expect(await db.memberAcquisition.findUnique({ where: { userId: registration.userId } })).toMatchObject({ referralCode: 'marketing_staff_01' });
    await verify(registration);
    const referral = await db.referral.findUniqueOrThrow({ where: { referredUserId: registration.userId } }); referralId = referral.id;
    expect(referral).toMatchObject({ referrerUserId: referrer.user.id, status: 'QUALIFIED' });
    expect(referral.qualifiedAt).toBeInstanceOf(Date);
    expect((await registration.client.call('auth/email/verify', 'POST', { token: registration.token })).status).toBe(400);
    expect(await db.referral.count({ where: { referredUserId: registration.userId } })).toBe(1);
  });

  it('does not create a referral for normal or invalid-code registration', async () => {
    const normal = await emailRegistration(); await verify(normal);
    const invalid = await emailRegistration('NOTEXIST12345678'); await verify(invalid);
    expect(await db.referral.count({ where: { referredUserId: { in: [normal.userId, invalid.userId] } } })).toBe(0);
  });

  it('grants exactly one reward at 3 and a second at 10, without grants at 4 or 11', async () => {
    for (let count = 2; count <= 11; count += 1) {
      const registration = await emailRegistration(referrer.user.referralCode); await verify(registration);
      const rewards = await db.referralReward.findMany({ where: { userId: referrer.user.id }, include: { milestone: true } });
      if (count < 3) expect(rewards).toHaveLength(0);
      else if (count < 10) expect(rewards.map(item => item.milestone.requiredReferralCount)).toEqual([3]);
      else expect(rewards.map(item => item.milestone.requiredReferralCount).sort((a, b) => a - b)).toEqual([3, 10]);
    }
    expect(await db.referral.count({ where: { referrerUserId: referrer.user.id, status: 'QUALIFIED' } })).toBe(11);
    expect(await db.referralReward.count({ where: { userId: referrer.user.id } })).toBe(2);
  }, 30000);

  it('uses advisory locking and unique constraints to avoid a duplicate concurrent milestone grant', async () => {
    const concurrentReferrer = await account();
    const first = await emailRegistration(concurrentReferrer.user.referralCode); const second = await emailRegistration(concurrentReferrer.user.referralCode); const third = await emailRegistration(concurrentReferrer.user.referralCode); const fourth = await emailRegistration(concurrentReferrer.user.referralCode);
    await verify(first); await verify(second);
    await Promise.all([verify(third), verify(fourth)]);
    expect(await db.referral.count({ where: { referrerUserId: concurrentReferrer.user.id, status: 'QUALIFIED' } })).toBe(4);
    expect(await db.referralReward.count({ where: { userId: concurrentReferrer.user.id } })).toBe(1);
    await expect(db.referralReward.create({ data: { userId: concurrentReferrer.user.id, milestoneId: (await db.referralMilestone.findUniqueOrThrow({ where: { requiredReferralCount: 3 } })).id, rewardType: 'DAY_PASS', expiresAt: new Date(Date.now() + 86400000) } })).rejects.toThrow();
  });

  it('qualifies LINE registration with the same immutable relationship', async () => {
    await db.systemSetting.update({ where: { id: 'global' }, data: { lineLoginEnabled: true, lineLoginChannelId: 'referral-integration-channel', lineLoginChannelSecretEncrypted: encryptSecret('referral-integration-secret-value'), lineLoginCallbackUrl: `${base}/api/v1/auth/line/callback` } });
    const lineReferrer = await account(); const client = new Client();
    const started = await client.call('auth/line/start', 'POST', { purpose: 'REGISTER', memberReferralCode: lineReferrer.user.referralCode });
    const authorization = new URL(started.body.authorizationUrl); const subject = `U-referral-${randomUUID()}`;
    const completed = await lineCallback(client, authorization.searchParams.get('state')!, subject);
    const token = new URL(completed.headers.get('location')!, origin).searchParams.get('token');
    const registered = await client.call('auth/line/register', 'POST', { token, displayName: 'LINE紹介登録', adult: true, terms: true, privacy: true, termsVersion: 'draft-v1', privacyVersion: 'draft-v1' });
    expect(registered.status).toBe(201);
    expect(await db.referral.findUnique({ where: { referredUserId: registered.body.user.id } })).toMatchObject({ referrerUserId: lineReferrer.user.id, status: 'QUALIFIED' });
    await db.systemSetting.update({ where: { id: 'global' }, data: { lineLoginEnabled: false, lineLoginChannelId: null, lineLoginChannelSecretEncrypted: null, lineLoginCallbackUrl: null } });
  });

  it('redeems through the existing day-pass entitlement once and rejects expired rewards', async () => {
    const summary = await referrerClient.call('me/referrals'); expect(summary.status).toBe(200);
    const available = summary.body.rewards.filter((item: { status: string }) => item.status === 'AVAILABLE') as { id: string; expiresAt: string }[];
    const rewardId = available[0].id;
    const targetDate = jstFutureDate(7);
    const afterExpiry = new Date(new Date(available[1].expiresAt).getTime() + 86400000 + 9 * 3600000).toISOString().slice(0, 10);
    expect((await referrerClient.call(`me/referral-rewards/${available[1].id}/redeem`, 'POST', { targetDate: afterExpiry })).body.code).toBe('REFERRAL_REWARD_DATE_AFTER_EXPIRY');
    const redeemed = await referrerClient.call(`me/referral-rewards/${rewardId}/redeem`, 'POST', { targetDate });
    expect(redeemed.status).toBe(201);
    const pass = await db.dayPass.findUniqueOrThrow({ where: { id: redeemed.body.dayPassId }, include: { entitlement: true } });
    expect(pass).toMatchObject({ userId: referrer.user.id, raceDate: targetDate, provider: 'REFERRAL_REWARD', source: 'REFERRAL_REWARD', priceYen: 0 });
    expect(pass.entitlement).toMatchObject({ planCode: 'DAY_PASS', raceDate: targetDate, reason: 'REFERRAL_REWARD_DAY_PASS' });
    expect((await referrerClient.call(`me/referral-rewards/${rewardId}/redeem`, 'POST', { targetDate: jstFutureDate(8) })).body.code).toBe('REFERRAL_REWARD_ALREADY_USED');

    const expiredOwner = await account(); const expiredClient = new Client(); await expiredClient.login(expiredOwner);
    const milestone = await db.referralMilestone.findUniqueOrThrow({ where: { requiredReferralCount: 3 } });
    const expired = await db.referralReward.create({ data: { userId: expiredOwner.user.id, milestoneId: milestone.id, rewardType: 'DAY_PASS', grantedAt: new Date(Date.now() - 2 * 86400000), expiresAt: new Date(Date.now() - 86400000) } });
    expect((await expiredClient.call(`me/referral-rewards/${expired.id}/redeem`, 'POST', { targetDate: '2099-07-01' })).body.code).toBe('REFERRAL_REWARD_EXPIRED');
  });

  it('prevents self and duplicate referrals at the database boundary', async () => {
    const user = await account();
    await expect(db.referral.create({ data: { referrerUserId: user.user.id, referredUserId: user.user.id } })).rejects.toThrow();
    const referred = await account();
    await db.referral.create({ data: { referrerUserId: user.user.id, referredUserId: referred.user.id } });
    await expect(db.referral.create({ data: { referrerUserId: referrer.user.id, referredUserId: referred.user.id } })).rejects.toThrow();
  });

  it('lets AAL2 admin invalidate a qualified referral, audits it, and never revokes a used pass', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const invalidated = await admin.call(`admin/referrals/${referralId}/invalidate`, 'POST', { reason: '結合試験で不正登録扱いを確認' });
    expect(invalidated.status).toBe(201); expect(invalidated.body.status).toBe('INVALIDATED');
    expect(await db.auditLog.findFirst({ where: { action: 'REFERRAL_INVALIDATED', targetId: referralId } })).not.toBeNull();
    expect(await db.dayPass.count({ where: { userId: referrer.user.id, source: 'REFERRAL_REWARD' } })).toBe(1);
    const replay = await admin.call(`admin/referrals/${referralId}/invalidate`, 'POST', { reason: 'API再送' });
    expect(replay.status).toBe(201); expect(replay.body.alreadyInvalidated).toBe(true);
  });
});
