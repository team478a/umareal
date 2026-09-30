import { expect, test } from '@playwright/test';
import { PrismaClient } from '../../packages/db/src';
import { account, Client } from '../helpers';

const db = new PrismaClient();
test.beforeAll(() => {
  const richMenuTransport = process.env.LINE_RICH_MENU_TRANSPORT ?? process.env.NOTIFICATION_TRANSPORT;
  if (richMenuTransport !== 'test') throw new Error('LINE rich menu E2E is limited to the test transport');
});
test.afterAll(() => db.$disconnect());

test('administrator previews and safely publishes the LINE rich menu', async ({ page }) => {
  const fixture = await account('ADMIN');
  const client = new Client(); await client.login(fixture); await client.mfa();
  await page.context().addCookies([{ name: 'keiba_session', value: client.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/admin/line-rich-menu');

  await expect(page.getByRole('heading', { name: 'LINEリッチメニュー', exact: true })).toBeVisible();
  const preview = page.getByRole('img', { name: '6つのボタンを配置したLINEリッチメニューのプレビュー' });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 2500 && image.naturalHeight === 1686)).toBe(true);
  for (const label of ['登録特典', 'WIN5紙面', 'レース一覧', 'お知らせ', '料金プラン', 'マイページ']) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();

  const reason = `E2E ${test.info().project.name} でプレビュー確認`;
  await page.getByLabel('公開理由').fill(reason);
  await page.getByLabel('上の画像と6つの移動先を確認しました').check();
  await page.getByRole('button', { name: '模擬公開する' }).click();
  await expect(page.getByRole('status')).toContainText('模擬公開が完了しました');
  await expect(page.locator('.rich-menu-history')).toContainText(reason);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
