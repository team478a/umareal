import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from '../helpers';

test.afterAll(() => db.$disconnect());

test('staff schedules and cancels a target-race announcement on mobile-ready UI', async ({ page }, testInfo) => {
  const admin = await account('ADMIN'); const suffix = randomUUID().slice(0, 6); const raceDate = '2099-11-07'; const race = await db.race.create({ data: { raceDate, venue: `予約E2E${suffix}`, number: 3, name: `予約画面${suffix}`, startsAt: new Date(`${raceDate}T15:00:00+09:00`) } });
  const client = new Client(); await client.login(admin); await client.mfa(); await page.context().addCookies([{ name: 'keiba_session', value: client.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/admin/publication-schedules'); await expect(page.getByRole('heading', { name: '配信予約・アラート' })).toBeVisible(); await page.getByLabel('開催日').fill(raceDate);
  const card = page.locator('.schedule-race').filter({ hasText: race.name }); await expect(card).toBeVisible(); await card.getByLabel('公開日時（JST）').fill(`${raceDate}T14:30`); await card.getByLabel('予約理由').fill('E2Eで定刻配信を確認'); await card.getByRole('button', { name: '配信内容を確認' }).click();
  await expect(card.getByRole('heading', { name: '配信前確認' })).toBeVisible(); await expect(card.locator('.delivery-preview-summary')).toContainText('配信予定'); await card.getByRole('button', { name: 'この内容で予約する' }).click();
  await expect(card.getByText('予約中')).toBeVisible(); await card.getByLabel('対象レース告知の取消理由').fill('時刻を再調整'); await card.getByRole('button', { name: '取消', exact: true }).click(); await expect(card.getByText('取消済み')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('publication-schedules.png'), fullPage: true }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
