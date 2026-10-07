import { expect, test } from '@playwright/test';
import { PrismaClient } from '../../packages/db/src';
import { account, Client } from '../helpers';

const db = new PrismaClient();
test.afterAll(() => db.$disconnect());

function jstDateTimeLocal(date: Date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 16);
}

test('an AAL2 administrator pauses and resumes registration while login remains available', async ({ page }) => {
  const admin = await account('ADMIN'); const client = new Client(); await client.login(admin); await client.mfa();
  await db.systemSetting.update({ where: { id: 'global' }, data: { newRegistrationsEnabled: true, registrationPauseMessage: '', registrationCaptchaEnabled: false, turnstileSiteKey: null, turnstileSecretEncrypted: null } });
  try {
    await page.context().addCookies([{ name: 'keiba_session', value: client.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { name: '機能の停止・再開' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '配備環境' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '予想の公開・訂正ルール' })).toBeVisible();
    await expect(page.getByLabel('訂正版を公開できる権限')).toBeVisible();
    await expect(page.getByLabel('延期レースの公開ルール')).toBeVisible();
    await expect(page.getByLabel('WIN5 1点あたり初期金額')).toHaveCount(0);
    await expect(page.getByLabel('WIN5 組合せ数の警告値')).toHaveCount(0);
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

test('an AAL2 administrator schedules free full prediction access for the test period', async ({ page }) => {
  const admin = await account('ADMIN'); const client = new Client(); await client.login(admin); await client.mfa();
  const original = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { freePredictionTrialEnabled: true, freePredictionTrialEndsAt: true } });
  const endsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  try {
    await db.systemSetting.update({ where: { id: 'global' }, data: { freePredictionTrialEnabled: false, freePredictionTrialEndsAt: null } });
    await page.context().addCookies([{ name: 'keiba_session', value: client.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await page.goto('/admin/settings');

    await expect(page.getByRole('heading', { name: '無料会員向け予想全文テスト' })).toBeVisible();
    await page.getByLabel('無料会員向け予想全文テストを有効にする').check();
    await page.getByLabel('無料会員向け予想全文テストの終了日時').fill(jstDateTimeLocal(endsAt));
    await page.getByLabel('管理設定の変更理由').fill('週末の実配信テストを実施');
    await page.getByRole('button', { name: '管理設定を保存' }).click();
    await expect(page.getByRole('status')).toContainText('管理設定を保存しました。');

    await page.reload();
    await expect(page.getByLabel('無料会員向け予想全文テストを有効にする')).toBeChecked();
    await expect(page.getByText(/登録済み無料会員だけにWIN5紙面とパドック直前予想の全文を表示します/)).toBeVisible();
    await expect(page.getByText('実施中', { exact: true })).toBeVisible();
  } finally {
    await db.systemSetting.update({ where: { id: 'global' }, data: { freePredictionTrialEnabled: original.freePredictionTrialEnabled, freePredictionTrialEndsAt: original.freePredictionTrialEndsAt } });
  }
});
