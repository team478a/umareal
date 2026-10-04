import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { account, db } from '../helpers';

test.afterAll(() => db.$disconnect());

test('an editor publishes an article and the public library shows it on desktop/mobile', async ({ page }) => {
  if (process.env.AUTH_PROVIDER !== 'local' || !['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Content browser test requires local development database');
  const editor = await account('EDITOR');
  const suffix = randomUUID().slice(0, 8);
  const title = `秋競馬の見どころ ${suffix}`;

  await page.goto('/login');
  await page.getByLabel('メールアドレス', { exact: true }).fill(editor.user.email!);
  await page.getByLabel('パスワード', { exact: true }).fill(editor.password);
  await page.getByRole('button', { name: 'ログイン', exact: true }).click();
  await expect(page.getByRole('heading', { name: '編集担当用の管理画面', exact: true })).toBeVisible();

  await page.goto('/admin/content');
  await expect(page.getByRole('heading', { name: '記事・動画・音声', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新規作成', exact: true }).click();
  await page.getByLabel('タイトル', { exact: true }).fill(title);
  await page.getByLabel('概要', { exact: true }).fill('今週の開催で注目したいポイントを紹介します。');
  await page.getByLabel('本文', { exact: true }).fill('馬場傾向と当日の確認ポイントを、初心者にもわかりやすく解説します。');
  await page.getByLabel('カテゴリ', { exact: true }).fill('読みもの');
  await page.getByLabel('タグ（カンマ区切り・10件まで）', { exact: true }).fill('秋競馬, 初心者');
  await page.getByLabel('操作理由', { exact: true }).fill('公開画面のE2E確認');
  await page.getByRole('button', { name: '下書きを保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('下書きを作成しました');

  await page.getByLabel('操作理由', { exact: true }).fill('公開画面のE2E確認');
  await page.getByRole('button', { name: '今すぐ公開', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('新しい公開版を公開しました');
  await expect(page.getByText('公開中', { exact: true })).toBeVisible();

  await page.context().clearCookies();
  await page.goto('/content');
  const card = page.locator('.content-card').filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole('link', { name: '読む', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText('馬場傾向と当日の確認ポイントを、初心者にもわかりやすく解説します。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
