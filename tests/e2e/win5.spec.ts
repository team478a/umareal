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

async function createWin5RaceOptions(targetDate: string, expertId: string) {
  const races = [];
  for (let legNumber = 1; legNumber <= 5; legNumber++) {
    const race = await db.race.create({
      data: {
        raceDate: targetDate,
        venue: `公開試験${legNumber}`,
        number: legNumber + 5,
        name: `画面公開フロー${legNumber}`,
        startsAt: new Date(`${targetDate}T${String(legNumber + 5).padStart(2, '0')}:00:00Z`),
        assignments: { create: { userId: expertId } }
      }
    });
    const entries = [];
    for (let horseNumber = 1; horseNumber <= 2; horseNumber++) {
      entries.push(await db.raceEntry.create({
        data: {
          race: { connect: { id: race.id } },
          horse: { create: { id: randomUUID(), name: `公開試験馬${legNumber}-${horseNumber}` } },
          number: horseNumber,
          gate: horseNumber,
          horseName: `公開試験馬${legNumber}-${horseNumber}`,
          sex: 'MALE',
          age: 3,
          carriedWeight: 57,
          jockey: '画面試験騎手',
          trainer: '画面試験調教師'
        }
      }));
    }
    races.push({ race, entries });
  }
  return races;
}

test('creates, completes, previews and publishes a WIN5 paper from the responsive administration screen', async ({ page, context }) => {
  const admin = await assessmentFixture('ADMIN', 2);
  const expert = await account('EXPERT');
  const targetDate = await unusedWin5TargetDate(2200);
  const races = await createWin5RaceOptions(targetDate, expert.user.id);
  const title = `画面試験WIN5-${randomUUID().slice(0, 6)}`;
  const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { predictionPublicationEnabled: true } });
  await db.systemSetting.update({ where: { id: 'global' }, data: { predictionPublicationEnabled: true } });
  try {
    await context.addCookies([{ name: 'keiba_session', value: admin.token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
    await page.goto('/admin/win5');
    await expect(page.getByRole('heading', { name: 'WIN5予想管理', exact: true })).toBeVisible();
    await page.getByLabel('対象日', { exact: true }).fill(targetDate);
    await page.getByLabel('タイトル', { exact: true }).first().fill(title);
    await page.getByLabel('予想担当').first().selectOption(expert.user.id);
    await page.getByLabel('公開予定', { exact: true }).first().fill(`${targetDate}T09:00`);
    await page.getByLabel('作成理由', { exact: true }).fill('開催日の画面公開フロー試験');
    await page.getByRole('button', { name: '予想枠を作成' }).click();
    await expect(page.getByRole('status')).toContainText('WIN5予想枠を作成しました。');
    await page.locator('button.race-row').filter({ hasText: title }).click();
    await expect(page.getByRole('heading', { name: title, exact: true, level: 2 })).toBeVisible();

    const details = page.locator('form.panel-body').filter({ has: page.getByLabel('全体総評', { exact: true }) });
    await details.getByLabel('全体総評', { exact: true }).fill('5レースの中心馬と相手候補を確認した公開試験の総評');
    await details.getByLabel('変更理由', { exact: true }).fill('公開前に全体総評を確定');
    await details.getByRole('button', { name: '基本情報を保存' }).click();
    await expect(page.getByRole('status')).toContainText('基本情報を保存しました。');

    for (let legNumber = 1; legNumber <= 5; legNumber++) {
      const leg = page.getByRole('heading', { name: `第${legNumber}対象レース`, exact: true }).locator('..');
      await expect(leg).toHaveClass(/import-preview/);
      await leg.locator('select').first().selectOption(races[legNumber - 1].race.id);
      await expect(leg.getByText(`公開試験馬${legNumber}-1`)).toBeVisible();
      await leg.getByLabel('1番の評価区分', { exact: true }).selectOption('PRIMARY');
      await leg.getByLabel('1番の選定理由', { exact: true }).fill('中心馬として展開と状態を評価');
      await leg.getByLabel('2番の評価区分', { exact: true }).selectOption('SECONDARY');
      await leg.getByLabel('2番の選定理由', { exact: true }).fill('相手候補として適性を評価');
      await leg.getByLabel('展開見解', { exact: true }).fill(`第${legNumber}レースの展開見解`);
      await leg.getByLabel('レース短評', { exact: true }).fill(`第${legNumber}レースの短評`);
      await leg.getByLabel('保存理由', { exact: true }).fill(`第${legNumber}レースの入力を確認`);
      await leg.getByRole('button', { name: `第${legNumber}対象レースを保存` }).click();
      await expect(page.getByRole('status')).toContainText(`第${legNumber}対象レースを保存しました。`);
    }

    await expect(page.getByText('5/5', { exact: true })).toBeVisible();
    const publication = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '公開前確認', exact: true }) });
    await publication.getByRole('button', { name: '公開内容を確認' }).click();
    await expect(publication.getByRole('heading', { name: 'v1 公開確認', exact: true })).toBeVisible();
    await publication.getByRole('button', { name: 'WIN5予想を公開' }).click();
    await expect(page.getByRole('status')).toContainText('WIN5予想 v1 を公開しました。');
    await expect(page.getByRole('heading', { name: '公開履歴', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'v1', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const product = await db.predictionProduct.findUniqueOrThrow({ where: { type_targetDate: { type: 'WIN5_PREVIEW', targetDate } }, include: { versions: true, races: { include: { selections: true } } } });
    expect(product.status).toBe('PUBLISHED');
    expect(product.versions).toHaveLength(1);
    expect(product.races).toHaveLength(5);
    expect(product.races.every(race => race.selections.length === 2)).toBe(true);
  } finally {
    await db.systemSetting.update({ where: { id: 'global' }, data: settings });
  }
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
