import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';

beforeAll(() => {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local') throw new Error('Integration suite is limited to a local development database');
});
afterAll(() => db.$disconnect());

async function events() {
  const publisher = await account('ADMIN'); const suffix = randomUUID().slice(0, 8); const raceDate = '2097-04-05';
  return db.$transaction(async tx => {
    const race = await tx.race.create({ data: { raceDate, venue: `受信箱${suffix}`, number: 7, name: `会員履歴${suffix}`, startsAt: new Date(`${raceDate}T15:00:00+09:00`) } });
    const announcement = await tx.raceAnnouncement.create({ data: { raceId: race.id, version: 1, publishedBy: publisher.user.id, reason: '会員履歴の結合試験' } });
    const announcementEvent = await tx.notificationEvent.create({ data: { announcementId: announcement.id, eventType: 'RACE_ANNOUNCED', status: 'SENT', expandedAt: new Date(), payload: { raceId: race.id } } });
    const prediction = await tx.prediction.create({ data: { raceId: race.id, draft: {}, revision: 1, updatedBy: publisher.user.id } });
    const freeVersion = await tx.predictionVersion.create({ data: { predictionId: prediction.id, version: 1, status: 'PUBLISHED', visibility: 'FREE', confidence: 'A', stance: 'SKIP', summary: 'APIへ出さない本文', estimatedTotalYen: 0, contentSnapshot: {}, assessmentSnapshot: {}, publisherId: publisher.user.id, deadlineAt: race.startsAt } });
    const freeEvent = await tx.notificationEvent.create({ data: { versionId: freeVersion.id, eventType: 'PREDICTION_PUBLISHED', status: 'SENT', expandedAt: new Date(), payload: { raceId: race.id } } });
    const paidVersion = await tx.predictionVersion.create({ data: { predictionId: prediction.id, version: 2, status: 'CORRECTED', visibility: 'PAID', confidence: 'A', stance: 'SKIP', summary: '有料本文をAPIへ出さない', estimatedTotalYen: 0, contentSnapshot: {}, assessmentSnapshot: {}, publisherId: publisher.user.id, deadlineAt: race.startsAt, previousVersionId: freeVersion.id, correctionReason: '試験' } });
    const paidEvent = await tx.notificationEvent.create({ data: { versionId: paidVersion.id, eventType: 'PREDICTION_CORRECTED', status: 'SENT', expandedAt: new Date(), payload: { raceId: race.id } } });
    return { race, announcementEvent, freeEvent, paidEvent };
  });
}

describe('member notification history', () => {
  it('lists safe public events, applies paid entitlement, and persists idempotent read state', async () => {
    const fixture = await account(); const target = await events(); const client = new Client(); await client.login(fixture);
    expect((await new Client().call('me/notifications')).status).toBe(401);
    const initial = await client.call('me/notifications?limit=50');
    expect(initial.status).toBe(200);
    const ids = initial.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(target.announcementEvent.id); expect(ids).toContain(target.freeEvent.id); expect(ids).not.toContain(target.paidEvent.id);
    expect(JSON.stringify(initial.body)).not.toContain('APIへ出さない本文');
    expect((await client.call(`me/notifications/${target.paidEvent.id}/read`, 'POST')).status).toBe(404);
    const laterFixture = await account(); const laterClient = new Client(); await laterClient.login(laterFixture);
    expect((await laterClient.call('me/notifications?limit=50')).body.items.map((item: { id: string }) => item.id)).not.toContain(target.freeEvent.id);

    const now = new Date();
    await db.entitlement.create({ data: { userId: fixture.user.id, planCode: 'TEST', startsAt: new Date(now.getTime() - 1000), endsAt: new Date(now.getTime() + 3600000), raceDate: target.race.raceDate, reason: '会員履歴の閲覧試験', grantedBy: fixture.user.id } });
    const entitled = await client.call('me/notifications?limit=50');
    expect(entitled.body.items.map((item: { id: string }) => item.id)).toContain(target.paidEvent.id);

    const before = entitled.body.unreadCount;
    const firstRead = await client.call(`me/notifications/${target.freeEvent.id}/read`, 'POST');
    const secondRead = await client.call(`me/notifications/${target.freeEvent.id}/read`, 'POST');
    expect(firstRead.status).toBe(201); expect(secondRead.body.readAt).toBe(firstRead.body.readAt);
    const unread = await client.call('me/notifications?unread=true&limit=50');
    expect(unread.body.unreadCount).toBe(before - 1);
    expect(unread.body.items.map((item: { id: string }) => item.id)).not.toContain(target.freeEvent.id);
  });
});
