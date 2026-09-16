import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { assessmentFixture } from '../assessment-fixtures';
import { account, db } from '../helpers';

test.afterAll(() => db.$disconnect());

async function unusedWin5TargetDate(startYear: number) {
  let day = Math.floor(Date.UTC(startYear, 0, 1) / 86400000) + (parseInt(randomUUID().slice(0, 8), 16) % 30000);
  while (true) {
    const targetDate = new Date(day * 86400000).toISOString().slice(0, 10);
    const existing = await db.predictionProduct.findUnique({ where: { type_targetDate: { type: 'WIN5_PREVIEW', targetDate } }, select: { id: true } });
    if (!existing) return targetDate;
    day += 1;
  }
}

test('creates a WIN5 product from the responsive administration screen', async ({ page, context }) => {
  const admin = await assessmentFixture('ADMIN', 2);
  const expert = await account('EXPERT');
  const targetDate = await unusedWin5TargetDate(2200);
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

test('shows the paid WIN5 paper and version history on the member screen', async ({ page, context }) => {
  const member = await assessmentFixture('MEMBER', 1);
  const expert = await account('EXPERT');
  const targetDate = await unusedWin5TargetDate(2400);
  const races = [];
  for (let legNumber = 1; legNumber <= 5; legNumber++) races.push(await db.race.create({ data: { raceDate: targetDate, venue: `紙面${legNumber}`, number: legNumber + 5, name: `会員紙面試験${legNumber}`, startsAt: new Date(`${targetDate}T${String(legNumber + 5).padStart(2, '0')}:00:00Z`) } }));
  const product = await db.predictionProduct.create({ data: { targetDate, title: `会員向けWIN5-${randomUUID().slice(0, 6)}`, expertId: expert.user.id, status: 'PUBLISHED', scheduledPublishAt: new Date(`${targetDate}T00:00:00Z`), publishedAt: new Date(), confidence: 'A', summary: '会員画面に表示する全体総評', showFreeConfidence: true, updatedBy: expert.user.id, races: { create: races.map((race, index) => ({ raceId: race.id, legNumber: index + 1, confidence: 'A', paceView: `第${index + 1}レースの展開見解`, shortComment: `第${index + 1}レースの短評` })) } } });
  const contentSnapshot = { product: { expertName: expert.user.displayName, confidence: 'A', summary: '会員画面に表示する全体総評' }, races: races.map((race, index) => ({ legNumber: index + 1, confidence: 'A', paceView: `第${index + 1}レースの展開見解`, shortComment: `第${index + 1}レースの短評`, race: { id: race.id, raceDate: targetDate, venue: race.venue, number: race.number, name: race.name, startsAt: race.startsAt.toISOString(), status: race.status }, evaluations: [{ entryId: randomUUID(), horseId: randomUUID(), number: index + 1, horseName: `紙面中心馬${index + 1}`, status: 'ACTIVE', evaluationType: 'PRIMARY', reason: '展開とコース適性を評価', displayOrder: 1 }] })) };
  await db.$transaction(async tx => {
    const version = await tx.predictionProductVersion.create({ data: { productId: product.id, version: 1, status: 'PUBLISHED', accessScope: 'PAID', confidence: 'A', combinationCount: null, amountPerPointYen: null, assumedPurchaseAmountYen: null, formatVersion: 'HORSE_EVALUATION_V1', contentSnapshot, publisherId: expert.user.id, deadlineAt: races[0].startsAt } });
    await tx.notificationEvent.create({ data: { productVersionId: version.id, eventType: 'WIN5_PREVIEW_PUBLISHED', status: 'QUEUED', payload: { productVersionId: version.id, productId: product.id, targetDate } } });
  });
  await db.entitlement.create({ data: { userId: member.owner.user.id, planCode: 'STANDARD', startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 3600000), reason: '会員紙面E2E', grantedBy: member.owner.user.id } });
  await context.addCookies([{ name: 'keiba_session', value: member.token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  await page.goto(`/win5/${product.id}`);
  await expect(page.getByRole('heading', { name: product.title, exact: true })).toBeVisible();
  await expect(page.getByText('紙面中心馬1')).toBeVisible();
  await expect(page.getByText('展開とコース適性を評価').first()).toBeVisible();
  await expect(page.getByText('想定購入総額')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '公開履歴', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('/notifications');
  const notice = page.locator('article').filter({ hasText: 'WIN5紙面予想を公開しました' });
  await expect(notice).toContainText(product.title);
  await notice.getByRole('button', { name: '詳細を見る' }).click();
  await expect(page).toHaveURL(new RegExp(`/win5/${product.id}$`));
  await expect(page.getByRole('heading', { name: product.title, exact: true })).toBeVisible();
});
