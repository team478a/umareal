import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { racePaperListSchema, racePaperReadSchema, type RacePaperDraft } from '../packages/domain/src';
import { runEmailNotificationBatch, runNotificationBatch, type NotificationTransport } from '../apps/worker/src/notification-runner';
import { assessmentFixture } from './assessment-fixtures';
import { Client, db } from './helpers';

let settings: Awaited<ReturnType<typeof db.systemSetting.findUniqueOrThrow>>;
beforeAll(async () => {
  settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
  await db.systemSetting.update({ where: { id: 'global' }, data: { predictionPublicationEnabled: true, predictionCorrectionPolicy: 'ADMIN_ONLY', delayedPublicationPolicy: 'CLOSED', lineNotificationsEnabled: true, emailNotificationsEnabled: true, lineChannelId: 'paper-test', lineChannelSecretEncrypted: 'test-encrypted', lineAccessTokenEncrypted: 'test-encrypted' } });
});
afterAll(async () => {
  if (settings) await db.systemSetting.update({ where: { id: 'global' }, data: { predictionPublicationEnabled: settings.predictionPublicationEnabled, predictionCorrectionPolicy: settings.predictionCorrectionPolicy, delayedPublicationPolicy: settings.delayedPublicationPolicy, lineNotificationsEnabled: settings.lineNotificationsEnabled, emailNotificationsEnabled: settings.emailNotificationsEnabled, lineChannelId: settings.lineChannelId, lineChannelSecretEncrypted: settings.lineChannelSecretEncrypted, lineAccessTokenEncrypted: settings.lineAccessTokenEncrypted } });
  await db.$disconnect();
});

async function fixture(role: 'ADMIN' | 'EXPERT' | 'OPERATOR' = 'ADMIN', scope: 'MEMBERS' | 'PAID' = 'MEMBERS') {
  const f = await assessmentFixture(role, 2, 5);
  const draft: RacePaperDraft = { targetDate: f.race.raceDate, title: `前日紙面${randomUUID().slice(0, 8)}`, summary: '総評は会員ページだけ', accessScope: scope, races: [{ raceId: f.race.id, marks: f.entries.map((e, i) => ({ entryId: e.id, symbol: (['◎', '○', '△', '△', '✕'] as const)[i], reason: i === 0 ? '会員限定の理由' : '' })) }] };
  return { ...f, id: randomUUID(), draft };
}
async function save(f: Awaited<ReturnType<typeof fixture>>, revision = 0, draft = f.draft) {
  return f.client.call('expert/papers/draft', 'POST', { id: f.id, revision, draft, reason: '紙面テストの内容保存' });
}
async function publish(f: Awaited<ReturnType<typeof fixture>>) {
  const saved = await save(f); expect(saved.status).toBe(201);
  const preview = await f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: saved.body.revision });
  expect(preview.status).toBe(201);
  const result = await f.client.call(`expert/papers/${f.id}/publish/${preview.body.previewId}`, 'POST');
  expect(result.status).toBe(201);
  return { ...result.body, preview: preview.body } as { versionId: string; preview: { previewId: string; notificationText: string } };
}

