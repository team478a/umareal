import { expect, test } from '@playwright/test';

test('chooses LINE or email before showing the registration form', async ({ page }) => {
  await page.route('**/api/v1/auth/config', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      provider: 'local', localOnly: true, launchMode: 'FREE_REGISTRATION',
      capabilities: { emailRegistration: true, freeContent: true, lineLogin: true, lineNotifications: false, billing: false },
      registration: { enabled: true, message: '' }, captcha: { enabled: false, siteKey: null, mode: 'TEST_ONLY' },
      emailNotificationsEnabled: false, lineEnabled: true, lineNotificationsEnabled: false
    }) });
  });

  let lineStart: Record<string, unknown> | undefined;
  await page.route('**/api/v1/auth/line/start', async route => {
    lineStart = route.request().postDataJSON() as Record<string, unknown>;
    const origin = new URL(route.request().url()).origin;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorizationUrl: `${origin}/register/line?token=e2e-line-grant` }) });
  });

  await page.goto('/register?utm_source=lp&utm_campaign=opening&ref=staff_01&invite=FRIEND123');
  await expect(page.getByRole('heading', { name: '登録方法を選ぶ' })).toBeVisible();
  await expect(page.getByLabel('メールアドレス', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /LINEで登録/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /メールで登録/ })).toBeVisible();

  await page.getByRole('button', { name: /メールで登録/ }).click();
  await expect(page.getByLabel('表示名', { exact: true })).toBeVisible();
  await expect(page.getByLabel('メールアドレス', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '同意してメール無料登録を完了' })).toBeVisible();

  await page.getByRole('button', { name: '登録方法を選び直す' }).click();
  await expect(page.getByRole('heading', { name: '登録方法を選ぶ' })).toBeVisible();
  await page.getByRole('button', { name: /LINEで登録/ }).click();
  await expect(page).toHaveURL(/\/register\/line\?token=e2e-line-grant$/);
  expect(lineStart).toMatchObject({
    purpose: 'REGISTER',
    memberReferralCode: 'FRIEND123',
    acquisition: { source: 'lp', campaign: 'opening', referralCode: 'staff_01', landingPath: '/register' }
  });
});
