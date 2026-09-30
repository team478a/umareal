import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from '../helpers';

test.afterAll(() => db.$disconnect());

test('staff publishes the legacy free report and a member receives metadata only', async ({ page }, testInfo) => {
  const admin = await account('ADMIN'); const member = await account(); const suffix = randomUUID().slice(0, 6); const raceDate = '2099-10-17';
  const race = await db.race.create({ data: { raceDate, venue: `無料E2E${suffix}`, number: 6, name: `無料パドック速報${suffix}`, startsAt: new Date(`${raceDate}T15:00:00+09:00`) } });
  const horses = await Promise.all(['上向きホース', '注意ホース'].map(async (name, index) => {
    const horse = await db.horse.create({ data: { id: randomUUID(), name: `${name}${suffix}` } });
    return db.raceEntry.create({ data: { raceId: race.id, horseId: horse.id, number: index + 1, gate: index + 1, horseName: horse.name, sex: 'MALE', age: 4, carriedWeight: 57, jockey: `騎手${index}`, trainer: `調教師${index}` } });
  }));
  const adminClient = new Client(); await adminClient.login(admin); await adminClient.mfa();
  await page.context().addCookies([{ name: 'keiba_session', value: adminClient.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/admin/free-reports');
  await expect(page.getByRole('heading', { name: '無料会員向け配信', exact: true })).toBeVisible();
  await page.getByLabel('開催日').fill(raceDate);
  const row = page.locator('.race-row').filter({ hasText: race.name }); await expect(row).toBeVisible(); await row.getByRole('button', { name: '編集' }).click();
  await page.getByLabel('評価UP馬').selectOption(horses[0].id); await page.getByLabel('評価を上げた理由').fill('踏み込みが力強く、前走以上です。');
  await page.getByLabel('評価DOWN馬').selectOption(horses[1].id); await page.getByLabel('評価を下げた理由').fill('発汗が目立ち、落ち着きを欠きます。');
  await expect(page.getByRole('button', { name: 'マイクで録音' })).toBeVisible();
  await page.locator('input[type="file"][accept="audio/*"]').setInputFiles({ name: 'paddock.webm', mimeType: 'audio/webm', buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]) });
  await expect(page.locator('.audio-input audio')).toBeVisible(); await page.getByLabel('保存・公開理由').fill('LP無料速報の画面確認');
  await page.getByRole('button', { name: '下書きを保存' }).click(); await expect(page.getByRole('status')).toContainText('下書きを保存しました');
  await expect(page.getByText('下書き v1')).toBeVisible();
  await page.getByLabel('評価を上げた理由').fill('再確認しても踏み込みが力強く、前走以上です。'); await page.getByLabel('保存・公開理由').fill('保存済み下書きを再確認');
  await page.getByRole('button', { name: '下書きを保存' }).click(); await expect(page.getByText('下書き v2')).toBeVisible();
  await page.getByLabel('保存・公開理由').fill('発走前の会員公開'); await page.getByRole('button', { name: '発走前速報の配信内容を確認' }).click();
  await expect(page.getByRole('heading', { name: '配信前確認' })).toBeVisible(); await expect(page.locator('.delivery-preview')).toContainText('無料パドック速報 第1版'); await expect(page.locator('.delivery-message')).toContainText('無料パドック速報を公開しました');
  await page.getByRole('button', { name: 'この内容で発走前速報を公開' }).click(); await expect(page.getByRole('status')).toContainText('公開しました');
  const memberClient = new Client(); await memberClient.login(member); await page.context().clearCookies();
  await page.context().addCookies([{ name: 'keiba_session', value: memberClient.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto(`/races/${race.id}`);
  await expect(page.getByRole('heading', { name: '無料パドック速報を公開済みです', exact: true })).toBeVisible();
  await expect(page.getByText('第1版 · 発走前速報', { exact: false })).toBeVisible();
  await expect(page.getByText(horses[0].horseName)).toHaveCount(0); await expect(page.getByText(horses[1].horseName)).toHaveCount(0);
  await expect(page.getByText('無料会員には公開状況のみをお知らせしています。馬の評価や詳細見解は有料会員向けの最終評価で確認できます。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('free-report.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('a LINE registrant receives, opens and can revisit the registration benefit', async ({ page }, testInfo) => {
  const admin = await account('ADMIN'); const member = await account();
  await db.user.update({ where: { id: member.user.id }, data: { registrationMethod: 'LINE' } });
  const adminClient = new Client(); await adminClient.login(admin); await adminClient.mfa();
  const current = await adminClient.call('admin/free-reports/benefit');
  expect(current.status).toBe(200);
  const videoUrl = `https://video.example.test/line-benefit-${randomUUID()}`;
  const saved = await adminClient.call('admin/free-reports/benefit', 'PATCH', { revision: current.body.revision, title: 'LINE登録特典動画', description: '登録ありがとうございます。こちらの動画をご覧ください。', videoUrl, reason: 'LINE登録特典E2E' });
  expect(saved.status).toBe(200);

  const memberClient = new Client(); await memberClient.login(member);
  await page.context().addCookies([{ name: 'keiba_session', value: memberClient.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/account?line=registered');
  await expect(page.getByText('LINE無料登録が完了しました。登録特典を受け取れます。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '登録特典を受け取れます' })).toBeVisible();
  await page.getByRole('link', { name: '特典動画を見る' }).click();
  await expect(page).toHaveURL(/\/benefit$/);
  await expect(page.getByRole('heading', { name: 'LINE登録特典動画' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.route(videoUrl, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>登録特典動画</title><h1>動画配信ページ</h1>' }));
  await page.getByRole('button', { name: '動画を見る' }).click();
  await expect(page).toHaveURL(videoUrl);
  expect(await db.memberJourneyEvent.count({ where: { userId: member.user.id, eventType: 'REGISTRATION_BENEFIT_VIEWED' } })).toBe(1);

  await page.goto('/account');
  await expect(page.getByRole('link', { name: '特典動画をもう一度見る' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('line-registration-benefit.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
