import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { account, db, totp } from '../helpers';

test.afterAll(async () => db.$disconnect());

test('administrator searches the safe audit trail', async ({ page }) => {
  if (process.env.AUTH_PROVIDER !== 'local' || !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Audit browser test requires local development database');
  const fixture = await account('ADMIN');
  const requestId = randomUUID();
  await db.auditLog.create({ data: { actorId: fixture.user.id, actorRole: 'ADMIN', action: 'AUDIT_BROWSER_TEST', targetType: 'TEST_TARGET', targetId: randomUUID(), reason: 'ブラウザ表示試験', details: { hidden: 'secret-value' }, requestId } });
  await page.goto('/login');
  await page.getByLabel('メールアドレス', { exact: true }).fill(fixture.user.email!);
  await page.getByLabel('パスワード', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'マイページ', exact: true })).toBeVisible();
  await page.goto('/security');
  await page.getByRole('button', { name: '設定を始める' }).click();
  const secret = await page.locator('.setup-secret code').innerText();
  await page.getByLabel('認証コード').fill(totp(secret));
  await page.getByRole('button', { name: 'コードを確認' }).click();
  await expect(page.getByRole('heading', { name: '二段階認証が完了しています' })).toBeVisible();
  await page.goto('/admin/audit');
  await expect(page.getByRole('heading', { name: '操作履歴', exact: true })).toBeVisible();
  await page.getByLabel('操作').fill('AUDIT_BROWSER');
  await page.getByLabel('リクエストID').fill(requestId);
  await page.getByRole('button', { name: '絞り込む' }).click();
  const row = page.getByRole('row').filter({ hasText: requestId });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('AUDIT_BROWSER_TEST', { exact: true }).first()).toBeVisible();
  await expect(row.getByRole('cell').nth(1)).toContainText(fixture.user.displayName);
  await expect(row.getByText('ブラウザ表示試験', { exact: true })).toBeVisible();
  await expect(page.getByText('secret-value')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
