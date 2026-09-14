import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';
import { entryHeaders, raceHeaders } from '../packages/domain/src/races';
const admin = new Client(); let expert: Awaited<ReturnType<typeof account>>; let expertClient: Client;
let day = `2098-${String(Math.floor(Math.random() * 12) + 1).padStart(2, '0')}-${String(Math.floor(Math.random() * 28) + 1).padStart(2, '0')}`;
const raceInput = (number: number) => ({ raceDate: day, venue: '東京', number, name: `CSV試験-${randomUUID().slice(0, 6)}`, raceClass: '未勝利', distance: 1600, surface: 'TURF', direction: 'LEFT', startsAt: `${day}T10:00:00+09:00`, going: 'GOOD', weather: '晴', status: 'SCHEDULED', expertId: expert.user.id });
const entryInput = (number: number) => ({ horseId: randomUUID(), number, gate: 1, horseName: `試験馬${number}`, sex: 'MALE', age: 3, carriedWeight: 57, jockey: '試験騎手', trainer: '試験調教師', winOdds: null, popularity: null, status: 'ACTIVE' });
const headers = () => ({ 'Idempotency-Key': randomUUID() });
function csv(kind: 'races' | 'entries', rows: Record<string, unknown>[]) {
  const fields = kind === 'races' ? raceHeaders : entryHeaders;
  return [fields.join(','), ...rows.map(row => fields.map(field => String(row[field] ?? '')).join(','))].join('\n');
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
    const dayResponse = await admin.call('admin/race-days', 'POST', { day: { raceDate: day, venue: '東京' }, reason: '開催日試験' }, undefined, headers());
    expect([201, 409]).toContain(dayResponse.status);
    const body = { race: raceInput(1), reason: 'レース作成試験' }; const key = headers();
    const result = await admin.call('admin/races', 'POST', body, undefined, key);
    expect(result.status).toBe(201); raceId = result.body.id;
    expect((await admin.call('admin/races', 'POST', body, undefined, key)).body.id).toBe(raceId);
    expect((await admin.call('admin/races', 'POST', body, undefined, headers())).status).toBe(409);
    expect((await expertClient.call('expert/races')).body.items.map((r: { id: string }) => r.id)).toContain(raceId);
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
});
