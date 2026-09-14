import { randomUUID } from 'node:crypto';
import { blankAssessment, jstDate } from '../packages/domain/src';
import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('race-day operations board', () => {
  it('reports server-derived progress, deadlines, delivery failures and authorization', async () => {
    const adminFixture = await account('ADMIN'); const admin = new Client(); await admin.login(adminFixture); await admin.mfa();
    const expert = await account('EXPERT'); const recipient = await account();
    const startsAt = new Date(Date.now() + 10 * 60000); const date = jstDate(startsAt);
    const race = await db.race.create({ data: { raceDate: date, venue: `運用-${randomUUID().slice(0, 6)}`, number: 8, name: `運用ボード-${randomUUID().slice(0, 6)}`, startsAt, assignments: { create: { userId: expert.user.id } } } });
    const entries = [];
    for (let number = 1; number <= 2; number++) entries.push(await db.raceEntry.create({ data: { race: { connect: { id: race.id } }, horse: { create: { id: randomUUID(), name: `運用馬${number}` } }, number, gate: number, horseName: `運用馬${number}`, sex: 'MALE', age: 3, carriedWeight: 57, jockey: '運用騎手', trainer: '運用調教師' } }));
    await db.assessment.create({ data: { entryId: entries[0].id, revision: 1, updatedBy: expert.user.id, content: { ...blankAssessment, body: 4, walk: 4, coat: 4, focus: 4, calm: 4, change: 'UP' } } });
    const announcement = await db.raceAnnouncement.create({ data: { raceId: race.id, version: 1, publishedBy: adminFixture.user.id, reason: '運用ボード結合試験' } });
    const event = await db.notificationEvent.create({ data: { announcementId: announcement.id, eventType: 'RACE_ANNOUNCED', status: 'FAILED', expandedAt: new Date(), payload: { raceId: race.id, visibility: 'FREE' } } });
    await db.notificationDelivery.create({ data: { eventId: event.id, userId: recipient.user.id, status: 'FAILED', idempotencyKey: `operations-${randomUUID()}`, lastErrorCode: 'TEST_FAILURE' } });

    const response = await admin.call(`admin/operations?date=${date}`); expect(response.status).toBe(200);
    const item = response.body.items.find((value: { id: string }) => value.id === race.id); expect(item).toBeTruthy();
    expect(item).toMatchObject({ deadlineState: 'DUE_SOON', entries: { total: 2, paddockCompleted: 1 }, announcement: { version: 1 }, prediction: null, notification: { queued: 0, sent: 0, failed: 1 }, result: null });
    expect(item.assignments[0]).toMatchObject({ id: expert.user.id, active: true });
    expect(item.warnings).toEqual(expect.arrayContaining(['パドック未完了 1頭', '最終予想未公開', '通知失敗 1件']));
    expect(item.rehearsal).toMatchObject({ status: 'BLOCKED', done: 2, total: 6, nextStep: 'PADDOCK' });
    expect(item.rehearsal.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'SETUP', state: 'DONE' }),
      expect.objectContaining({ key: 'ANNOUNCEMENT', state: 'DONE' }),
      expect.objectContaining({ key: 'PADDOCK', state: 'CURRENT' }),
      expect.objectContaining({ key: 'DELIVERY', state: 'BLOCKED' }),
      expect.objectContaining({ key: 'RESULT', state: 'NOT_DUE' })
    ]));
    expect(response.body.rehearsal).toMatchObject({ total: expect.any(Number), ready: expect.any(Number), blocked: expect.any(Number), preflight: { csvImportEnabled: expect.any(Boolean), predictionPublicationEnabled: expect.any(Boolean), lineNotificationsEnabled: expect.any(Boolean), lineConfigured: expect.any(Boolean) } });

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call(`admin/operations?date=${date}`)).status).toBe(200);
    const member = new Client(); await member.login(recipient);
    expect((await member.call(`admin/operations?date=${date}`)).status).toBe(403);
    expect((await admin.call('admin/operations?date=invalid')).status).toBe(400);
  });
});
