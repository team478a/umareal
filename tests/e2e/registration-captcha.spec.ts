import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { encryptSecret, PrismaClient } from '../../packages/db/src';

const db = new PrismaClient();
test.afterAll(() => db.$disconnect());

test('email registration requires the configured local CAPTCHA answer on desktop/mobile', async ({ page }) => {
  const email = `captcha-${randomBytes(6).toString('hex')}@example.test`;
  await db.systemSetting.update({ where: { id: 'global' }, data: { newRegistrationsEnabled: true, registrationPauseMessage: '', registrationCaptchaEnabled: true, turnstileSiteKey: '0x4AAAA-e2e-site-key', turnstileSecretEncrypted: encryptSecret('0x4AAAA-e2e-secret-key') } });
  try {
    await page.goto('/register');
    await expect(page.getByRole('button', { name: '確認を完了してください' })).toBeDisabled();
    await page.getByLabel('表示名', { exact: true }).fill('Bot対策確認ユーザー');
    await page.getByLabel('メールアドレス', { exact: true }).fill(email);
    await page.getByLabel('パスワード', { exact: true }).fill('registration-captcha-password');
    await page.getByLabel('20歳以上です。').check();
    await page.getByLabel('利用規約（開発用）に同意します。').check();
    await page.getByLabel('プライバシーポリシー（開発用）に同意します。').check();
    await page.getByRole('checkbox', { name: /自動送信ではありません/ }).check();
    await page.getByRole('button', { name: '同意して登録する' }).click();
    await expect(page.getByRole('heading', { name: 'メールアドレスを確認' })).toBeVisible();
    expect(await db.user.findUnique({ where: { email } })).not.toBeNull();
  } finally {
    await db.systemSetting.update({ where: { id: 'global' }, data: { registrationCaptchaEnabled: false, turnstileSiteKey: null, turnstileSecretEncrypted: null } });
  }
});
