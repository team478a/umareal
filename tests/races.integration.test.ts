import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';
import { entryHeaders, expertRaceListResponseSchema, raceExpertListResponseSchema, raceHeaders } from '../packages/domain/src/races';
const admin = new Client(); let expert: Awaited<ReturnType<typeof account>>; let expertClient: Client;
let day = `2098-${String(Math.floor(Math.random() * 12) + 1).padStart(2, '0')}-${String(Math.floor(Math.random() * 28) + 1).padStart(2, '0')}`;
const raceInput = (number: number) => ({ raceDate: day, venue: '東京', number, name: `CSV試験-${randomUUID().slice(0, 6)}`, raceClass: '未勝利', distance: 1600, surface: 'TURF', direction: 'LEFT', startsAt: `${day}T10:00:00+09:00`, going: 'GOOD', weather: '晴', status: 'SCHEDULED', expertId: expert.user.id });
const entryInput = (number: number) => ({ horseId: randomUUID(), number, gate: 1, horseName: `試験馬${number}`, sex: 'MALE', age: 3, carriedWeight: 57, jockey: '試験騎手', trainer: '試験調教師', winOdds: null, popularity: null, status: 'ACTIVE' });
const headers = () => ({ 'Idempotency-Key': randomUUID() });
function csv(kind: 'races' | 'entries', rows: Record<string, unknown>[]) {
  const fields = kind === 'races' ? raceHeaders : entryHeaders;
  return [fields.join(','), ...rows.map(row => fields.map(field => String(row[field] ?? '')).join(','))].join('\n');
}
function bundlePayload(race: Record<string, unknown>, entries: Record<string, unknown>[]) {
  const racesCsv = csv('races', [race]), entryCsv = csv('entries', entries);
  const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
  const path = `entries/${race.raceDate}-05-${String(race.number).padStart(2, '0')}R.csv`;
  return {
    manifest: JSON.stringify({
      formatVersion: 'UMAREAL_JRA_VAN_BUNDLE_V1', targetDate: race.raceDate, raceCount: 1, entryRaceCount: 1, entryCount: entries.length,
      finalizedRaceCount: 0, resultsIncluded: false,
      source: { raRecordCount: 1, raSha256: 'a'.repeat(64), seRecordCount: entries.length, seSha256: 'b'.repeat(64) },
      files: [{ kind: 'RACES', path: 'races.csv', rowCount: 1, sha256: checksum(racesCsv) }, { kind: 'ENTRIES', path, rowCount: entries.length, sha256: checksum(entryCsv) }]
    }),
    racesCsv, entries: [{ path, csv: entryCsv }]
  };
}
async function preview(kind: 'races' | 'entries', rows: Record<string, unknown>[], raceId?: string) {
  return admin.call('admin/races/import/preview', 'POST', { kind, csv: csv(kind, rows), ...(raceId ? { raceId } : {}) });
}
beforeAll(async () => {
  if (process.env.AUTH_PROVIDER !== 'local' || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Local test database required');
  while (await db.race.count({ where: { raceDate: day, venue: '東京' } })) day = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
  await admin.login(await account('ADMIN')); await admin.mfa();
  expert = await account('EXPERT'); expertClient = new Client(); await expertClient.login(expert); await expertClient.mfa();
});
afterAll(() => db.$disconnect());
describe('race management and transactional CSV imports', () => {
  let raceId: string;
  it('creates a day/race idempotently, assigns expert and refuses expert writes', async () => {
    const expertSearch = await admin.call(`admin/race-experts?limit=50&search=${encodeURIComponent(expert.user.displayName)}`);
    expect(expertSearch.status).toBe(200);
    const expertSearchBody = raceExpertListResponseSchema.parse(expertSearch.body);
    expect(expertSearchBody.search).toBe(expert.user.displayName);
    expect(expertSearchBody.items).toContainEqual({ id: expert.user.id, displayName: expert.user.displayName });
    const operatorAccount = await account('OPERATOR');
    const operatorSearch = await admin.call(`admin/race-experts?limit=50&search=${encodeURIComponent(operatorAccount.user.displayName)}`);
    expect(operatorSearch.status).toBe(200);
    expect(raceExpertListResponseSchema.parse(operatorSearch.body).items).toContainEqual({ id: operatorAccount.user.id, displayName: operatorAccount.user.displayName });
    const dayResponse = await admin.call('admin/race-days', 'POST', { day: { raceDate: day, venue: '東京' }, reason: '開催日試験' }, undefined, headers());
    expect([201, 409]).toContain(dayResponse.status);
    const body = { race: raceInput(1), reason: 'レース作成試験' }; const key = headers();
    const result = await admin.call('admin/races', 'POST', body, undefined, key);
    expect(result.status).toBe(201); raceId = result.body.id;
    expect((await admin.call('admin/races', 'POST', body, undefined, key)).body.id).toBe(raceId);
    expect((await admin.call('admin/races', 'POST', body, undefined, headers())).status).toBe(409);
    const assigned = await expertClient.call('expert/races');
    expect(expertRaceListResponseSchema.parse(assigned.body)).toEqual(assigned.body);
    expect(assigned.body.items.map((r: { id: string }) => r.id)).toContain(raceId);
    const assignedRace = assigned.body.items.find((race: { id: string }) => race.id === raceId);
    expect(Object.keys(assignedRace).sort()).toEqual(['id', 'name', 'number', 'raceDate', 'startsAt', 'status', 'venue']);
    expect(JSON.stringify(assigned.body)).not.toMatch(/assignments|raceDayId|revision|expertId|updatedBy|passwordHash|authSubject|token|secret/i);
    const operator = new Client(); await operator.login(await account('OPERATOR'));
    expect(await operator.call('expert/races')).toMatchObject({ status: 403, body: { code: 'MFA_REQUIRED' } });
    await operator.mfa();
    const operatorRaces = await operator.call('expert/races');
    expect(operatorRaces.status).toBe(200); expect(expertRaceListResponseSchema.parse(operatorRaces.body)).toEqual(operatorRaces.body);
    expect((await operator.call(`expert/races/${raceId}/workspace`)).status).toBe(200);
    expect((await expertClient.call('admin/races', 'POST', body, undefined, headers())).status).toBe(403);
    expect((await new Client().call('admin/races')).status).toBe(401);
    expect(result.body.raceDayId).toBeTruthy();
  });
  it('adds/edits entries without overwriting existing numbers and checks revisions', async () => {
    const body = { entry: entryInput(1), reason: '出走馬作成', revision: 1 };
    const added = await admin.call(`admin/races/${raceId}/entries`, 'POST', body, undefined, headers());
    expect(added.status).toBe(201);
    expect((await admin.call(`admin/races/${raceId}/entries`, 'POST', { ...body, revision: 2 }, undefined, headers())).status).toBe(409);
    expect((await admin.call(`admin/races/${raceId}/entries`, 'POST', { ...body, entry: entryInput(2) }, undefined, headers())).body.code).toBe('STALE_REVISION');
    const changed = await admin.call(`admin/races/${raceId}/entries`, 'POST', { ...body, entry: { ...body.entry, status: 'SCRATCHED' }, entryId: added.body.id, revision: 2 }, undefined, headers());
    expect(changed.status).toBe(201);
    expect((await db.raceEntry.findUniqueOrThrow({ where: { id: added.body.id } })).status).toBe('SCRATCHED');
    const audit = await db.auditLog.findMany({ where: { targetId: added.body.id, action: 'ENTRY_SAVE' } });
    expect(audit).toHaveLength(2);
  });
  it('treats no provider configuration as normal manual operation and creates provisional horses from number and name', async () => {
    const previousMode = process.env.RACE_DATA_MODE; delete process.env.RACE_DATA_MODE;
    const status = await admin.call('admin/race-data-status');
    if (previousMode === undefined) delete process.env.RACE_DATA_MODE; else process.env.RACE_DATA_MODE = previousMode;
    expect(status).toMatchObject({ status: 200, body: { mode: 'MANUAL', label: '手動運用', operationalStatus: 'NORMAL', externalIntegration: 'NOT_USED' } });

    const manualRaceResponse = await admin.call('admin/races', 'POST', { race: raceInput(2), reason: '手動運用試験レース' }, undefined, headers());
    expect(manualRaceResponse.status).toBe(201); const manualRaceId = manualRaceResponse.body.id as string; const sharedName = `同名候補-${randomUUID().slice(0, 8)}`;
    let race = await db.race.findUniqueOrThrow({ where: { id: manualRaceId } });
    const first = await admin.call(`admin/races/${manualRaceId}/entries/manual`, 'POST', { entry: { number: 16, horseName: sharedName }, revision: race.revision, reason: '初期運用の簡易登録' }, undefined, headers());
    expect(first.status).toBe(201); expect(first.body.identity).toMatchObject({ provider: 'MANUAL', status: 'UNRESOLVED', duplicateCandidateCount: 0 });
    const saved = await db.raceEntry.findUniqueOrThrow({ where: { id: first.body.entry.id } });
    expect(saved).toMatchObject({ number: 16, horseName: sharedName, gate: null, sex: null, age: null, carriedWeight: null, jockey: null, trainer: null });
    const identity = await db.horseExternalIdentity.findUniqueOrThrow({ where: { id: first.body.identity.id } });
    expect(identity).toMatchObject({ horseId: saved.horseId, provider: 'MANUAL', sourceVersion: 'MANUAL_OPERATION_V1', matchStatus: 'UNRESOLVED' });

    race = await db.race.findUniqueOrThrow({ where: { id: manualRaceId } });
    const duplicate = await admin.call(`admin/races/${manualRaceId}/entries/manual`, 'POST', { entry: { number: 17, horseName: sharedName }, revision: race.revision, reason: '同名でも自動統合しない確認' }, undefined, headers());
    expect(duplicate.status).toBe(201); expect(duplicate.body.identity).toMatchObject({ status: 'POSSIBLE_DUPLICATE', duplicateCandidateCount: 1 });
    expect(duplicate.body.entry.horseId).not.toBe(saved.horseId);
    expect(await db.auditLog.count({ where: { targetId: { in: [first.body.entry.id, duplicate.body.entry.id] }, action: 'MANUAL_ENTRY_CREATE' } })).toBe(2);

    const review = await admin.call(`admin/horse-identities/review?limit=50&date=${day}&raceId=${manualRaceId}`);
    expect(review.status).toBe(200);
    expect(review.body.items.find((item: { id: string }) => item.id === duplicate.body.identity.id)).toMatchObject({
      observedName: sharedName,
      provisionalHorse: { id: duplicate.body.entry.horseId, entryCount: 1 },
      candidates: expect.arrayContaining([expect.objectContaining({ id: saved.horseId, entryCount: 1 })]),
      races: [{ raceId: manualRaceId, raceDate: day, venue: '東京', number: 2, entryNumber: 17 }]
    });
    const otherDate = await admin.call('admin/horse-identities/review?limit=50&date=2097-01-01');
    expect(otherDate.status).toBe(200);
    expect(otherDate.body.items.some((item: { id: string }) => item.id === duplicate.body.identity.id)).toBe(false);
    const resolved = await admin.call(`admin/horse-identities/${duplicate.body.identity.id}/resolve`, 'POST', { decision: 'MATCH_EXISTING', resolvedHorseId: saved.horseId, reason: '同一馬であることを人が確認' }, undefined, headers());
    expect(resolved).toMatchObject({ status: 201, body: { matchStatus: 'MATCHED', horseId: saved.horseId } });
    expect(await db.horseExternalIdentity.findUniqueOrThrow({ where: { id: duplicate.body.identity.id } })).toMatchObject({ matchStatus: 'MATCHED', horseId: saved.horseId });
    expect((await db.raceEntry.findUniqueOrThrow({ where: { id: duplicate.body.entry.id } })).horseId).toBe(duplicate.body.entry.horseId);
    expect(await db.auditLog.count({ where: { targetId: duplicate.body.identity.id, action: 'HORSE_IDENTITY_RESOLVE' } })).toBe(1);

    const history = await admin.call('admin/horse-identities/history?limit=50');
    expect(history.status).toBe(200);
    const resolvedIdentity = history.body.items.find((item: { id: string }) => item.id === duplicate.body.identity.id);
    expect(resolvedIdentity).toMatchObject({ currentHorse: { id: saved.horseId }, history: [expect.objectContaining({ action: 'HORSE_IDENTITY_RESOLVE', reason: '同一馬であることを人が確認' })] });
    const currentIdentity = await db.horseExternalIdentity.findUniqueOrThrow({ where: { id: duplicate.body.identity.id } });
    const corrected = await admin.call(`admin/horse-identities/${duplicate.body.identity.id}/correct`, 'POST', {
      resolvedHorseId: duplicate.body.entry.horseId, expectedHorseId: saved.horseId, expectedUpdatedAt: currentIdentity.updatedAt.toISOString(), reason: '初回判断の誤りを人が訂正'
    }, undefined, headers());
    expect(corrected).toMatchObject({ status: 201, body: { matchStatus: 'MATCHED', horseId: duplicate.body.entry.horseId } });
    expect((await db.raceEntry.findUniqueOrThrow({ where: { id: duplicate.body.entry.id } })).horseId).toBe(duplicate.body.entry.horseId);
    expect(await db.auditLog.count({ where: { targetId: duplicate.body.identity.id, action: { in: ['HORSE_IDENTITY_RESOLVE', 'HORSE_IDENTITY_CORRECT'] } } })).toBe(2);
    expect((await admin.call(`admin/horse-identities/${duplicate.body.identity.id}/correct`, 'POST', {
      resolvedHorseId: saved.horseId, expectedHorseId: saved.horseId, expectedUpdatedAt: currentIdentity.updatedAt.toISOString(), reason: '古い画面からの訂正'
    }, undefined, headers())).body.code).toBe('STALE_HORSE_IDENTITY');
    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    const correctedIdentity = await db.horseExternalIdentity.findUniqueOrThrow({ where: { id: duplicate.body.identity.id } });
    expect((await operator.call(`admin/horse-identities/${duplicate.body.identity.id}/correct`, 'POST', {
      resolvedHorseId: saved.horseId, expectedHorseId: correctedIdentity.horseId, expectedUpdatedAt: correctedIdentity.updatedAt.toISOString(), reason: '権限外の訂正'
    }, undefined, headers())).status).toBe(403);

    const distinct = await admin.call(`admin/horse-identities/${first.body.identity.id}/resolve`, 'POST', { decision: 'CONFIRM_DISTINCT', resolvedHorseId: saved.horseId, reason: '別馬であることを人が確認' }, undefined, headers());
    expect(distinct).toMatchObject({ status: 201, body: { matchStatus: 'MATCHED', horseId: saved.horseId } });
    expect((await admin.call(`admin/horse-identities/${first.body.identity.id}/resolve`, 'POST', { decision: 'CONFIRM_DISTINCT', resolvedHorseId: saved.horseId, reason: '二重確認' }, undefined, headers())).body.code).toBe('HORSE_IDENTITY_ALREADY_RESOLVED');

    const raceHistory = await admin.call(`admin/races/${manualRaceId}/history?limit=50`);
    expect(raceHistory.status).toBe(200);
    expect(raceHistory.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'RACE_CREATE', sourceType: 'MANUAL', reason: '手動運用試験レース' }),
      expect.objectContaining({ action: 'MANUAL_ENTRY_CREATE', sourceType: 'MANUAL', reason: '初期運用の簡易登録' })
    ]));
  });
  it('creates a full 18-horse card atomically from a reviewed manual batch', async () => {
    const response = await admin.call('admin/races', 'POST', { race: raceInput(9), reason: '一括簡易登録試験レース' }, undefined, headers());
    expect(response.status).toBe(201); const batchRaceId = response.body.id as string; const suffix = randomUUID().slice(0, 8);
    const duplicateName = `既存同名馬-${suffix}`;
    await db.horse.create({ data: { id: randomUUID(), name: duplicateName } });
    const entries = Array.from({ length: 18 }, (_, index) => ({ number: index + 1, horseName: index === 0 ? duplicateName : `一括登録馬${index + 1}-${suffix}` }));
    const key = headers();
    const created = await admin.call(`admin/races/${batchRaceId}/entries/manual-batch`, 'POST', { entries, revision: 1, reason: '出馬表18頭を確認して一括登録' }, undefined, key);
    expect(created.status).toBe(201);
    expect(created.body.entries).toHaveLength(18);
    expect(created.body.duplicateNames).toEqual([duplicateName]);
    expect((await admin.call(`admin/races/${batchRaceId}/entries/manual-batch`, 'POST', { entries, revision: 1, reason: '出馬表18頭を確認して一括登録' }, undefined, key)).body).toEqual(created.body);
    expect(await db.raceEntry.count({ where: { raceId: batchRaceId } })).toBe(18);
    expect(await db.horseExternalIdentity.count({ where: { horse: { entries: { some: { raceId: batchRaceId } } }, provider: 'MANUAL' } })).toBe(18);
    expect((await db.race.findUniqueOrThrow({ where: { id: batchRaceId } })).revision).toBe(2);
    expect(await db.auditLog.count({ where: { targetId: batchRaceId, action: 'MANUAL_ENTRY_BATCH_CREATE' } })).toBe(1);
    const review = await admin.call(`admin/horse-identities/review?limit=50&date=${day}&raceId=${batchRaceId}`);
    expect(review.status).toBe(200); expect(review.body.items).toHaveLength(18);
    const batchItems = review.body.items.map((identity: { id: string; updatedAt: string; provisionalHorse: { id: string } }) => ({ id: identity.id, expectedHorseId: identity.provisionalHorse.id, expectedUpdatedAt: identity.updatedAt }));
    const rejected = await admin.call('admin/horse-identities/confirm-distinct-batch', 'POST', { raceId: batchRaceId, identities: batchItems, reason: '同名候補を含む一括確定を拒否' }, undefined, headers());
    expect(rejected).toMatchObject({ status: 409, body: { code: 'HORSE_IDENTITY_CANDIDATE_FOUND' } });
    expect(await db.horseExternalIdentity.count({ where: { id: { in: batchItems.map((item: { id: string }) => item.id) }, matchStatus: 'MATCHED' } })).toBe(0);
    const eligible = review.body.items.filter((identity: { candidates: unknown[] }) => identity.candidates.length === 0);
    expect(eligible).toHaveLength(17);
    const eligibleItems = eligible.map((identity: { id: string; updatedAt: string; provisionalHorse: { id: string } }) => ({ id: identity.id, expectedHorseId: identity.provisionalHorse.id, expectedUpdatedAt: identity.updatedAt }));
    const batchKey = headers();
    const confirmed = await admin.call('admin/horse-identities/confirm-distinct-batch', 'POST', { raceId: batchRaceId, identities: eligibleItems, reason: '同名候補なしを出馬表で一括確認' }, undefined, batchKey);
    expect(confirmed).toMatchObject({ status: 201, body: { count: 17 } });
    expect((await admin.call('admin/horse-identities/confirm-distinct-batch', 'POST', { raceId: batchRaceId, identities: eligibleItems, reason: '同名候補なしを出馬表で一括確認' }, undefined, batchKey)).body).toEqual(confirmed.body);
    expect(await db.horseExternalIdentity.count({ where: { id: { in: eligibleItems.map((item: { id: string }) => item.id) }, matchStatus: 'MATCHED' } })).toBe(17);
    expect(await db.auditLog.count({ where: { targetId: { in: eligibleItems.map((item: { id: string }) => item.id) }, action: 'HORSE_IDENTITY_RESOLVE' } })).toBe(17);
    expect((await admin.call('admin/horse-identities/confirm-distinct-batch', 'POST', { raceId: batchRaceId, identities: [eligibleItems[0]], reason: '古い確認画面からの再実行' }, undefined, headers())).body.code).toBe('HORSE_IDENTITY_BATCH_STALE');
    expect((await expertClient.call('admin/horse-identities/confirm-distinct-batch', 'POST', { raceId: batchRaceId, identities: [eligibleItems[0]], reason: '権限外操作' }, undefined, headers())).status).toBe(403);
    const conflict = await admin.call(`admin/races/${batchRaceId}/entries/manual-batch`, 'POST', { entries: [{ number: 1, horseName: `衝突馬-${suffix}` }], revision: 2, reason: '登録済み馬番との競合確認' }, undefined, headers());
    expect(conflict).toMatchObject({ status: 409, body: { code: 'ENTRY_ALREADY_EXISTS' } });
    expect(await db.raceEntry.count({ where: { raceId: batchRaceId } })).toBe(18);
    const history = await admin.call(`admin/races/${batchRaceId}/history?limit=50`);
    expect(history.body.items).toContainEqual(expect.objectContaining({ action: 'MANUAL_ENTRY_BATCH_CREATE', sourceType: 'MANUAL', reason: '出馬表18頭を確認して一括登録' }));
  });
  it('reports invalid CSV and previews without mutation; concurrent confirmation applies once', async () => {
    const rows = [entryInput(2), entryInput(3)];
    const bad = await preview('entries', [rows[0], { ...rows[1], number: 2 }], raceId);
    expect(bad.body.batchId).toBeNull(); expect(bad.body.errors.length).toBeGreaterThan(0);
    const p = await preview('entries', rows, raceId);
    expect(p.status).toBe(201); expect(p.body.changes.map((c: { action: string }) => c.action)).toEqual(['追加', '追加']);
    expect(await db.raceEntry.count({ where: { raceId } })).toBe(1);
    const path = `admin/races/import/${p.body.batchId}/confirm`;
    const results = await Promise.all([admin.call(path, 'POST', { reason: 'CSV確認' }), admin.call(path, 'POST', { reason: 'CSV確認' })]);
    expect(results.map(r => r.status)).toEqual([201, 201]);
    expect(await db.raceEntry.count({ where: { raceId } })).toBe(3);
    expect(await db.auditLog.count({ where: { targetId: p.body.batchId, action: 'CSV_IMPORT_CONFIRMED' } })).toBe(1);
    const again = await preview('entries', [{ ...rows[0], jockey: '変更騎手' }], raceId);
    expect(again.body.changes[0].action).toBe('変更');
    expect(again.body.changes[0].fields).toContainEqual({ field: 'jockey', before: '試験騎手', after: '変更騎手' });
    expect((await admin.call(`admin/races/import/${again.body.batchId}/confirm`, 'POST', { reason: '騎手変更' })).status).toBe(201);
    expect(await db.raceEntry.count({ where: { raceId } })).toBe(3);
  });
  it('rejects stale preview, expired preview and other operators confirming a preview', async () => {
    const rows = [entryInput(4)]; const p = await preview('entries', rows, raceId);
    const race = await db.race.findUniqueOrThrow({ where: { id: raceId } });
    expect((await admin.call(`admin/races/${raceId}/entries`, 'POST', { entry: entryInput(5), revision: race.revision, reason: '同時編集' }, undefined, headers())).status).toBe(201);
    expect((await admin.call(`admin/races/import/${p.body.batchId}/confirm`, 'POST', { reason: '古い差分' })).body.code).toBe('STALE_PREVIEW');
    expect(await db.raceEntry.count({ where: { raceId, number: 4 } })).toBe(0);
    const expired = await preview('entries', rows, raceId);
    await db.importBatch.update({ where: { id: expired.body.batchId }, data: { expiresAt: new Date(0) } });
    expect((await admin.call(`admin/races/import/${expired.body.batchId}/confirm`, 'POST', { reason: '期限切れ' })).body.code).toBe('PREVIEW_EXPIRED');
    const other = new Client(); await other.login(await account('OPERATOR'));
    expect((await other.call(`admin/races/import/${p.body.batchId}/confirm`, 'POST', { reason: '他人の確認' })).status).toBe(404);
  });
  it('rolls back an entire import when an expert becomes invalid and respects DB entry uniqueness', async () => {
    const temp = await account('EXPERT'); const rows = [{ ...raceInput(11), expertId: null }, { ...raceInput(12), expertId: temp.user.id }];
    const p = await preview('races', rows); expect(p.body.batchId).toBeTruthy();
    await db.user.update({ where: { id: temp.user.id }, data: { disabledAt: new Date() } });
    expect((await admin.call(`admin/races/import/${p.body.batchId}/confirm`, 'POST', { reason: '原子的確認' })).status).toBe(400);
    expect(await db.race.count({ where: { raceDate: day, venue: '東京', number: { in: [11, 12] } } })).toBe(0);
    const existing = await db.raceEntry.findFirstOrThrow({ where: { raceId } });
    await expect(db.raceEntry.create({ data: { ...entryInput(existing.number), raceId, horseId: existing.horseId } })).rejects.toThrow();
    const good = await preview('races', [{ ...rows[0], number: 10 }]);
    expect((await admin.call(`admin/races/import/${good.body.batchId}/confirm`, 'POST', { reason: 'レースCSV作成' })).status).toBe(201);
    const noChange = await preview('races', [{ ...rows[0], number: 10 }]);
    expect(noChange.body.changes[0].action).toBe('変更なし');
  });
  it('previews and atomically confirms a verified JRA-VAN race-day bundle', async () => {
    const bundledRace = { ...raceInput(8), expertId: null }, bundledEntries = [entryInput(6), entryInput(7)];
    const payload = bundlePayload(bundledRace, bundledEntries);
    const tampered = await admin.call('admin/races/import/bundle/preview', 'POST', { ...payload, entries: [{ ...payload.entries[0], csv: payload.entries[0].csv.replace('試験馬6', '改変馬') }] });
    expect(tampered.body.batchId).toBeNull(); expect(tampered.body.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining('SHA-256') }));
    const rehearsal = await admin.call('admin/races/import/bundle/preview', 'POST', { ...payload, manifest: JSON.stringify({ ...JSON.parse(payload.manifest), sampleData: true }) });
    expect(rehearsal.body.batchId).toBeNull(); expect(rehearsal.body.errors).toContainEqual(expect.objectContaining({ field: 'manifest.sampleData', message: expect.stringContaining('合成データ') }));
    const previewed = await admin.call('admin/races/import/bundle/preview', 'POST', payload);
    expect(previewed.status).toBe(201); expect(previewed.body.raceCount).toBe(1); expect(previewed.body.entryCount).toBe(2);
    expect(await db.race.count({ where: { raceDate: day, venue: '東京', number: 8 } })).toBe(0);
    const path = `admin/races/import/bundle/${previewed.body.batchId}/confirm`;
    const confirmed = await admin.call(path, 'POST', { reason: 'JRA-VAN開催日一括取込試験' });
    expect(confirmed.status).toBe(201); expect(confirmed.body.alreadyConfirmed).toBe(false);
    const race = await db.race.findUniqueOrThrow({ where: { raceDate_venue_number: { raceDate: day, venue: '東京', number: 8 } }, include: { entries: true } });
    expect(race.entries).toHaveLength(2);
    expect((await admin.call(path, 'POST', { reason: 'JRA-VAN開催日一括取込試験' })).body.alreadyConfirmed).toBe(true);
    expect(await db.auditLog.count({ where: { targetId: previewed.body.batchId, action: 'JRA_VAN_RACE_DAY_BUNDLE_IMPORT_CONFIRMED' } })).toBe(1);
    const duplicate = await admin.call('admin/races/import/bundle/preview', 'POST', payload);
    expect(duplicate.body.batchId).toBeNull(); expect(duplicate.body.errors).toContainEqual(expect.objectContaining({ field: 'sourceChecksum', message: expect.stringContaining('反映済み') }));
  });
});
