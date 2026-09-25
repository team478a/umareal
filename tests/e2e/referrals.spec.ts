import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PrismaClient } from '../../packages/db/src';
import { account, Client } from '../helpers';

const db = new PrismaClient();
test.afterAll(() => db.$disconnect());

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('メールアドレス', { exact: true }).fill(email);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'マイページ', exact: true })).toBeVisible();
}

test('member referral works from the account URL through email verification', async ({ page }) => {
  const referrer = await account();
  await login(page, referrer.user.email!, referrer.password);

  const referralInput = page.getByLabel('あなたの紹介URL');
  await expect(referralInput).toBeVisible();
  const referralUrl = await referralInput.inputValue();
  expect(new URL(referralUrl).pathname).toBe('/register');
  expect(new URL(referralUrl).searchParams.get('invite')).toBe(referrer.user.referralCode);

  const lineLink = page.getByRole('link', { name: 'LINEで紹介' });
  const lineHref = await lineLink.getAttribute('href');
  const parsedLineUrl = new URL(lineHref!);
  expect(parsedLineUrl.origin).toBe('https://social-plugins.line.me');
  expect(parsedLineUrl.searchParams.get('url')).toBe(referralUrl);
  expect(lineHref).not.toContain(referrer.user.email!);
  expect(lineHref).not.toContain(referrer.password);
  await expect(page.getByRole('button', { name: '紹介URLをコピー' })).toBeVisible();

  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await page.goto(referralUrl);
  await expect(page.getByRole('heading', { name: '無料会員登録', exact: true })).toBeVisible();
  await expect(page.getByText('紹介コードが不正です')).toHaveCount(0);

  const friendEmail = `browser-referral-${randomBytes(7).toString('hex')}@example.test`;
  const friendPassword = randomBytes(18).toString('base64url');
  await page.getByLabel('表示名', { exact: true }).fill('紹介された会員');
  await page.getByLabel('メールアドレス', { exact: true }).fill(friendEmail);
  await page.getByLabel('パスワード', { exact: true }).fill(friendPassword);
  await page.getByLabel('20歳以上です。').check();
  await page.getByLabel('利用規約（開発用）に同意します。').check();
  await page.getByLabel('プライバシーポリシー（開発用）に同意します。').check();
  await page.getByRole('button', { name: '同意して登録する' }).click();
  await expect(page.getByRole('heading', { name: 'メールアドレスを確認' })).toBeVisible();

  const friend = await db.user.findUniqueOrThrow({ where: { email: friendEmail } });
  expect(await db.referral.findUnique({ where: { referredUserId: friend.id } })).toMatchObject({ referrerUserId: referrer.user.id, status: 'PENDING' });
  const mail = JSON.parse(await readFile(resolve('.local/mail', `${friend.id}-verify.json`), 'utf8')) as { url: string };
  const verification = new URL(mail.url);
  await page.goto(`${verification.pathname}${verification.search}`);
  await expect(page.getByRole('heading', { name: 'マイページ', exact: true })).toBeVisible();
  expect(await db.referral.findUnique({ where: { referredUserId: friend.id } })).toMatchObject({ referrerUserId: referrer.user.id, status: 'QUALIFIED', qualifiedAt: expect.any(Date) });

  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await login(page, referrer.user.email!, referrer.password);
  await expect(page.locator('.referral-hero > div').first().locator('strong')).toHaveText('1人');
  await expect(page.getByText('あと2人で一日券プレゼント', { exact: true })).toBeVisible();

  // Populate the remaining UI states without repeating the whole browser
  // registration flow; milestone behavior itself is covered by integration tests.
  for (let index = 0; index < 2; index += 1) {
    const referred = await account();
    await db.referral.create({ data: { referrerUserId: referrer.user.id, referredUserId: referred.user.id, status: 'QUALIFIED', qualifiedAt: new Date() } });
  }
  const milestone = await db.referralMilestone.findUniqueOrThrow({ where: { requiredReferralCount: 3 } });
  await db.referralReward.create({ data: { userId: referrer.user.id, milestoneId: milestone.id, rewardType: 'DAY_PASS', expiresAt: new Date(Date.now() + 60 * 86400000) } });
  await page.reload();
  await expect(page.getByText('あと7人で一日券プレゼント', { exact: true })).toBeVisible();
  await expect(page.getByText('3人達成', { exact: true })).toBeVisible();
  await expect(page.getByText('10人達成', { exact: true })).toBeVisible();
  await expect(page.getByText('利用できる一日券', { exact: true })).toBeVisible();
  await expect(page.getByLabel('利用日')).toBeVisible();
  await expect(page.getByText(/有効期限/)).toBeVisible();
  for (const internal of ['QUALIFIED', 'REDEEMED', 'Entitlement', 'Milestone']) await expect(page.getByText(internal, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('administrator can review and invalidate a referral without exposing contact identifiers', async ({ page }) => {
  const suffix = randomBytes(5).toString('hex');
  const ownerFixture = await account();
  const owner = await db.user.update({ where: { id: ownerFixture.user.id }, data: { displayName: `紹介者${suffix}` } });
  let selectedReferralId = '';
  for (let index = 0; index < 3; index += 1) {
    const referredFixture = await account();
    const referred = await db.user.update({ where: { id: referredFixture.user.id }, data: { displayName: `被紹介者${suffix}-${index + 1}` } });
    const referral = await db.referral.create({ data: { referrerUserId: owner.id, referredUserId: referred.id, status: 'QUALIFIED', qualifiedAt: new Date() } });
    if (index === 2) selectedReferralId = referral.id;
  }
  const milestone = await db.referralMilestone.findUniqueOrThrow({ where: { requiredReferralCount: 3 } });
  await db.referralReward.create({ data: { userId: owner.id, milestoneId: milestone.id, rewardType: 'DAY_PASS', expiresAt: new Date(Date.now() + 60 * 86400000) } });

  const adminFixture = await account('ADMIN'); const client = new Client(); await client.login(adminFixture); await client.mfa();
  await page.context().addCookies([{ name: 'keiba_session', value: client.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/admin/referrals');
  await expect(page.getByRole('heading', { name: '紹介管理', exact: true })).toBeVisible();
  for (const label of ['紹介経由登録', '紹介者', '3人達成', '10人達成', '特典付与', '特典使用']) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(owner.email ?? '')).toHaveCount(0);

  const row = page.locator('.referral-admin-list button').filter({ hasText: `被紹介者${suffix}-3` });
  await row.click();
  await expect(page.getByRole('heading', { name: '紹介詳細', exact: true })).toBeVisible();
  await expect(page.locator('.referral-detail')).toContainText(`紹介者${suffix}`);
  await expect(page.locator('.referral-detail')).toContainText('EMAIL登録');
  await page.getByLabel('理由').fill('E2Eで不正紹介の無効化操作を確認');
  await page.getByRole('button', { name: '無効化する' }).click();
  await expect(page.getByRole('status')).toContainText('未使用特典を安全に再計算しました');
  expect(await db.referral.findUniqueOrThrow({ where: { id: selectedReferralId } })).toMatchObject({ status: 'INVALIDATED', invalidatedReason: 'E2Eで不正紹介の無効化操作を確認' });
  expect(await db.auditLog.findFirst({ where: { action: 'REFERRAL_INVALIDATED', targetId: selectedReferralId, targetType: 'REFERRAL' } })).not.toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