describe('regular race paper publication and access', () => {
  it('requires server-owned role, AAL2 and all race assignments', async () => {
    const f = await fixture('EXPERT');
    expect((await new Client().call('expert/papers')).status).toBe(401);
    const member = await assessmentFixture('MEMBER');
    expect((await member.client.call('expert/papers')).status).toBe(403);
    const aal1 = await assessmentFixture('ADMIN', 1);
    expect((await aal1.client.call('expert/papers')).status).toBe(403);
    const foreign = await assessmentFixture();
    expect((await foreign.client.call('expert/papers/draft', 'POST', { id: f.id, revision: 0, draft: f.draft, reason: '担当外' })).status).toBe(403);
    expect((await save(f)).status).toBe(201);
    expect((await foreign.client.call(`expert/papers/${f.id}`)).status).toBe(403);
    const operator = await assessmentFixture('OPERATOR');
    const operatorPaperId = randomUUID();
    expect((await operator.client.call('expert/papers/draft', 'POST', { id: operatorPaperId, revision: 0, draft: f.draft, reason: 'レース担当による保存' })).status).toBe(201);
    expect((await f.client.call('expert/papers')).body.items.map((p: { id: string }) => p.id)).toContain(operatorPaperId);
    await db.expertAssignment.deleteMany({ where: { raceId: f.race.id } });
    expect((await f.client.call(`expert/papers/${f.id}`)).status).toBe(403);
    expect((await f.client.call('expert/papers')).body.items.map((p: { id: string }) => p.id)).not.toContain(f.id);
  });
  it('matches imported race names, horse numbers/names, and preserves duplicate triangles and crosses', async () => {
    const f = await fixture('EXPERT');
    const targetDate = new Date(Date.UTC(2110, 0, 1) + (parseInt(f.id.slice(0, 8), 16) % 10000) * 86400000).toISOString().slice(0, 10);
    await db.race.update({ where: { id: f.race.id }, data: { raceDate: targetDate, venue: '東京', number: 9, name: '八ヶ岳特別', startsAt: new Date(`${targetDate}T06:00:00Z`) } });
    const text = '東京\n9R 八ヶ岳特別\n◎１・評価試験馬1\n○２・評価試験馬2\n△３・評価試験馬3\n△４・評価試験馬4\n✕５・評価試験馬5';
    const input = { targetDate, title: '前日紙面', accessScope: 'MEMBERS', text };
    const imported = await f.client.call('expert/papers/import', 'POST', input);
    expect(imported.status).toBe(201);
    expect(imported.body.snapshot.races[0].marks.map((m: { symbol: string }) => m.symbol)).toEqual(['◎', '○', '△', '△', '✕']);
    expect((await f.client.call('expert/papers/import', 'POST', { ...input, text: text.replace('八ヶ岳特別', '別レース') })).body.code).toBe('PAPER_RACE_MISMATCH');
    expect((await f.client.call('expert/papers/import', 'POST', { ...input, text: text.replace('評価試験馬5', '違う馬') })).body.code).toBe('PAPER_HORSE_MISMATCH');
    expect((await f.client.call('expert/papers/import', 'POST', { ...input, text: text + '\n買い目 1-2' })).body.code).toBe('PAPER_IMPORT_INVALID');
    await db.raceEntry.update({ where: { id: f.entries[0].id }, data: { status: 'SCRATCHED' } });
    expect((await f.client.call('expert/papers/import', 'POST', input)).body.code).toBe('PAPER_ENTRY_INVALID');
    expect(await db.racePaper.count({ where: { id: f.id } })).toBe(0);
  });
  it('publishes exactly once under concurrent confirmation and replays, and emits safe notifications', async () => {
    const member = await assessmentFixture('MEMBER'); const f = await fixture();
    const saved = await save(f);
    expect((await save(f)).status).toBe(409);
    const checked = await f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: saved.body.revision });
    expect(checked.status).toBe(201);
    expect(checked.body.notificationText).toContain(`/papers/${f.id}`);
    expect(checked.body.notificationText).not.toMatch(/評価試験馬|会員限定|[◎○△✕]/);
    const results = await Promise.all([1, 2].map(() => f.client.call(`expert/papers/${f.id}/publish/${checked.body.previewId}`, 'POST')));
    expect(results.map(r => r.status)).toEqual([201, 201]);
    expect(results.filter(r => !r.body.alreadyPublished)).toHaveLength(1);
    expect(await db.racePaperVersion.count({ where: { paperId: f.id } })).toBe(1);
    const version = await db.racePaperVersion.findFirstOrThrow({ where: { paperId: f.id } });
    expect(await db.notificationEvent.count({ where: { paperVersionId: version.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { targetId: version.id, action: 'RACE_PAPER_PUBLISHED' } })).toBe(1);
    const notices = await member.client.call('me/notifications?limit=50');
    const item = notices.body.items.find((i: { paper?: { id: string } }) => i.paper?.id === f.id);
    expect(item).toMatchObject({ href: `/papers/${f.id}`, title: '通常レース紙面を公開しました', race: null });
    expect(JSON.stringify(item)).not.toMatch(/snapshot|評価試験馬|会員限定/);
    expect((await member.client.call(`me/notifications/${item.id}/read`, 'POST')).status).toBe(201);
  });
  it('rejects stale, expired and foreign previews including race and horse changes', async () => {
    const f = await fixture(); const saved = await save(f);
    const check = () => f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: saved.body.revision });
    const preview = await check();
    const other = await assessmentFixture('ADMIN');
    expect((await other.client.call(`expert/papers/${f.id}/publish/${preview.body.previewId}`, 'POST')).status).toBe(404);
    await db.raceEntry.update({ where: { id: f.entries[1].id }, data: { horseName: '出走馬名の変更' } });
    expect((await f.client.call(`expert/papers/${f.id}/publish/${preview.body.previewId}`, 'POST')).body.code).toBe('STALE_PREVIEW');
    const renewed = await check(); expect(renewed.status).toBe(201);
    await db.racePaperPreview.update({ where: { id: renewed.body.previewId }, data: { expiresAt: new Date(0) } });
    expect((await f.client.call(`expert/papers/${f.id}/publish/${renewed.body.previewId}`, 'POST')).body.code).toBe('STALE_PREVIEW');
    const final = await check(); await save(f, 1, { ...f.draft, summary: '別端末で変更' });
    expect((await f.client.call(`expert/papers/${f.id}/publish/${final.body.previewId}`, 'POST')).body.code).toBe('STALE_PREVIEW');
    expect(await db.racePaperVersion.count({ where: { paperId: f.id } })).toBe(0);
  });
  it('keeps a reviewed paper valid across ordinary reads and unrelated jockey metadata updates', async () => {
    const f = await fixture(); await save(f);
    const preview = await f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: 1 });
    expect(preview.status).toBe(201);
    await f.client.call(`expert/papers/${f.id}`);
    await db.raceEntry.update({ where: { id: f.entries[1].id }, data: { jockey: '紙面の表示・印を変えない登録変更' } });
    expect((await f.client.call(`expert/papers/${f.id}/publish/${preview.body.previewId}`, 'POST')).status).toBe(201);
    expect(await db.racePaperVersion.count({ where: { paperId: f.id } })).toBe(1);
  });
  it('returns member paper contents only after login and never exposes unpublished drafts', async () => {
    const member = await assessmentFixture('MEMBER'); const f = await fixture();
    expect((await new Client().call('papers')).status).toBe(401);
    expect((await new Client().call(`papers/${f.id}`)).status).toBe(401);
    await save(f);
    expect((await member.client.call(`papers/${f.id}`)).status).toBe(404);
    const checked = await f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: 1 });
    await f.client.call(`expert/papers/${f.id}/publish/${checked.body.previewId}`, 'POST');
    const archive = racePaperListSchema.parse((await member.client.call('papers')).body);
    expect(archive.items.find(v => v.id === f.id)).toMatchObject({ accessScope: 'MEMBERS', correctionReason: null });
    expect(JSON.stringify(archive)).not.toMatch(/評価試験馬|会員限定|総評は/);
    const read = racePaperReadSchema.parse((await member.client.call(`papers/${f.id}`)).body);
    expect(read.versions[0].locked).toBe(false);
    expect(JSON.stringify(read)).toContain('評価試験馬1');
    expect(JSON.stringify(read)).not.toMatch(/passwordHash|authSubject|publisherId|updatedBy|token/);
  });
  it('redacts paid paper bodies and correction reasons at the API and reuses date-scoped entitlements', async () => {
    const member = await assessmentFixture('MEMBER'); const f = await fixture('ADMIN', 'PAID');
    await publish(f);
    await save(f, 1, { ...f.draft, summary: '訂正された有料本文' });
    const preview = await f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: 2, correctionReason: '本命馬名を訂正' });
    expect(preview.status).toBe(201);
    expect((await f.client.call(`expert/papers/${f.id}/publish/${preview.body.previewId}`, 'POST')).status).toBe(201);
    const locked = (await member.client.call(`papers/${f.id}`)).body;
    expect(locked.versions).toHaveLength(2);
    expect(locked.versions.every((v: { locked: boolean }) => v.locked)).toBe(true);
    expect(JSON.stringify(locked)).not.toMatch(/snapshot|評価試験馬|本命馬名|訂正された/);
    const now = Date.now();
    const entitlement = await db.entitlement.create({ data: { userId: member.owner.user.id, planCode: 'DAY_PASS', raceDate: f.race.raceDate, startsAt: new Date(now - 1000), endsAt: new Date(now + 3600000), reason: '既存一日利用権', grantedBy: member.owner.user.id } });
    expect((await member.client.call(`papers/${f.id}`)).body.versions.every((v: { locked: boolean }) => !v.locked)).toBe(true);
    await db.entitlement.update({ where: { id: entitlement.id }, data: { raceDate: '2096-01-02' } });
    expect((await member.client.call(`papers/${f.id}`)).body.versions[0].locked).toBe(true);
    await db.entitlement.update({ where: { id: entitlement.id }, data: { raceDate: null } });
    expect((await member.client.call(`papers/${f.id}`)).body.versions[0].locked).toBe(false);
  });
  it('preserves immutable versions and requires authorized corrections with a reason', async () => {
    const f = await fixture('EXPERT'); const first = await publish(f);
    await save(f, 1, { ...f.draft, summary: '訂正された紙面' });
    expect((await f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: 2, correctionReason: '表現訂正' })).status).toBe(403);
    const admin = await assessmentFixture('ADMIN');
    expect((await admin.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: 2 })).body.code).toBe('CORRECTION_REASON_REQUIRED');
    const preview = await admin.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: 2, correctionReason: '表現訂正' });
    expect((await admin.client.call(`expert/papers/${f.id}/publish/${preview.body.previewId}`, 'POST')).status).toBe(201);
    const versions = await db.racePaperVersion.findMany({ where: { paperId: f.id }, orderBy: { version: 'asc' } });
    expect(versions.map(v => v.version)).toEqual([1, 2]);
    expect(versions[0].id).toBe(first.versionId);
    expect(JSON.stringify(versions[0].snapshot)).toContain('総評は会員ページだけ');
    expect(versions[1].correctionReason).toBe('表現訂正');
    await expect(db.racePaperVersion.update({ where: { id: first.versionId }, data: { title: '改ざん' } })).rejects.toThrow();
    await expect(db.racePaperVersion.delete({ where: { id: first.versionId } })).rejects.toThrow();
    await expect(db.$executeRaw`TRUNCATE race_paper_versions CASCADE`).rejects.toThrow();
  });
  it('closes publication at the earliest race and cannot reopen by removing or delaying a prior race', async () => {
    const f = await fixture(); const first = await publish(f);
    const extra = await assessmentFixture('ADMIN');
    await save(f, 1, { ...f.draft, races: [{ raceId: extra.race.id, marks: [{ entryId: extra.entries[0].id, symbol: '◎', reason: '' }] }] });
    await db.race.update({ where: { id: f.race.id }, data: { startsAt: new Date(Date.now() - 60000) } });
    expect((await f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: 2, correctionReason: '最初のレース除外' })).body.code).toBe('PUBLICATION_CLOSED');
    const original = await db.racePaperVersion.findUniqueOrThrow({ where: { id: first.versionId } });
    await expect(db.racePaperVersion.create({ data: { paperId: f.id, version: 2, targetDate: original.targetDate, title: original.title, accessScope: original.accessScope, snapshot: original.snapshot!, deadlineAt: original.deadlineAt, publishedBy: f.owner.user.id, correctionReason: '直接挿入でも拒否' } })).rejects.toThrow();
    const unpublished = await fixture(); await save(unpublished);
    await db.race.update({ where: { id: unpublished.race.id }, data: { startsAt: new Date(Date.now() - 1000) } });
    expect((await unpublished.client.call(`expert/papers/${unpublished.id}/preview`, 'POST', { revision: 1 })).body.code).toBe('PUBLICATION_CLOSED');
  });
  it('honors publication stop and delayed-race policy, and validates database target uniqueness', async () => {
    const f = await fixture(); await save(f);
    await db.systemSetting.update({ where: { id: 'global' }, data: { predictionPublicationEnabled: false } });
    expect((await f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: 1 })).status).toBe(403);
    await db.systemSetting.update({ where: { id: 'global' }, data: { predictionPublicationEnabled: true } });
    await db.race.update({ where: { id: f.race.id }, data: { status: 'DELAYED' } });
    expect((await f.client.call(`expert/papers/${f.id}/preview`, 'POST', { revision: 1 })).body.code).toBe('PUBLICATION_CLOSED');
    await db.race.update({ where: { id: f.race.id }, data: { status: 'SCHEDULED' } });
    const workspace = (await f.client.call(`expert/papers/${f.id}`)).body;
    await expect(db.racePaperVersion.create({ data: { paperId: f.id, version: 1, targetDate: f.draft.targetDate, title: f.draft.title, accessScope: 'MEMBERS', snapshot: { ...workspace.snapshot, races: [workspace.snapshot.races[0], workspace.snapshot.races[0]] }, deadlineAt: f.race.startsAt, publishedBy: f.owner.user.id } })).rejects.toThrow();
  });
  it('sends LINE and email metadata-only notices through the existing worker', async () => {
    const member = await assessmentFixture('MEMBER'); const subject = `test:paper:${randomUUID()}`;
    await db.lineAccount.create({ data: { userId: member.owner.user.id, subject } });
    const f = await fixture(); const published = await publish(f);
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { paperVersionId: published.versionId } });
    // Record only this fixture's messages while exercising the real expansion filter.
    const sent: string[] = [];
    const transport: NotificationTransport = { async send(input) { if (input.recipient === subject || input.recipient === member.owner.user.email) sent.push(input.message.text); return { kind: 'SENT', providerMessageId: `paper-${input.retryKey}` }; } };
    await runNotificationBatch({ db, transport, eventId: event.id, limit: 200 });
    for (let batch = 0; batch < 20; batch++) {
      const pending = await db.notificationDelivery.count({ where: { eventId: event.id, channel: 'LINE', status: 'QUEUED', nextAttemptAt: { lte: new Date() } } });
      if (!pending) break;
      await runNotificationBatch({ db, transport, eventId: event.id, limit: 200 });
    }
    const line = await db.notificationDelivery.findUniqueOrThrow({ where: { eventId_userId_channel: { eventId: event.id, userId: member.owner.user.id, channel: 'LINE' } } });
    if (!line.attemptCount) { await db.notificationDelivery.update({ where: { id: line.id }, data: { nextAttemptAt: new Date(0) } }); await runNotificationBatch({ db, transport, eventId: event.id, limit: 200 }); }
    // Existing suites can produce many eligible emails. Target the test email deterministically.
    await db.notificationEvent.update({ where: { id: event.id }, data: { emailExpandedAt: new Date() } });
    await db.notificationDelivery.create({ data: { eventId: event.id, userId: member.owner.user.id, channel: 'EMAIL', idempotencyKey: `paper-email-${randomUUID()}` } });
    await runEmailNotificationBatch({ db, transport, eventId: event.id, limit: 200 });
    expect(sent).toHaveLength(2);
    for (const message of sent) { expect(message).toContain(`/papers/${f.id}`); expect(message).not.toMatch(/評価試験馬|会員限定|総評は|[◎○△✕]/); }
    const adminNotices = await f.client.call('admin/notifications?limit=50');
    expect(adminNotices.status).toBe(200);
    expect(adminNotices.body.items.find((d: { event: { id: string } }) => d.event.id === event.id)?.event.paperVersion).toMatchObject({ paperId: f.id, title: f.draft.title });
    const replay = await runNotificationBatch({ db, transport, eventId: event.id, limit: 200 });
    expect(replay.sent).toBe(0);
  });
});
