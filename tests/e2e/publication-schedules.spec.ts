import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from '../helpers';

test.afterAll(() => db.$disconnect());

test('staff previews scheduled race announcements and free reports on mobile-ready UI', async ({ page }, testInfo) => {
  const admin = await account('ADMIN'); const suffix = randomUUID().slice(0, 6); const raceDate = '2099-11-07'; const race = await db.race.create({ data: { raceDate, venue: `予約E2E${suffix}`, number: 3, name: `予約画面${suffix}`, startsAt: new Date(`${raceDate}T15:00:00+09:00`) } });
  const horses = await Promise.all(['上昇候補', '下降候補'].map(async (name, index) => { const horse = await db.horse.create({ data: { id: randomUUID(), name: `${name}${suffix}` } }); return db.raceEntry.create({ data: { raceId: race.id, horseId: horse.id, number: index + 1, gate: index + 1, horseName: horse.name, sex: 'MALE', age: 4, carriedWeight: 57, jockey: `騎手${index}`, trainer: `調教師${index}` } }); }));
  await db.freeReportDraft.create({ data: { raceId: race.id, upEntryId: horses[0].id, upReason: '踏み込み良好', downEntryId: horses[1].id, downReason: '気配に注意', audioUrl: 'https://media.example.test/paddock.mp3', reviewText: '', updatedBy: admin.user.id } });
  const client = new Client(); await client.login(admin); await client.mfa(); await page.context().addCookies([{ name: 'keiba_session', value: client.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/admin/publication-schedules'); await expect(page.getByRole('heading', { name: '配信予約・アラート' })).toBeVisible(); await page.getByLabel('開催日').fill(raceDate);
  const card = page.locator('.schedule-race').filter({ hasText: race.name }); await expect(card).toBeVisible(); await card.getByLabel('公開日時（JST）').fill(`${raceDate}T14:30`); await card.getByLabel('予約理由').fill('E2Eで定刻配信を確認'); await card.getByRole('button', { name: '配信内容を確認' }).click();
  await expect(card.getByRole('heading', { name: '配信前確認' })).toBeVisible(); await expect(card.locator('.delivery-preview-summary')).toContainText('配信予定'); await card.getByRole('button', { name: 'この内容で予約する' }).click();
  await expect(card.getByText('予約中')).toBeVisible(); await card.getByLabel('対象レース告知の取消理由').fill('時刻を再調整'); await card.getByRole('button', { name: '取消', exact: true }).click(); await expect(card.getByText('取消済み')).toBeVisible();
  await card.getByLabel('配信').selectOption('FREE_REPORT_PRE_RACE'); await card.getByLabel('予約理由').fill('無料速報の定刻配信を確認'); await card.getByRole('button', { name: '配信内容を確認' }).click();
  await expect(card.locator('.delivery-preview')).toContainText('無料パドック速報 第1版'); await expect(card.locator('.delivery-message')).toContainText('無料パドック速報を公開しました'); await card.getByRole('button', { name: 'この内容で予約する' }).click();
  await expect(card.getByText('無料パドック速報').last()).toBeVisible(); await expect(card.getByText('予約中')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('publication-schedules.png'), fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
