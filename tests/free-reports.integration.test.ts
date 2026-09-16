import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runNotificationBatch } from '../apps/worker/src/notification-runner';
import type { NotificationTransport } from '../apps/worker/src/notification-runner';
import { account, base, Client, db, origin } from './helpers';

let lineSettingsBefore: { lineNotificationsEnabled: boolean; lineChannelId: string | null; lineChannelSecretEncrypted: string | null; lineAccessTokenEncrypted: string | null };
let benefitBefore: Awaited<ReturnType<typeof db.freeMemberBenefit.findUnique>>;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local') throw new Error('Integration suite is limited to a local development database');
  lineSettingsBefore = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineNotificationsEnabled: true, lineChannelId: true, lineChannelSecretEncrypted: true, lineAccessTokenEncrypted: true } });
  benefitBefore = await db.freeMemberBenefit.findUnique({ where: { id: 'global' } });
  await db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: true, lineChannelId: 'free-report-test', lineChannelSecretEncrypted: 'test-encrypted', lineAccessTokenEncrypted: 'test-encrypted' } });
});
afterAll(async () => {
  await db.systemSetting.update({ where: { id: 'global' }, data: lineSettingsBefore });
  if (benefitBefore) await db.freeMemberBenefit.upsert({ where: { id: 'global' }, create: benefitBefore, update: benefitBefore });
  else await db.freeMemberBenefit.deleteMany({ where: { id: 'global' } });
  await db.$disconnect();
});

async function fixture() {
  const suffix = randomUUID().slice(0, 8); const admin = await account('ADMIN'); const member = await account();
  const subject = `test:free-report:${suffix}`;
  await db.lineAccount.create({ data: { userId: member.user.id, subject } });
  const race = await db.race.create({ data: { raceDate: '2098-09-13', venue: `無料速報${suffix}`, number: 8, name: `無料速報試験${suffix}`, startsAt: new Date('2098-09-13T15:00:00+09:00') } });
  const firstHorse = await db.horse.create({ data: { id: randomUUID(), name: `上昇馬${suffix}` } });
  const secondHorse = await db.horse.create({ data: { id: randomUUID(), name: `下降馬${suffix}` } });
  const [up, down] = await Promise.all([
    db.raceEntry.create({ data: { raceId: race.id, horseId: firstHorse.id, number: 1, gate: 1, horseName: firstHorse.name, sex: 'MALE', age: 4, carriedWeight: 57, jockey: '騎手A', trainer: '調教師A' } }),
    db.raceEntry.create({ data: { raceId: race.id, horseId: secondHorse.id, number: 2, gate: 2, horseName: secondHorse.name, sex: 'MALE', age: 4, carriedWeight: 57, jockey: '騎手B', trainer: '調教師B' } })
  ]);
  const adminClient = new Client(); await adminClient.login(admin); await adminClient.mfa(); const memberClient = new Client(); await memberClient.login(member);
  return { admin, member, race, up, down, subject, adminClient, memberClient };
}

