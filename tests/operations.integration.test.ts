import { randomUUID } from 'node:crypto';
import { adminOperationsResponseSchema, blankAssessment, jstDate } from '../packages/domain/src';
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

    const scopedRace = await db.race.create({ data: { raceDate: date, venue: `対象外-${randomUUID().slice(0, 6)}`, number: 9, name: `LINE対象外-${randomUUID().slice(0, 6)}`, startsAt, assignments: { create: { userId: expert.user.id } } } });
    const scopedEntry = await db.raceEntry.create({ data: { race: { connect: { id: scopedRace.id } }, horse: { create: { id: randomUUID(), name: '対象外試験馬' } }, number: 1, gate: 1, horseName: '対象外試験馬', sex: 'MALE', age: 4, carriedWeight: 57, jockey: '対象外騎手', trainer: '対象外調教師' } });
    await db.assessment.create({ data: { entryId: scopedEntry.id, revision: 1, updatedBy: expert.user.id, content: { ...blankAssessment, body: 4, walk: 4, coat: 4, focus: 4, calm: 4, change: 'UP' } } });
    await db.raceAnnouncement.create({ data: { raceId: scopedRace.id, version: 1, publishedBy: adminFixture.user.id, reason: '対象外モード結合試験' } });
    const scopedPrediction = await db.prediction.create({ data: { raceId: scopedRace.id, draft: {}, revision: 1, updatedBy: adminFixture.user.id } });
    const scopedVersion = await db.predictionVersion.create({ data: { predictionId: scopedPrediction.id, version: 1, status: 'PUBLISHED', visibility: 'FREE', confidence: 'A', stance: 'SKIP', summary: '対象外モードの通知確認', estimatedTotalYen: 0, contentSnapshot: {}, assessmentSnapshot: {}, publisherId: adminFixture.user.id, deadlineAt: scopedRace.startsAt } });
    await db.notificationEvent.create({ data: { versionId: scopedVersion.id, eventType: 'PREDICTION_PUBLISHED', status: 'QUEUED', payload: { versionId: scopedVersion.id, raceId: scopedRace.id, visibility: 'FREE' } } });

    const response = await admin.call(`admin/operations?date=${date}`);
    expect(response.status).toBe(200);
    const operations = adminOperationsResponseSchema.parse(response.body);
    expect(Object.keys(response.body).sort()).toEqual(['alerts', 'date', 'generatedAt', 'items', 'rehearsal']);
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash|authSubject|email|lineSubject|lineAccessToken|lineChannelSecret|assessmentContent/);
    const item = operations.items.find(value => value.id === race.id); expect(item).toBeTruthy();
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
    const publicConfig = await new Client().call('auth/config'); expect(publicConfig.status).toBe(200);
    expect(operations.rehearsal.preflight.lineAvailable).toBe(publicConfig.body.capabilities.lineNotifications);
    const scopedItem = operations.items.find(value => value.id === scopedRace.id); expect(scopedItem).toBeTruthy();
    if (!operations.rehearsal.preflight.lineAvailable) {
      expect(scopedItem?.rehearsal.steps.find(step => step.key === 'DELIVERY')).toMatchObject({ state: 'CURRENT', detail: expect.stringContaining('対象外') });
    }
    expect(operations.rehearsal).toMatchObject({ total: expect.any(Number), ready: expect.any(Number), blocked: expect.any(Number), preflight: { csvImportEnabled: expect.any(Boolean), predictionPublicationEnabled: expect.any(Boolean), lineAvailable: expect.any(Boolean), lineNotificationsEnabled: expect.any(Boolean), lineConfigured: expect.any(Boolean) } });

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call(`admin/operations?date=${date}`)).status).toBe(200);
    const member = new Client(); await member.login(recipient);
    expect((await member.call(`admin/operations?date=${date}`)).status).toBe(403);
    expect((await admin.call('admin/operations?date=invalid')).status).toBe(400);
  });
});
