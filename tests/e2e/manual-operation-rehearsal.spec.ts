import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { account, Client, db } from '../helpers';

type Phase = { ms: number; actions: number; editedFields: number };

test.afterAll(() => db.$disconnect());

async function session(role: 'ADMIN' | 'EXPERT' | 'MEMBER') {
  const fixture = await account(role);
  const client = new Client();
  await client.login(fixture);
  if (role !== 'MEMBER') await client.mfa();
  return { fixture, client };
}

async function useSession(context: BrowserContext, client: Client) {
  await context.clearCookies();
  await context.addCookies([{ name: 'keiba_session', value: client.cookie.split('=')[1], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
}

async function timed<T>(phases: Record<string, Phase>, name: string, actions: number, editedFields: number, run: () => Promise<T>) {
  const start = Date.now();
  const value = await run();
  phases[name] = { ms: Date.now() - start, actions, editedFields };
  return value;
}

async function paddockHorse(page: Page, number: number, comment: string) {
  await page.getByRole('button', { name: '6項目を4に設定', exact: true }).click();
  await page.getByRole('button', { name: number % 2 ? 'UP' : '据え置き', exact: true }).click();
  await page.getByLabel('パドック短評').fill(comment);
  await expect(page.getByRole('status')).toHaveText('保存済み', { timeout: 10_000 });
}

test('JRA-VAN未接続で1開催日の主要運用を管理画面から完走する', async ({ page, context }, testInfo) => {
  test.setTimeout(240_000);
  if (process.env.AUTH_PROVIDER !== 'local' || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Local database required');
  const raceDataMode = process.env.RACE_DATA_MODE ?? 'MANUAL';
  const guideTransport = process.env.AI_RACE_GUIDE_TRANSPORT ?? 'disabled';
  expect(raceDataMode).toBe('MANUAL');
  expect(['template', 'test']).toContain(guideTransport);
  const templateGuide = guideTransport === 'template';

  const rehearsalStartedAt = new Date();
  const phases: Record<string, Phase> = {};
  const admin = await session('ADMIN');
  const expert = await session('EXPERT');
  const member = await session('MEMBER');
  await db.entitlement.create({ data: { userId: member.fixture.user.id, planCode: 'STANDARD', startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 86_400_000), reason: '手動運用リハーサル会員閲覧', grantedBy: admin.fixture.user.id } });
  await useSession(context, admin.client);

  const suffix = randomUUID().slice(0, 8);
  expert.fixture.user = await db.user.update({ where: { id: expert.fixture.user.id }, data: { displayName: `リハーサル担当-${suffix}` } });
  const rehearsalVenues = ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'];
  const rehearsalDays = Array.from({ length: 31 }, (_, index) => `9999-12-${String(31 - index).padStart(2, '0')}`);
  let slot: { day: string; venue: string } | undefined;
  for (const candidateDay of rehearsalDays) {
    const usedVenues = new Set((await db.raceDay.findMany({ where: { raceDate: candidateDay }, select: { venue: true } })).map(item => item.venue));
    const candidateVenue = rehearsalVenues.find(item => !usedVenues.has(item));
    if (candidateVenue) {
      slot = { day: candidateDay, venue: candidateVenue };
      break;
    }
  }
  if (!slot) throw new Error('No free rehearsal slot is available for the isolated future dates');
  const { day, venue } = slot;
  const raceName = `未接続運用リハーサル-${suffix}`;
  const horseNames = Array.from({ length: 6 }, (_, index) => `手動運用馬${index + 1}-${suffix}`);

  await page.goto('/admin/races');
  await expect(page.getByRole('heading', { name: 'レース管理', exact: true })).toBeVisible();
  await expect(page.getByText('手動運用', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('外部データ連携は使用していません。', { exact: false })).toBeVisible();
  await expect(page.getByText('正常', { exact: true })).toBeVisible();

  await timed(phases, '開催日登録', 4, 3, async () => {
    const dayForm = page.locator('form').filter({ has: page.getByRole('button', { name: '開催日を登録' }) });
    await dayForm.getByLabel('開催日', { exact: true }).fill(day);
    await dayForm.getByLabel('競馬場', { exact: true }).selectOption(venue);
    await dayForm.getByLabel('開催日の登録理由').fill('JRA-VAN未接続の実運用リハーサル');
    await dayForm.getByRole('button', { name: '開催日を登録' }).click();
    await expect(page.getByRole('status')).toContainText('開催日を登録しました。');
  });

  await timed(phases, 'レース登録', 8, 14, async () => {
    await page.getByRole('button', { name: 'レースを追加' }).click();
    const raceForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'レースを保存' }) });
    await raceForm.getByLabel('競馬場', { exact: true }).selectOption(venue);
    await raceForm.getByLabel('レース名', { exact: true }).fill(raceName);
    await raceForm.getByLabel('クラス', { exact: true }).fill('3歳以上1勝クラス');
    await raceForm.getByLabel('距離（m）', { exact: true }).fill('1600');
    await raceForm.getByLabel('予想担当者名', { exact: true }).fill(expert.fixture.user.displayName);
    await raceForm.getByRole('button', { name: '検索', exact: true }).click();
    await raceForm.getByLabel('予想担当', { exact: true }).selectOption(expert.fixture.user.id);
    await raceForm.getByLabel('レースの登録・変更理由', { exact: true }).fill('実運用リハーサル対象レース');
    await raceForm.getByRole('button', { name: 'レースを保存' }).click();
    await expect(page.getByRole('status')).toContainText('レース情報を保存しました。');
  });
  const race = await db.race.findFirstOrThrow({ where: { name: raceName } });

  await timed(phases, '出走馬6頭登録', 4, 2, async () => {
    await page.getByLabel('出走馬一括入力').fill(horseNames.map((horseName, index) => `${index + 1},${horseName}`).join('\n'));
    await page.getByRole('button', { name: '登録内容を確認' }).click();
    await expect(page.getByRole('heading', { name: '一括登録前の確認', exact: true })).toBeVisible();
    await page.getByLabel('出走馬一括登録の理由').fill('出馬表を確認して一括簡易登録');
    await page.getByRole('button', { name: '確認した6頭を一括登録' }).click();
    await expect(page.getByRole('status')).toContainText('6頭をまとめて登録しました。');
    for (const horseName of horseNames) await expect(page.getByRole('cell', { name: horseName, exact: true })).toBeVisible();
  });
  expect(await db.raceEntry.count({ where: { raceId: race.id } })).toBe(6);
  expect(await db.horseExternalIdentity.count({ where: { observedName: { in: horseNames }, provider: 'MANUAL', matchStatus: 'UNRESOLVED' } })).toBe(6);

  await timed(phases, '暫定Horse Identity確認', 5, 1, async () => {
    const identityPanel = page.locator('section.panel').filter({ has: page.getByRole('heading', { name: '暫定馬の確認', exact: true }) });
    await identityPanel.getByLabel('暫定馬を絞り込むレース').selectOption(race.id);
    await identityPanel.getByRole('button', { name: '候補なしをすべて選択' }).click();
    await identityPanel.getByLabel('暫定馬の共通確認理由').fill('同名候補なしを確認');
    await identityPanel.getByRole('button', { name: '選択内容を確認（6頭）' }).click();
    await expect(identityPanel.getByRole('heading', { name: '別馬として一括確定する内容', exact: true })).toBeVisible();
    const batchPreview = identityPanel.locator('.preview-card');
    for (const horseName of horseNames) await expect(batchPreview.getByText(new RegExp(horseName))).toBeVisible();
    await identityPanel.getByRole('button', { name: '確認した6頭を別馬として一括確定' }).click();
    await expect(identityPanel.getByRole('status')).toContainText('6頭を別の馬として一括確定しました。');
  });
  expect(await db.horseExternalIdentity.count({ where: { observedName: { in: horseNames }, provider: 'MANUAL', matchStatus: 'MATCHED' } })).toBe(6);

  await useSession(context, expert.client);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/expert');
  const target = page.locator('.race-row').filter({ hasText: raceName });
  await target.getByRole('button', { name: '評価・予想を入力' }).click();
  await expect(page.getByRole('heading', { name: raceName, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await timed(phases, 'スマホ・パドック6頭入力', 25, 49, async () => {
    for (let number = 1; number <= 6; number++) {
      await paddockHorse(page, number, `${number}番は登録済み所見のみを記録`);
      if (number < 6) await page.getByRole('button', { name: '次の馬' }).click();
    }
    await page.getByRole('button', { name: '入力状況を確認' }).click();
    await expect(page.getByRole('heading', { name: '全頭の入力状況' })).toBeVisible();
    await expect(page.getByText(/パドック 入力済み/)).toHaveCount(6);
  });

  const predictionBefore = await timed(phases, '予想下書き・公開', 18, 15, async () => {
    await page.getByRole('button', { name: '最終評価・公開へ' }).click();
    await page.getByLabel('公開範囲', { exact: true }).selectOption('PAID');
    await page.getByLabel('信頼度', { exact: true }).selectOption('A');
    await page.getByLabel('最終見解', { exact: true }).fill('登録済みのパドック所見を基にした最終評価です。');
    const marks = ['HONMEI', 'TAIKO', 'TANANA', 'RENKA', 'ANA', 'DANGER'];
    for (let number = 1; number <= 6; number++) {
      await page.getByLabel(`${number}番の最終評価`, { exact: true }).selectOption(marks[number - 1]);
      await page.getByLabel(`${number}番の選定理由`, { exact: true }).fill(`${number}番のパドック確認結果`);
    }
    await page.getByLabel('下書きの変更理由').fill('実運用リハーサルの下書き');
    await page.getByRole('button', { name: '下書きを保存' }).click();
    await expect(page.getByText('下書きを保存しました。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '公開前に確認' }).click();
    await expect(page.getByRole('heading', { name: '初版 1の公開前確認' })).toBeVisible();
    await page.getByRole('button', { name: '最終評価を公開する' }).click();
    await expect(page.getByText('公開版1を保存しました。', { exact: true })).toBeVisible();
    return db.predictionVersion.findFirstOrThrow({ where: { prediction: { raceId: race.id }, version: 1 } });
  });
  const immutableHash = createHash('sha256').update(JSON.stringify({ summary: predictionBefore.summary, content: predictionBefore.contentSnapshot, assessments: predictionBefore.assessmentSnapshot })).digest('hex');
  await page.screenshot({ path: testInfo.outputPath('mobile-paddock-published.png'), fullPage: true });

  await timed(phases, '有料会員画面閲覧', 2, 0, async () => {
    await useSession(context, member.client);
    await page.goto(`/races/${race.id}`);
    await expect(page.getByRole('heading', { name: '最終評価 · 版1' })).toBeVisible();
    await expect(page.getByText('登録済みのパドック所見を基にした最終評価です。', { exact: true })).toBeVisible();
  });

  await timed(phases, 'Basic Guide生成・確認・公開', 6, 1, async () => {
    await useSession(context, admin.client);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/admin/ai-race-guides');
    await page.getByLabel('AIガイドの開催日').fill(race.raceDate);
    await page.getByLabel('AIガイドのレース名').fill(race.name);
    await page.getByRole('button', { name: 'レースを検索' }).click();
    await page.getByLabel('対象レース').selectOption(race.id);
    await expect(page.getByText(`transport ${guideTransport}`, { exact: true })).toBeVisible();
    await page.getByLabel('操作理由').fill('未接続運用Basic Guide確認');
    await page.getByRole('button', { name: templateGuide ? 'Basic Guideを生成' : 'synthetic fixtureで生成' }).click();
    await expect(page.getByRole('status')).toContainText('生成・検証が完了しました。');
    await expect(page.getByText(templateGuide ? '固定テンプレートによる参考情報' : 'AIによる参考情報', { exact: true })).toBeVisible();
    await expect(page.locator('.ai-guide-sections')).toContainText(templateGuide ? '詳細が未登録です。データ不足を成績不振とは扱いません。' : '判断に必要なデータ件数が不足しています。');
    await page.getByRole('button', { name: '確認済みにする' }).click();
    await expect(page.getByRole('status')).toContainText('確認済みにしました。');
    await page.getByRole('button', { name: '公開版を追加' }).click();
    await expect(page.getByRole('status')).toContainText('新しい公開版を保存しました。');
  });

  await useSession(context, member.client);
  await page.goto(`/races/${race.id}`);
  await expect(page.getByRole('heading', { name: 'AIレースガイド' })).toBeVisible();
  await expect(page.getByText(templateGuide ? 'Basic Guide（固定テンプレート）' : 'AIによる参考情報', { exact: true })).toBeVisible();
  const guideText = await page.locator('.ai-race-guide').innerText();
  if (templateGuide) expect(guideText).toContain('登録済み情報だけ');
  expect(guideText).not.toMatch(/勝率|的中率|おすすめ馬券|買い目[:：]|絶好調|勝ち負け必至/);

  // The operator cannot wait for a real future race during an automated rehearsal. This is the
  // sole non-UI state transition: advance the test clock by moving the local fixture start time.
  await db.race.update({ where: { id: race.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
  await timed(phases, '結果下書き・確定', 6, 2, async () => {
    await useSession(context, admin.client);
    await page.goto('/admin/results');
    await page.getByRole('button').filter({ hasText: raceName }).click();
    await page.getByLabel('結果一括入力').fill(horseNames.map((_, index) => `${index + 1},${index + 1},${index + 1},${index + 2}`).join('\n'));
    const resultDraftKey = `keiba:result-manager:${admin.fixture.user.id}:quick-result:${race.id}`;
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), resultDraftKey)).not.toBeNull();
    await page.getByRole('button', { name: '入力内容を確認' }).click();
    await expect(page.getByRole('heading', { name: '下書き反映前の確認', exact: true }).first()).toBeVisible();
    await page.getByLabel('結果一括入力の理由').fill('公式結果を目視確認して一括入力');
    await page.getByRole('button', { name: '確認した結果を下書きへ反映' }).click();
    await expect(page.getByRole('status')).toContainText('結果を下書き版1へ反映しました。');
    expect(await page.evaluate(key => sessionStorage.getItem(key), resultDraftKey)).toBeNull();
    for (let number = 1; number <= 6; number++) await expect(page.getByLabel(`${number}番の着順`)).toHaveValue(String(number));
    await page.getByRole('button', { name: '結果を確定' }).click();
    await expect(page.getByRole('status')).toContainText('確定結果版1と公開版別の馬評価結果を保存しました。');
    await expect(page.getByText(/版1/).last()).toBeVisible();
  });
  expect(await db.predictionEvaluation.count({ where: { raceId: race.id } })).toBe(1);
  const predictionAfter = await db.predictionVersion.findUniqueOrThrow({ where: { id: predictionBefore.id } });
  expect(createHash('sha256').update(JSON.stringify({ summary: predictionAfter.summary, content: predictionAfter.contentSnapshot, assessments: predictionAfter.assessmentSnapshot })).digest('hex')).toBe(immutableHash);

  await timed(phases, '会員結果・公開版不変確認', 2, 0, async () => {
    await useSession(context, member.client);
    await page.goto(`/races/${race.id}`);
    await expect(page.getByRole('heading', { name: '最終評価 · 版1' })).toBeVisible();
    await expect(page.getByText('登録済みのパドック所見を基にした最終評価です。', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '確定結果', exact: true })).toBeVisible();
  });

  await timed(phases, 'Audit Log確認', 7, 3, async () => {
    await useSession(context, admin.client);
    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { name: '操作履歴', exact: true })).toBeVisible();
    for (const action of ['RACE_RESULT_CONFIRM', 'AI_GUIDE_PUBLISH', 'PREDICTION_PUBLISH']) {
      await page.getByLabel('操作', { exact: true }).fill(action);
      await page.getByRole('button', { name: '絞り込む' }).click();
      await expect(page.getByRole('row').filter({ hasText: action }).first()).toBeVisible();
    }
  });
  const requiredAudits = ['RACE_CREATE', 'MANUAL_ENTRY_BATCH_CREATE', 'ASSESSMENT_SAVE', 'PREDICTION_DRAFT_SAVE', 'PREDICTION_PUBLISH', 'AI_GUIDE_GENERATION_REQUEST', 'AI_GUIDE_APPROVE', 'AI_GUIDE_PUBLISH', 'RACE_RESULT_DRAFT_SAVE', 'RACE_RESULT_CONFIRM'];
  const auditActions = await db.auditLog.findMany({ where: { createdAt: { gte: rehearsalStartedAt }, action: { in: requiredAudits } }, select: { action: true } });
  for (const action of requiredAudits) expect(auditActions.map(item => item.action)).toContain(action);

  console.log(`MANUAL_OPERATION_REHEARSAL_METRICS=${JSON.stringify({ commit: process.env.GIT_COMMIT ?? 'local', raceId: race.id, phases, totalMs: Object.values(phases).reduce((sum, phase) => sum + phase.ms, 0), totalActions: Object.values(phases).reduce((sum, phase) => sum + phase.actions, 0), editedFields: Object.values(phases).reduce((sum, phase) => sum + phase.editedFields, 0) })}`);
});
