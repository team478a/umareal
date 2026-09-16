import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runPublicationSchedules } from '../apps/worker/src/publication-scheduler';
import { account, Client, db } from './helpers';

beforeAll(() => { const url = new URL(process.env.DATABASE_URL ?? ''); if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local') throw new Error('Integration suite is limited to a local development database'); });
afterAll(() => db.$disconnect());

async function fixture() {
  const suffix = randomUUID().slice(0, 8); const admin = await account('ADMIN'); const operator = await account('OPERATOR'); const member = await account(); const race = await db.race.create({ data: { raceDate: '2098-11-01', venue: `予約${suffix}`, number: 5, name: `配信予約試験${suffix}`, startsAt: new Date('2098-11-01T15:00:00+09:00') } });
  const horses = await Promise.all([1, 2].map(async number => { const horse = await db.horse.create({ data: { id: randomUUID(), name: `予約馬${number}-${suffix}` } }); return db.raceEntry.create({ data: { raceId: race.id, horseId: horse.id, number, gate: number, horseName: horse.name, sex: 'MALE', age: 4, carriedWeight: 57, jockey: `騎手${number}`, trainer: `調教師${number}` } }); }));
  const adminClient = new Client(); await adminClient.login(admin); await adminClient.mfa(); const operatorClient = new Client(); await operatorClient.login(operator); const memberClient = new Client(); await memberClient.login(member); return { admin, operator, member, race, horses, adminClient, operatorClient, memberClient };
}

describe('scheduled publication and alerts', () => {
  it('publishes a target-race announcement once at the scheduled time', async () => {
    const target = await fixture(); const scheduledAt = new Date('2098-11-01T14:00:00+09:00'); const key = randomUUID(); const body = { raceId: target.race.id, kind: 'RACE_ANNOUNCEMENT', draftRevision: null, scheduledAt: scheduledAt.toISOString(), reason: '告知を定刻配信' };
    expect((await target.memberClient.call('admin/publication-schedules?date=2098-11-01')).status).toBe(403);
    const created = await target.adminClient.call('admin/publication-schedules', 'POST', body, undefined, { 'Idempotency-Key': key }); expect(created.status).toBe(201); expect(created.body.status).toBe('PENDING');
    const replay = await target.adminClient.call('admin/publication-schedules', 'POST', body, undefined, { 'Idempotency-Key': key }); expect(replay.body.id).toBe(created.body.id);
    await runPublicationSchedules({ db, now: () => new Date(scheduledAt.getTime() - 1000) });
    expect(await db.publicationSchedule.findUniqueOrThrow({ where: { id: created.body.id } })).toMatchObject({ status: 'PENDING', publishedTargetId: null });
    await runPublicationSchedules({ db, now: () => scheduledAt });
    await runPublicationSchedules({ db, now: () => scheduledAt });
    const schedule = await db.publicationSchedule.findUniqueOrThrow({ where: { id: created.body.id } }); expect(schedule.status).toBe('PUBLISHED');
    const announcement = await db.raceAnnouncement.findUniqueOrThrow({ where: { id: schedule.publishedTargetId! } }); expect(announcement.reason).toBe(body.reason);
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { announcementId: announcement.id } }); expect(event).toMatchObject({ eventType: 'RACE_ANNOUNCED', status: 'QUEUED' });
    await db.notificationEvent.update({ where: { id: event.id }, data: { status: 'FAILED', expandedAt: new Date(), emailExpandedAt: new Date() } });
    await db.notificationDelivery.createMany({ data: [
      { eventId: event.id, userId: target.member.user.id, channel: 'LINE', status: 'SENT', sentAt: new Date(), idempotencyKey: `schedule-line:${randomUUID()}` },
      { eventId: event.id, userId: target.member.user.id, channel: 'EMAIL', status: 'FAILED', lastErrorCode: 'TEST_PROVIDER_FAILURE', idempotencyKey: `schedule-email:${randomUUID()}` }
    ] });
    const overview = await target.adminClient.call('admin/publication-schedules?date=2098-11-01');
    const race = overview.body.items.find((item: { id: string }) => item.id === target.race.id);
    expect(overview.body.failedDeliveries).toBeGreaterThanOrEqual(1);
    expect(race.deliveryResults[0]).toMatchObject({ eventId: event.id, contentType: 'RACE_ANNOUNCEMENT', label: '対象レース告知', version: 1, eventStatus: 'FAILED', line: { total: 1, sent: 1, failed: 0 }, email: { total: 1, sent: 0, failed: 1 } });
    const filtered = await target.adminClient.call(`admin/notifications?raceId=${target.race.id}`);
    expect(filtered.status).toBe(200); expect(filtered.body).toMatchObject({ raceId: target.race.id, total: 2, counts: { SENT: 1, FAILED: 1 } });
    expect(filtered.body.items.every((item: { event: { announcement: { race: { id: string } } } }) => item.event.announcement.race.id === target.race.id)).toBe(true);
    const testBody = { raceId: target.race.id, contentType: 'RACE_ANNOUNCEMENT', channel: 'EMAIL', reason: '公開前の運営確認' }; const testKey = randomUUID();
    expect((await target.memberClient.call('admin/notifications/test-send', 'POST', testBody, undefined, { 'Idempotency-Key': randomUUID() })).status).toBe(403);
    expect((await target.operatorClient.call('admin/notifications/test-send', 'POST', testBody, undefined, { 'Idempotency-Key': randomUUID() })).status).toBe(403);
    const testSent = await target.adminClient.call('admin/notifications/test-send', 'POST', testBody, undefined, { 'Idempotency-Key': testKey });
    expect(testSent.status).toBe(201); expect(testSent.body).toMatchObject({ status: 'SIMULATED', channel: 'EMAIL', transport: 'TEST_ONLY', contentLabel: '対象レース告知', version: 2 });
    const testReplay = await target.adminClient.call('admin/notifications/test-send', 'POST', testBody, undefined, { 'Idempotency-Key': testKey }); expect(testReplay.body).toEqual(testSent.body);
    expect((await target.adminClient.call('admin/notifications/test-send', 'POST', { ...testBody, reason: '異なる理由' }, undefined, { 'Idempotency-Key': testKey })).status).toBe(409);
    const stoppedLine = await target.adminClient.call('admin/notifications/test-send', 'POST', { ...testBody, channel: 'LINE' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(stoppedLine.status).toBe(503); expect(stoppedLine.body).toMatchObject({ code: 'LINE_NOTIFICATIONS_STOPPED' });
    expect(await db.auditLog.count({ where: { actorId: target.admin.user.id, action: 'NOTIFICATION_TEST_SENT', targetId: target.race.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { actorId: target.admin.user.id, action: 'NOTIFICATION_TEST_SEND_FAILED', targetId: target.race.id } })).toBe(1);
    expect(await db.notificationEvent.count({ where: { announcement: { raceId: target.race.id } } })).toBe(1);
  });

  it('fails safely when a frozen free-report draft changes and exposes the alert', async () => {
    const target = await fixture(); const base = { upEntryId: target.horses[0].id, upReason: '気配上昇', downEntryId: target.horses[1].id, downReason: '集中を欠く', audioUrl: 'https://media.example.test/schedule.mp3', reviewText: '' };
    await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 0, ...base, reason: '予約用下書き' });
    const testSent = await target.adminClient.call('admin/notifications/test-send', 'POST', { raceId: target.race.id, contentType: 'FREE_REPORT_PRE_RACE', draftRevision: 1, channel: 'EMAIL', reason: '無料速報の公開前確認' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(testSent.status).toBe(201); expect(testSent.body).toMatchObject({ status: 'SIMULATED', contentLabel: '無料パドック速報', version: 1 }); expect(await db.freeReportVersion.count({ where: { raceId: target.race.id } })).toBe(0);
    const scheduledAt = new Date('2098-11-01T14:10:00+09:00'); const created = await target.adminClient.call('admin/publication-schedules', 'POST', { raceId: target.race.id, kind: 'FREE_REPORT_PRE_RACE', draftRevision: 1, scheduledAt: scheduledAt.toISOString(), reason: '無料速報を定刻配信' }, undefined, { 'Idempotency-Key': randomUUID() }); expect(created.status).toBe(201);
    await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 1, ...base, upReason: '予約後に修正', reason: '内容を再確認' });
    await runPublicationSchedules({ db, now: () => scheduledAt });
    expect(await db.publicationSchedule.findUnique({ where: { id: created.body.id } })).toMatchObject({ status: 'FAILED', errorCode: 'SCHEDULE_DRAFT_CHANGED' });
    expect(await db.freeReportVersion.count({ where: { raceId: target.race.id } })).toBe(0);
    const alerts = await target.adminClient.call('admin/publication-schedules?date=2098-11-01'); const race = alerts.body.items.find((item: { id: string }) => item.id === target.race.id); expect(race.warnings).toContain('失敗した配信予約があります。');
    const next = await target.adminClient.call('admin/publication-schedules', 'POST', { raceId: target.race.id, kind: 'FREE_REPORT_PRE_RACE', draftRevision: 2, scheduledAt: new Date(scheduledAt.getTime() + 60_000).toISOString(), reason: '修正版を予約' }, undefined, { 'Idempotency-Key': randomUUID() });
    const cancelled = await target.adminClient.call(`admin/publication-schedules/${next.body.id}/cancel`, 'POST', { reason: '配信時刻を見直す' }); expect(cancelled.body.status).toBe('CANCELLED');
  });
});
