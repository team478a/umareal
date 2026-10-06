import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { account, db } from '../helpers';

test.afterAll(() => db.$disconnect());

test('searches published race history by period and horse without exposing paid content', async ({ page }) => {
  const key = Number.parseInt(randomUUID().slice(0, 8), 16);
  const date = `2088-${String(1 + key % 12).padStart(2, '0')}-${String(1 + Math.floor(key / 12) % 28).padStart(2, '0')}`;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 7);
  const admin = await account('ADMIN');
  const race = await db.race.create({ data: { raceDate: date, venue: '東京', number: 11, name: `検索記念${suffix}`, startsAt: new Date(`${date}T15:30:00+09:00`) } });
  const horse = await db.horse.create({ data: { id: randomUUID(), name: `履歴馬${suffix}` } });
  await db.raceEntry.create({ data: { raceId: race.id, horseId: horse.id, number: 4, gate: 2, horseName: horse.name, sex: 'FEMALE', age: 4, carriedWeight: 55, jockey: '履歴騎手', trainer: '履歴調教師' } });
  const prediction = await db.prediction.create({ data: { raceId: race.id, draft: {}, revision: 1, updatedBy: admin.user.id } });
  await db.predictionVersion.create({ data: { predictionId: prediction.id, version: 1, status: 'PUBLISHED', visibility: 'PAID', confidence: 'A', formatVersion: 'HORSE_EVALUATION_V1', summary: `非公開本文${suffix}`, assessmentSnapshot: {}, contentSnapshot: { secret: `非公開評価${suffix}` }, publisherId: admin.user.id, deadlineAt: race.startsAt } });
  await db.race.update({ where: { id: race.id }, data: { status: 'FINISHED' } });
  await db.raceResultVersion.create({ data: { raceId: race.id, version: 1, sourceRevision: 1, ruleVersion: 'HORSE_EVALUATION_V1', entriesSnapshot: [], payoutsSnapshot: [], reason: '検索画面試験', confirmedBy: admin.user.id } });

  await page.goto('/races');
  await page.getByRole('button', { name: '期間から探す' }).click();
  await page.getByLabel('開始日').fill(date);
  await page.getByLabel('終了日').fill(date);
  await page.getByLabel('レース名・馬名').fill(horse.name);
  await page.getByRole('button', { name: '検索', exact: true }).click();
  await page.getByLabel('公開状態').selectOption('PUBLISHED');
  await page.getByLabel('結果状態').selectOption('CONFIRMED');

  const row = page.locator('.race-archive-row').filter({ hasText: race.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText(date);
  await expect(row).toContainText('有料予想公開');
  await expect(row).toContainText('結果確定');
  await expect(row).not.toContainText(`非公開本文${suffix}`);
  await expect(row).not.toContainText(`非公開評価${suffix}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