describe('LP free member offer', () => {
  it('publishes a safe append-only free report and sends its notification', async () => {
    const target = await fixture();
    expect((await new Client().call(`races/${target.race.id}/free-report`)).status).toBe(401);
    const audioBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01]);
    expect((await fetch(`${base}/api/v1/admin/free-reports/audio`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'audio/webm' }, body: audioBytes })).status).toBe(401);
    const uploadResponse = await fetch(`${base}/api/v1/admin/free-reports/audio`, { method: 'POST', headers: { Origin: origin, Cookie: target.adminClient.cookie, 'Content-Type': 'audio/webm' }, body: audioBytes });
    expect(uploadResponse.status).toBe(201); const upload = await uploadResponse.json() as { id: string; url: string; sizeBytes: number };
    expect(upload).toMatchObject({ sizeBytes: audioBytes.length, url: `/api/v1/free-report-audio/${upload.id}` });
    const beforePublish = await fetch(`${base}${upload.url}`, { headers: { Cookie: target.memberClient.cookie } });
    expect(beforePublish.status).toBe(404);
    const saved = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 0, upEntryId: target.up.id, upReason: '踏み込みが力強くなりました。', downEntryId: target.down.id, downReason: '発汗が目立ちます。', audioUrl: upload.url, reviewText: '', reason: '無料速報の結合試験' });
    expect(saved.status).toBe(200); expect(saved.body.revision).toBe(1);
    const beforePreview = await Promise.all([db.freeReportVersion.count({ where: { raceId: target.race.id } }), db.notificationEvent.count({ where: { freeReportVersion: { raceId: target.race.id } } })]);
    const preview = await target.adminClient.call(`admin/notifications/previews/free-report?raceId=${target.race.id}&kind=PRE_RACE&revision=1&scheduledAt=${encodeURIComponent('2098-09-13T14:30:00+09:00')}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ eventType: 'FREE_REPORT_PUBLISHED', contentLabel: '無料パドック速報', kind: 'PRE_RACE', draftRevision: 1, timing: 'SCHEDULED', version: 1 });
    expect(preview.body.audience.line.scheduledDeliveries).toBeGreaterThanOrEqual(1);
    expect(preview.body.message.text).toContain('無料パドック速報を公開しました');
    expect(preview.body.message.text).not.toContain(target.up.horseName);
    expect(await Promise.all([db.freeReportVersion.count({ where: { raceId: target.race.id } }), db.notificationEvent.count({ where: { freeReportVersion: { raceId: target.race.id } } })])).toEqual(beforePreview);
    const stalePreview = await target.adminClient.call(`admin/notifications/previews/free-report?raceId=${target.race.id}&kind=PRE_RACE&revision=2`);
    expect(stalePreview.status).toBe(409); expect(stalePreview.body.code).toBe('FREE_REPORT_DRAFT_CONFLICT');
    const published = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/publish`, 'POST', { revision: 1, kind: 'PRE_RACE', reason: '会員へ公開' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(published.status).toBe(201); expect(published.body.kind).toBe('PRE_RACE');
    const memberView = await target.memberClient.call(`races/${target.race.id}/free-report`);
    expect(memberView.status).toBe(200); expect(memberView.body.versions[0]).toMatchObject({ kind: 'PRE_RACE', version: 1 });
    expect(JSON.stringify(memberView.body)).not.toMatch(/upHorse|downHorse|Reason|audioUrl|reviewText|買い目|estimatedTotalYen|HONMEI/);
    const audioResponse = await fetch(`${base}${upload.url}`, { headers: { Cookie: target.memberClient.cookie, Range: 'bytes=0-3' } });
    expect(audioResponse.status).toBe(404);
    const version = await db.freeReportVersion.findUniqueOrThrow({ where: { id: published.body.id } });
    await expect(db.freeReportVersion.update({ where: { id: version.id }, data: { upReason: '上書き' } })).rejects.toThrow();
    await expect(db.freeReportVersion.delete({ where: { id: version.id } })).rejects.toThrow();
    await expect(db.audioAsset.update({ where: { id: upload.id }, data: { sizeBytes: 1 } })).rejects.toThrow();
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { freeReportVersionId: version.id } });
    const messages: string[] = []; const transport: NotificationTransport = { async send(input) { if (input.recipient === target.subject && input.targetId === version.id) messages.push(input.message.text); return { kind: 'SENT', providerMessageId: input.retryKey }; } };
    for (let index = 0; index < 20; index += 1) {
      const delivery = await db.notificationDelivery.findFirst({ where: { eventId: event.id, userId: target.member.user.id } });
      if (delivery?.status === 'SENT') break;
      if (delivery) await db.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
      await runNotificationBatch({ db, transport, limit: 200 });
    }
    expect(await db.notificationDelivery.findFirst({ where: { eventId: event.id, userId: target.member.user.id } })).toMatchObject({ status: 'SENT' });
    expect(messages[0]).toContain('無料パドック速報を公開しました');
    const notificationList = await target.memberClient.call('me/notifications?limit=50');
    expect(notificationList.body.items.find((item: { id: string }) => item.id === event.id)).toMatchObject({ title: '無料パドック速報を公開しました' });
  });

  it('shows a configured registration benefit only to authenticated members', async () => {
    const target = await fixture();
    const before = await target.adminClient.call('admin/free-reports/benefit');
    const saved = await target.adminClient.call('admin/free-reports/benefit', 'PATCH', { revision: before.body.revision, title: 'パドックで評価を変えた実例', description: '事前評価から結果検証までを解説します。', videoUrl: 'https://video.example.test/bonus', reason: 'LP登録特典の設定' });
    expect(saved.status).toBe(200); expect(saved.body.revision).toBe(before.body.revision + 1);
    expect((await new Client().call('me/free-benefit')).status).toBe(401);
    expect((await target.memberClient.call('me/free-benefit')).body).toMatchObject({ configured: true, title: 'パドックで評価を変えた実例', videoUrl: 'https://video.example.test/bonus' });
  });

  it('publishes the post-race review only after a confirmed result', async () => {
    const target = await fixture();
    const base = { upEntryId: target.up.id, upReason: '前走より良化。', downEntryId: target.down.id, downReason: '落ち着きを欠く。', audioUrl: 'https://media.example.test/review-source.mp3' };
    await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 0, ...base, reviewText: '', reason: '発走前速報を準備' });
    await target.adminClient.call(`admin/free-reports/races/${target.race.id}/publish`, 'POST', { revision: 1, kind: 'PRE_RACE', reason: '発走前に公開' }, undefined, { 'Idempotency-Key': randomUUID() });
    await db.race.update({ where: { id: target.race.id }, data: { startsAt: new Date(Date.now() - 60_000), status: 'FINISHED' } });
    const rejected = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/publish`, 'POST', { revision: 1, kind: 'POST_RACE_REVIEW', reason: '結果前の拒否確認' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(rejected.status).toBe(409); expect(rejected.body.code).toBe('FREE_REPORT_REVIEW_NOT_READY');
    await db.raceResultVersion.create({ data: { raceId: target.race.id, version: 1, sourceRevision: 1, ruleVersion: 'TEST_V1', entriesSnapshot: [], payoutsSnapshot: [], reason: '無料速報検証用の確定結果', confirmedBy: target.admin.user.id } });
    const saved = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 1, ...base, reviewText: '評価UP馬は2着。状態評価どおり力を出しました。', reason: '確定結果を検証' });
    expect(saved.body.revision).toBe(2);
    const beforePreview = await Promise.all([db.freeReportVersion.count({ where: { raceId: target.race.id } }), db.notificationEvent.count({ where: { freeReportVersion: { raceId: target.race.id } } })]);
    const preview = await target.adminClient.call(`admin/notifications/previews/free-report?raceId=${target.race.id}&kind=POST_RACE_REVIEW&revision=2`);
    expect(preview.status).toBe(200); expect(preview.body).toMatchObject({ eventType: 'FREE_REPORT_REVIEW_PUBLISHED', contentLabel: 'レース後検証', kind: 'POST_RACE_REVIEW', timing: 'IMMEDIATE', version: 2 });
    expect(preview.body.message.text).toContain('無料速報のレース後検証を公開しました');
    expect(await Promise.all([db.freeReportVersion.count({ where: { raceId: target.race.id } }), db.notificationEvent.count({ where: { freeReportVersion: { raceId: target.race.id } } })])).toEqual(beforePreview);
    const published = await target.adminClient.call(`admin/free-reports/races/${target.race.id}/publish`, 'POST', { revision: 2, kind: 'POST_RACE_REVIEW', reason: '結果確認後に公開' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(published.status).toBe(201); expect(published.body.kind).toBe('POST_RACE_REVIEW');
    const view = await target.memberClient.call(`races/${target.race.id}/free-report`);
    expect(view.body.versions[0]).toMatchObject({ kind: 'POST_RACE_REVIEW', version: 2 });
    expect(view.body.versions[0].reviewText).toBeUndefined();
  });
});
