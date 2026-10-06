import { test, expect } from '@playwright/test';
import { account, db, totp } from '../helpers';

test.afterAll(async () => db.$disconnect());

test('administrator reviews production backup evidence on desktop and mobile', async ({ page }) => {
  test.setTimeout(90000);
  if (process.env.AUTH_PROVIDER !== 'local' || !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Backup browser test requires local development database');
  const fixture = await account('ADMIN');
  await page.goto('/login');
  await page.getByLabel('メールアドレス', { exact: true }).fill(fixture.user.email);
  await page.getByLabel('パスワード', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'マイページ', exact: true })).toBeVisible();
  await page.goto('/security');
  await page.getByRole('button', { name: '設定を始める' }).click();
  const secret = await page.locator('.setup-secret code').innerText();
  await page.getByLabel('認証コード').fill(totp(secret));
  await page.getByRole('button', { name: 'コードを確認' }).click();
  await expect(page.getByRole('heading', { name: '二段階認証が完了しています' })).toBeVisible();

  await page.goto('/admin/backups');
  await expect(page.getByRole('heading', { name: '本番バックアップ運用を記録', exact: true })).toBeVisible();
  await expect(page.getByLabel('バックアップ提供元')).toBeVisible();
  await expect(page.getByLabel('保持日数')).toHaveValue('30');
  await expect(page.getByLabel('保持世代数')).toHaveValue('14');
  await expect(page.getByLabel('RPO（分）')).toHaveValue('60');
  await expect(page.getByLabel('RTO（分）')).toHaveValue('240');
  await expect(page.getByLabel('証跡参照番号')).toHaveAttribute('pattern', '[A-Za-z0-9][A-Za-z0-9._/-]*');
  await expect(page.getByLabel('保存時の暗号化を確認')).not.toBeChecked();
  await expect(page.getByRole('button', { name: '運用確認を記録', exact: true })).toBeDisabled();
  await expect(page.getByText('外部基盤を自動検証した扱いにはなりません', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
