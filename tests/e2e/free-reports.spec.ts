import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from '../helpers';

test.afterAll(() => db.$disconnect());

test('staff publishes the LP free report and a member can read only that offer', async ({ page }, testInfo) => {
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
  await page.getByLabel('保存・公開理由').fill('発走前の会員公開'); await page.getByRole('button', { name: '発走前速報の配信内容を確認' }).click();
  await expect(page.getByRole('heading', { name: '配信前確認' })).toBeVisible(); await expect(page.locator('.delivery-preview')).toContainText('無料パドック速報 第1版'); await expect(page.locator('.delivery-message')).toContainText('無料パドック速報を公開しました');
  await page.getByRole('button', { name: 'この内容で発走前速報を公開' }).click(); await expect(page.getByRole('status')).toContainText('公開しました');
  const memberClient = new Client(); await memberClient.login(member); await page.context().clearCookies();
  await page.context().addCookies([{ name: 'keiba_session', value: memberClient.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto(`/races/${race.id}`);
  await expect(page.getByRole('heading', { name: '無料パドック速報', exact: true })).toBeVisible();
  await expect(page.getByText(`1番 ${horses[0].horseName}`)).toBeVisible(); await expect(page.getByText(`2番 ${horses[1].horseName}`)).toBeVisible();
  await expect(page.getByText('無料速報には最終本命・全頭評価・対抗・穴馬・買い目を含みません。')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('free-report.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
