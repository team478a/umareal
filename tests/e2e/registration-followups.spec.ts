import { test, expect } from '@playwright/test';
import { account, Client, db } from '../helpers';

test.afterAll(async () => db.$disconnect());

test('administrator follows up an unverified free registration', async ({ page, context }) => {
  if (process.env.AUTH_PROVIDER !== 'local' || !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Follow-up browser test requires local development services');
  const admin = await account('ADMIN'); const client = new Client(); await client.login(admin); await client.mfa();
  const pending = await account();
  await db.user.update({ where: { id: pending.user.id }, data: { emailVerifiedAt: null, createdAt: new Date('2000-01-01T00:00:00Z') } });
  const [name, value] = client.cookie.split('=');
  await context.addCookies([{ name, value, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);

  await page.goto('/admin/registration-followups');
  await expect(page.getByRole('heading', { name: '本人確認フォロー', exact: true })).toBeVisible();
  await expect(page.getByLabel('本人確認待ち集計')).toContainText('30分以上経過');
  const row = page.locator('.followup-row').filter({ hasText: pending.user.email! });
  await expect(row).toContainText('要確認');
  await row.getByLabel(`${pending.user.email}への再送理由`).fill('画面試験での未着フォロー');
  await row.getByLabel(`${pending.user.email}へ確認メールを再送`).click();
  await expect(page.getByRole('status')).toContainText('確認メールを再送しました。');
  await expect(row.getByLabel(`${pending.user.email}へ確認メールを再送`)).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
