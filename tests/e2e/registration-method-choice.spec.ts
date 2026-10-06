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

test('starts LINE first from the LP entry and then shows only the final system registration', async ({ page }) => {
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
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorizationUrl: `${origin}/register/line?token=e2e-line-first-grant` }) });
  });

  await page.goto('/register?entry=line&utm_source=lp&utm_campaign=opening&invite=FRIEND123');
  await expect(page).toHaveURL(/\/register\/line\?token=e2e-line-first-grant$/);
  await expect(page.getByRole('heading', { name: 'システム会員登録' })).toBeVisible();
  await expect(page.getByText('LINEの確認は完了しています。こちらが最後の登録画面です。')).toBeVisible();
  await expect(page.getByRole('button', { name: '同意してシステム登録を完了' })).toBeVisible();
  expect(lineStart).toMatchObject({
    purpose: 'REGISTER',
    memberReferralCode: 'FRIEND123',
    acquisition: { source: 'lp', campaign: 'opening', landingPath: '/register' }
  });
});

test('does not continue to system registration until LINE friendship is confirmed', async ({ page }) => {
  await page.route('**/api/v1/auth/config', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      provider: 'local', localOnly: true, launchMode: 'FREE_REGISTRATION',
      capabilities: { emailRegistration: true, freeContent: true, lineLogin: true, lineNotifications: false, billing: false },
      registration: { enabled: true, message: '' }, captcha: { enabled: false, siteKey: null, mode: 'TEST_ONLY' },
      emailNotificationsEnabled: false, lineEnabled: true, lineNotificationsEnabled: false
    }) });
  });

  let starts = 0;
  await page.route('**/api/v1/auth/line/start', async route => {
    starts += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authorizationUrl: '/line-retry' }) });
  });

  await page.goto('/register?entry=line&line=friend-required');
  await expect(page.getByRole('heading', { name: 'LINE友だち追加が必要です' })).toBeVisible();
  await expect(page.getByText('公式LINEを友だち追加してから、もう一度お進みください。')).toBeVisible();
  expect(starts).toBe(0);
});

test('shows recovery guidance instead of raw JSON for a closed LINE account', async ({ page }) => {
  await page.route('**/api/v1/auth/config', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      provider: 'local', localOnly: true, launchMode: 'FREE_REGISTRATION',
      capabilities: { emailRegistration: true, freeContent: true, lineLogin: true, lineNotifications: false, billing: false },
      registration: { enabled: true, message: '' }, captcha: { enabled: false, siteKey: null, mode: 'TEST_ONLY' },
      emailNotificationsEnabled: false, lineEnabled: true, lineNotificationsEnabled: false
    }) });
  });

  await page.goto('/login?line=account-unavailable');
  await expect(page.getByText('このLINEは既存または退会済みの会員情報に紐づいているため、新しい会員として再登録できません。')).toBeVisible();
  await expect(page.getByText('退会後の再利用には運営の確認が必要です。')).toBeVisible();
  await expect(page.getByText(/別のLINEやメールで登録し直さず/)).toBeVisible();
  await expect(page.getByText(/紹介コードは自動では後付けされず/)).toBeVisible();
  await expect(page.getByLabel('メールアドレス', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'LINEでログイン' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
