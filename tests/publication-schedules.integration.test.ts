import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runPublicationSchedules } from '../apps/worker/src/publication-scheduler';
import { account, Client, db } from './helpers';

beforeAll(() => { const url = new URL(process.env.DATABASE_URL ?? ''); if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local') throw new Error('Integration suite is limited to a local development database'); });
afterAll(() => db.$disconnect());

async function fixture() {
  const suffix = randomUUID().slice(0, 8); const admin = await account('ADMIN'); const member = await account(); const race = await db.race.create({ data: { raceDate: '2098-11-01', venue: `予約${suffix}`, number: 5, name: `配信予約試験${suffix}`, startsAt: new Date('2098-11-01T15:00:00+09:00') } });
  const horses = await Promise.all([1, 2].map(async number => { const horse = await db.horse.create({ data: { id: randomUUID(), name: `予約馬${number}-${suffix}` } }); return db.raceEntry.create({ data: { raceId: race.id, horseId: horse.id, number, gate: number, horseName: horse.name, sex: 'MALE', age: 4, carriedWeight: 57, jockey: `騎手${number}`, trainer: `調教師${number}` } }); }));
  const adminClient = new Client(); await adminClient.login(admin); await adminClient.mfa(); const memberClient = new Client(); await memberClient.login(member); return { admin, member, race, horses, adminClient, memberClient };
}

describe('scheduled publication and alerts', () => {
  it('publishes a target-race announcement once at the scheduled time', async () => {
    const target = await fixture(); const scheduledAt = new Date('2098-11-01T14:00:00+09:00'); const key = randomUUID(); const body = { raceId: target.race.id, kind: 'RACE_ANNOUNCEMENT', draftRevision: null, scheduledAt: scheduledAt.toISOString(), reason: '告知を定刻配信' };
    expect((await target.memberClient.call('admin/publication-schedules?date=2098-11-01')).status).toBe(403);
    const created = await target.adminClient.call('admin/publication-schedules', 'POST', body, undefined, { 'Idempotency-Key': key }); expect(created.status).toBe(201); expect(created.body.status).toBe('PENDING');
    const replay = await target.adminClient.call('admin/publication-schedules', 'POST', body, undefined, { 'Idempotency-Key': key }); expect(replay.body.id).toBe(created.body.id);
    expect(await runPublicationSchedules({ db, now: () => new Date(scheduledAt.getTime() - 1000) })).toMatchObject({ claimed: 0, published: 0 });
    expect(await runPublicationSchedules({ db, now: () => scheduledAt })).toMatchObject({ claimed: 1, published: 1, failed: 0 });
    expect(await runPublicationSchedules({ db, now: () => scheduledAt })).toMatchObject({ claimed: 0, published: 0 });
    const schedule = await db.publicationSchedule.findUniqueOrThrow({ where: { id: created.body.id } }); expect(schedule.status).toBe('PUBLISHED');
    const announcement = await db.raceAnnouncement.findUniqueOrThrow({ where: { id: schedule.publishedTargetId! } }); expect(announcement.reason).toBe(body.reason);
    expect(await db.notificationEvent.findUnique({ where: { announcementId: announcement.id } })).toMatchObject({ eventType: 'RACE_ANNOUNCED', status: 'QUEUED' });
  });

  it('fails safely when a frozen free-report draft changes and exposes the alert', async () => {
    const target = await fixture(); const base = { upEntryId: target.horses[0].id, upReason: '気配上昇', downEntryId: target.horses[1].id, downReason: '集中を欠く', audioUrl: 'https://media.example.test/schedule.mp3', reviewText: '' };
    await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 0, ...base, reason: '予約用下書き' });
    const scheduledAt = new Date('2098-11-01T14:10:00+09:00'); const created = await target.adminClient.call('admin/publication-schedules', 'POST', { raceId: target.race.id, kind: 'FREE_REPORT_PRE_RACE', draftRevision: 1, scheduledAt: scheduledAt.toISOString(), reason: '無料速報を定刻配信' }, undefined, { 'Idempotency-Key': randomUUID() }); expect(created.status).toBe(201);
    await target.adminClient.call(`admin/free-reports/races/${target.race.id}/draft`, 'PATCH', { revision: 1, ...base, upReason: '予約後に修正', reason: '内容を再確認' });
    expect(await runPublicationSchedules({ db, now: () => scheduledAt })).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    expect(await db.publicationSchedule.findUnique({ where: { id: created.body.id } })).toMatchObject({ status: 'FAILED', errorCode: 'SCHEDULE_DRAFT_CHANGED' });
    expect(await db.freeReportVersion.count({ where: { raceId: target.race.id } })).toBe(0);
    const alerts = await target.adminClient.call('admin/publication-schedules?date=2098-11-01'); const race = alerts.body.items.find((item: { id: string }) => item.id === target.race.id); expect(race.warnings).toContain('失敗した配信予約があります。');
    const next = await target.adminClient.call('admin/publication-schedules', 'POST', { raceId: target.race.id, kind: 'FREE_REPORT_PRE_RACE', draftRevision: 2, scheduledAt: new Date(scheduledAt.getTime() + 60_000).toISOString(), reason: '修正版を予約' }, undefined, { 'Idempotency-Key': randomUUID() });
    const cancelled = await target.adminClient.call(`admin/publication-schedules/${next.body.id}/cancel`, 'POST', { reason: '配信時刻を見直す' }); expect(cancelled.body.status).toBe('CANCELLED');
  });
});
