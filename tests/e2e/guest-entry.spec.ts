import { expect, test } from '@playwright/test';

test('guests see a minimal root entry and no member menu', async ({ page }) => {
  await page.route('**/api/v1/auth/config', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      provider: 'local', localOnly: true, launchMode: 'FREE_REGISTRATION',
      capabilities: { emailRegistration: true, freeContent: true, lineLogin: true, lineNotifications: false, billing: false },
      registration: { enabled: true, message: '' }, captcha: { enabled: false, siteKey: null, mode: 'TEST_ONLY' },
      emailNotificationsEnabled: false, lineEnabled: true, lineNotificationsEnabled: false
    }) });
  });
  await page.route('**/api/v1/me', async route => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: '認証が必要です。' }) });
  });

  await page.goto('/');

  await expect(page.locator('main')).toHaveAttribute('class', 'guest-entry');
  await expect(page.getByRole('region', { name: '競馬会員メディア' })).toContainText('競馬会員メディア');
  await expect(page.getByRole('link', { name: 'ログイン', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '無料会員登録', exact: true })).toBeVisible();
  await expect(page.getByRole('link')).toHaveCount(2);
  await expect(page.locator('aside, header, footer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'メニューを開く' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'メインメニュー' })).toHaveCount(0);
  await expect(page.getByText('WIN5紙面', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'おかえりなさい' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'メニューを開く' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'メインメニュー' })).toHaveCount(0);

  await page.goto('/login?line=not-linked&returnTo=%2Fbenefit');
  await expect(page.getByText('このLINEではログイン登録がまだ完了していません。')).toBeVisible();
  await expect(page.getByText('メールで登録済みの方は、メールでログイン後にマイページからLINEを連携できます。')).toBeVisible();
  await page.getByRole('link', { name: 'LINE無料登録へ', exact: true }).click();
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole('heading', { name: '登録方法を選ぶ', exact: true })).toBeVisible();

  await expect(page.getByRole('heading', { name: '無料会員登録' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'メニューを開く' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'メインメニュー' })).toHaveCount(0);
});
