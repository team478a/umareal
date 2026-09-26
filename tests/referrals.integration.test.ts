import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encryptSecret } from '../packages/db/src';
import { memberReferralSummarySchema } from '../packages/domain/src';
import { account, base, Client, db, origin } from './helpers';

const password = 'referral-integration-password-123';
const jstFutureDate = (days: number) => new Date(Date.now() + days * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
async function unusedJstFutureDate() {
  for (let days = 7; days <= 50; days += 1) {
    const targetDate = jstFutureDate(days);
    const product = await db.predictionProduct.findUnique({ where: { type_targetDate: { type: 'WIN5_PREVIEW', targetDate } }, select: { id: true } });
    if (!product) return targetDate;
  }
  throw new Error('No unused future date remains in the local integration database');
}
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
async function qualifyMany(referralCode: string, count: number) {
  const registrations = [];
  for (let index = 0; index < count; index += 1) {
    const registration = await emailRegistration(referralCode);
    await verify(registration);
    registrations.push(registration);
  }
  return registrations;
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
    const tampered = await emailRegistration('tampered code!'); await verify(tampered);
    expect(await db.referral.count({ where: { referredUserId: { in: [normal.userId, invalid.userId, tampered.userId] } } })).toBe(0);
  });

  it('keeps GET /me/referrals authenticated, contract-safe and free of private identity fields', async () => {
    expect((await new Client().call('me/referrals')).status).toBe(401);
    const owner = await account();
    const client = new Client();
    await client.login(owner);
    await qualifyMany(owner.user.referralCode, 3);

    const response = await client.call('me/referrals');
    expect(response.status).toBe(200);
    const summary = memberReferralSummarySchema.parse(response.body);
    expect(summary.referralCode).toBe(owner.user.referralCode);
    expect(new URL(summary.referralUrl).searchParams.get('invite')).toBe(owner.user.referralCode);
    expect(summary.qualifiedCount).toBe(3);
    expect(summary.nextMilestone).toMatchObject({ requiredReferralCount: 10, remaining: 7, rewardType: 'DAY_PASS', rewardQuantity: 1 });
    expect(summary.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ requiredReferralCount: 3, achieved: true }),
      expect.objectContaining({ requiredReferralCount: 10, achieved: false })
    ]));
    expect(summary.rewards).toHaveLength(1);
    expect(summary.rewards[0]).toMatchObject({ rewardType: 'DAY_PASS', rewardQuantity: 1, status: 'AVAILABLE', milestone: { requiredReferralCount: 3 }, dayPass: null });
    expect(new Date(summary.rewards[0].grantedAt).toISOString()).toBe(summary.rewards[0].grantedAt);
    expect(new Date(summary.rewards[0].expiresAt).toISOString()).toBe(summary.rewards[0].expiresAt);

    const serialized = JSON.stringify(response.body);
    for (const field of ['email', 'passwordHash', 'authSubject', 'lineSubject', 'token', 'secret', 'invalidatedReason', 'invalidatedById']) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    expect(serialized).not.toContain(owner.user.email!);
    expect(serialized).not.toContain(password);
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

  it('grants the 10-person milestone once when the 10th and 11th confirmations race', async () => {
    const concurrentReferrer = await account();
    await qualifyMany(concurrentReferrer.user.referralCode, 9);
    const tenth = await emailRegistration(concurrentReferrer.user.referralCode);
    const eleventh = await emailRegistration(concurrentReferrer.user.referralCode);
    await Promise.all([verify(tenth), verify(eleventh)]);
    const rewards = await db.referralReward.findMany({ where: { userId: concurrentReferrer.user.id }, include: { milestone: true } });
    expect(await db.referral.count({ where: { referrerUserId: concurrentReferrer.user.id, status: 'QUALIFIED' } })).toBe(11);
    expect(rewards.map(reward => reward.milestone.requiredReferralCount).sort((a, b) => a - b)).toEqual([3, 10]);
    expect(rewards.filter(reward => reward.milestone.requiredReferralCount === 10)).toHaveLength(1);
  }, 45000);

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
    const targetDate = await unusedJstFutureDate();
    const afterExpiry = new Date(new Date(available[1].expiresAt).getTime() + 86400000 + 9 * 3600000).toISOString().slice(0, 10);
    expect((await referrerClient.call(`me/referral-rewards/${available[1].id}/redeem`, 'POST', { targetDate: afterExpiry })).body.code).toBe('REFERRAL_REWARD_DATE_AFTER_EXPIRY');
    const redeemed = await referrerClient.call(`me/referral-rewards/${rewardId}/redeem`, 'POST', { targetDate });
    expect(redeemed.status).toBe(201);
    const pass = await db.dayPass.findUniqueOrThrow({ where: { id: redeemed.body.dayPassId }, include: { entitlement: true } });
    expect(pass).toMatchObject({ userId: referrer.user.id, raceDate: targetDate, provider: 'REFERRAL_REWARD', source: 'REFERRAL_REWARD', priceYen: 0 });
    expect(pass.entitlement).toMatchObject({ planCode: 'DAY_PASS', raceDate: targetDate, reason: 'REFERRAL_REWARD_DAY_PASS' });
    expect((await referrerClient.call(`me/referral-rewards/${rewardId}/redeem`, 'POST', { targetDate: jstFutureDate(8) })).body.code).toBe('REFERRAL_REWARD_ALREADY_USED');
    expect((await referrerClient.call(`me/referral-rewards/${available[1].id}/redeem`, 'POST', { targetDate })).body.code).toBe('DAY_PASS_ALREADY_EXISTS');
    expect((await referrerClient.call(`me/referral-rewards/${available[1].id}/redeem`, 'POST', { targetDate: '2020-01-01' })).body.code).toBe('PAST_TARGET_DATE');

    const expiredOwner = await account(); const expiredClient = new Client(); await expiredClient.login(expiredOwner);
    const milestone = await db.referralMilestone.findUniqueOrThrow({ where: { requiredReferralCount: 3 } });
    const expired = await db.referralReward.create({ data: { userId: expiredOwner.user.id, milestoneId: milestone.id, rewardType: 'DAY_PASS', grantedAt: new Date(Date.now() - 2 * 86400000), expiresAt: new Date(Date.now() - 86400000) } });
    expect((await expiredClient.call(`me/referral-rewards/${expired.id}/redeem`, 'POST', { targetDate: '2099-07-01' })).body.code).toBe('REFERRAL_REWARD_EXPIRED');
    expect((await db.referralReward.findUniqueOrThrow({ where: { id: expired.id } })).status).toBe('EXPIRED');
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

  it('invalidates and safely restores the same unused 3-person reward on re-attainment', async () => {
    const owner = await account();
    const registrations = await qualifyMany(owner.user.referralCode, 3);
    const reward = await db.referralReward.findFirstOrThrow({ where: { userId: owner.user.id }, include: { milestone: true } });
    expect(reward.milestone.requiredReferralCount).toBe(3);
    const originalGrantedAt = reward.grantedAt;
    const originalExpiresAt = reward.expiresAt;
    const target = await db.referral.findUniqueOrThrow({ where: { referredUserId: registrations[2].userId } });
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    expect((await admin.call(`admin/referrals/${target.id}/invalidate`, 'POST', { reason: '3人到達後の再計算試験' })).body).toMatchObject({ qualifiedCount: 2, unusedRewardsInvalidated: 1 });
    expect(await db.referralReward.findUniqueOrThrow({ where: { id: reward.id } })).toMatchObject({ status: 'INVALIDATED', dayPassId: null });
    await qualifyMany(owner.user.referralCode, 1);
    const restored = await db.referralReward.findUniqueOrThrow({ where: { id: reward.id } });
    expect(restored).toMatchObject({ status: 'AVAILABLE', grantedAt: originalGrantedAt, expiresAt: originalExpiresAt, invalidatedAt: null, invalidatedReason: null, dayPassId: null });
    expect(await db.referralReward.count({ where: { userId: owner.user.id, milestoneId: reward.milestoneId } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'REFERRAL_REWARD_GRANTED', targetId: reward.id, targetType: 'REFERRAL_REWARD' } })).toBe(2);
  }, 45000);

  it('invalidates and restores the same unused 10-person reward on re-attainment', async () => {
    const owner = await account();
    const registrations = await qualifyMany(owner.user.referralCode, 10);
    const milestone = await db.referralMilestone.findUniqueOrThrow({ where: { requiredReferralCount: 10 } });
    const reward = await db.referralReward.findUniqueOrThrow({ where: { userId_milestoneId: { userId: owner.user.id, milestoneId: milestone.id } } });
    const originalGrantedAt = reward.grantedAt;
    const originalExpiresAt = reward.expiresAt;
    const target = await db.referral.findUniqueOrThrow({ where: { referredUserId: registrations[9].userId } });
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    expect((await admin.call(`admin/referrals/${target.id}/invalidate`, 'POST', { reason: '10人到達後の再計算試験' })).body).toMatchObject({ qualifiedCount: 9, unusedRewardsInvalidated: 1 });
    expect((await db.referralReward.findUniqueOrThrow({ where: { id: reward.id } })).status).toBe('INVALIDATED');
    await qualifyMany(owner.user.referralCode, 1);
    expect(await db.referralReward.findUniqueOrThrow({ where: { id: reward.id } })).toMatchObject({ status: 'AVAILABLE', grantedAt: originalGrantedAt, expiresAt: originalExpiresAt, invalidatedAt: null, invalidatedReason: null });
    expect(await db.referralReward.count({ where: { userId: owner.user.id, milestoneId: milestone.id } })).toBe(1);
  }, 60000);

  it('never revives redeemed or expired rewards after invalidation and re-attainment', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();

    const redeemedOwner = await account(); const redeemedClient = new Client(); await redeemedClient.login(redeemedOwner);
    const redeemedRegistrations = await qualifyMany(redeemedOwner.user.referralCode, 3);
    const redeemedReward = await db.referralReward.findFirstOrThrow({ where: { userId: redeemedOwner.user.id } });
    expect((await redeemedClient.call(`me/referral-rewards/${redeemedReward.id}/redeem`, 'POST', { targetDate: jstFutureDate(21) })).status).toBe(201);
    const redeemedReferral = await db.referral.findUniqueOrThrow({ where: { referredUserId: redeemedRegistrations[2].userId } });
    await admin.call(`admin/referrals/${redeemedReferral.id}/invalidate`, 'POST', { reason: '使用済み特典の非復活試験' });
    await qualifyMany(redeemedOwner.user.referralCode, 1);
    expect(await db.referralReward.findUniqueOrThrow({ where: { id: redeemedReward.id } })).toMatchObject({ status: 'REDEEMED', dayPassId: expect.any(String) });

    const expiredOwner = await account();
    const expiredRegistrations = await qualifyMany(expiredOwner.user.referralCode, 3);
    const expiredReward = await db.referralReward.findFirstOrThrow({ where: { userId: expiredOwner.user.id } });
    await db.referralReward.update({ where: { id: expiredReward.id }, data: { grantedAt: new Date(Date.now() - 2 * 86400000), expiresAt: new Date(Date.now() - 86400000) } });
    const expiredReferral = await db.referral.findUniqueOrThrow({ where: { referredUserId: expiredRegistrations[2].userId } });
    await admin.call(`admin/referrals/${expiredReferral.id}/invalidate`, 'POST', { reason: '期限切れ特典の非復活試験' });
    expect((await db.referralReward.findUniqueOrThrow({ where: { id: expiredReward.id } })).status).toBe('EXPIRED');
    await qualifyMany(expiredOwner.user.referralCode, 1);
    expect((await db.referralReward.findUniqueOrThrow({ where: { id: expiredReward.id } })).status).toBe('EXPIRED');
  }, 60000);

  it('keeps member and administrator referral APIs within server-owned roles and AAL2', async () => {
    const memberFixture = await account(); const member = new Client(); await member.login(memberFixture);
    expect((await member.call('admin/referrals')).status).toBe(403);
    const aal1Admin = new Client(); await aal1Admin.login(await account('ADMIN'));
    expect((await aal1Admin.call('admin/referrals')).body.code).toBe('MFA_REQUIRED');
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const list = await admin.call('admin/referrals');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('@example.test');
    const someoneElsesReward = await db.referralReward.findFirstOrThrow({ where: { userId: { not: memberFixture.user.id } } });
    expect((await member.call(`me/referral-rewards/${someoneElsesReward.id}/redeem`, 'POST', { targetDate: jstFutureDate(30) })).status).toBe(404);
  });
});
