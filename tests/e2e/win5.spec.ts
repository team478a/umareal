import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { assessmentFixture } from '../assessment-fixtures';
import { account, db } from '../helpers';

test.afterAll(() => db.$disconnect());

test('creates a WIN5 product from the responsive administration screen', async ({ page, context }) => {
  const admin = await assessmentFixture('ADMIN', 2);
  const expert = await account('EXPERT');
  const targetDate = new Date(Date.UTC(2090, 0, 1) + (parseInt(randomUUID().slice(0, 6), 16) % 3650) * 86400000).toISOString().slice(0, 10);
  const title = `画面試験WIN5-${randomUUID().slice(0, 6)}`;
  await context.addCookies([{ name: 'keiba_session', value: admin.token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/admin/win5');
  await expect(page.getByRole('heading', { name: 'WIN5予想管理', exact: true })).toBeVisible();
  await page.getByLabel('対象日').fill(targetDate);
  await page.getByLabel('タイトル', { exact: true }).first().fill(title);
  await page.getByLabel('担当専門家').first().selectOption(expert.user.id);
  await page.getByLabel('公開予定').first().fill(`${targetDate}T09:00`);
  await page.getByLabel('作成理由').fill('スマートフォン入力画面の試験');
  await page.getByRole('button', { name: '予想枠を作成' }).click();
  await expect(page.getByRole('status')).toContainText('WIN5予想枠を作成しました。');
  await expect(page.getByRole('heading', { name: title, exact: true, level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: '対象5レース', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '公開前確認', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
