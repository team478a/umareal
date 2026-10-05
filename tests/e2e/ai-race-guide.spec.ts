import { expect, test } from '@playwright/test';
import { assessmentFixture } from '../assessment-fixtures';
import { db } from '../helpers';

test.afterAll(() => db.$disconnect());
test.skip(process.env.AI_RACE_GUIDE_ENABLED !== 'true', 'AIレースガイドのCI feature flagsが必要です');

test('admin publishes a synthetic guide and paddock remains first on desktop and mobile', async ({ page, context }, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await assessmentFixture('ADMIN');
  await context.addCookies([{ name: 'keiba_session', value: fixture.token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto('/admin/ai-race-guides');
  await page.getByLabel('対象レース').selectOption(fixture.race.id);
  await page.getByRole('button', { name: 'synthetic fixtureで生成' }).click();
  await expect(page.getByText('生成・検証が完了しました。')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('VALID', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '確認済みにする' }).click();
  await expect(page.getByText('確認済みにしました。')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '公開版を追加' }).click();
  await expect(page.getByText('新しい公開版を保存しました。')).toBeVisible({ timeout: 15_000 });
  expect(await db.aiRaceGuideVersion.count({ where: { guide: { raceId: fixture.race.id } } })).toBe(1);

  await page.goto(`/races/${fixture.race.id}`);
  const paddock = page.getByRole('heading', { name: '最終評価は未公開です' });
  const guide = page.getByRole('heading', { name: 'AIレースガイド' });
  await expect(paddock).toBeVisible(); await expect(guide).toBeVisible();
  expect(await paddock.evaluate((node, other) => Boolean(node.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await guide.elementHandle())).toBe(true);
  await expect(page.getByText('AIによる参考情報')).toBeVisible();
  await expect(page.getByText('馬券の買い目を示すものではありません。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`ai-race-guide-${testInfo.project.name}.png`), fullPage: true });
});
