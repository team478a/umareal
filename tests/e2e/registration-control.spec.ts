import { expect, test } from '@playwright/test';
import { PrismaClient } from '../../packages/db/src';
import { account, Client } from '../helpers';

const db = new PrismaClient();
test.afterAll(() => db.$disconnect());

test('an AAL2 administrator pauses and resumes registration while login remains available', async ({ page }) => {
  const admin = await account('ADMIN'); const client = new Client(); await client.login(admin); await client.mfa();
  await db.systemSetting.update({ where: { id: 'global' }, data: { newRegistrationsEnabled: true, registrationPauseMessage: '', registrationCaptchaEnabled: false, turnstileSiteKey: null, turnstileSecretEncrypted: null } });
  try {
    await page.context().addCookies([{ name: 'keiba_session', value: client.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { name: '機能の停止・再開' })).toBeVisible();
    await page.getByLabel('新規会員登録を有効にする').uncheck();
    await page.getByLabel('登録停止中の会員向け案内').fill('募集人数を確認しています。明日10時に受付状況をご案内します。');
    await page.getByLabel('管理設定の変更理由').fill('募集枠確認のため一時停止');
    await page.getByRole('button', { name: '管理設定を保存' }).click();
    await expect(page.getByRole('status')).toContainText('管理設定を保存しました。');

    await page.context().clearCookies();
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: '無料会員登録を一時停止しています' })).toBeVisible();
    await expect(page.getByText('募集人数を確認しています。明日10時に受付状況をご案内します。')).toBeVisible();
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'おかえりなさい' })).toBeVisible();
    await expect(page.getByText('現在、新規会員登録は受付を停止しています。')).toBeVisible();

    await page.context().addCookies([{ name: 'keiba_session', value: client.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await page.goto('/admin/settings');
    await page.getByLabel('新規会員登録を有効にする').check();
    await page.getByLabel('登録停止中の会員向け案内').fill('');
    await page.getByLabel('管理設定の変更理由').fill('募集枠確認完了のため再開');
    await page.getByRole('button', { name: '管理設定を保存' }).click();
    await expect(page.getByRole('status')).toContainText('管理設定を保存しました。');

    await page.context().clearCookies();
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: '無料会員登録', exact: true })).toBeVisible();
  } finally {
    await db.systemSetting.update({ where: { id: 'global' }, data: { newRegistrationsEnabled: true, registrationPauseMessage: '', registrationCaptchaEnabled: false, turnstileSiteKey: null, turnstileSecretEncrypted: null } });
  }
});
