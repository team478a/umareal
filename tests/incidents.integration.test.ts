import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('incident response dashboard', () => {
  it('detects stale notification leases without exposing secrets and enforces staff access', async () => {
    const adminFixture = await account('ADMIN'); const recipient = await account();
    const race = await db.race.create({ data: { raceDate: '2098-10-01', venue: `障害-${randomUUID().slice(0, 6)}`, number: 7, name: `障害対応-${randomUUID().slice(0, 6)}`, startsAt: new Date('2098-10-01T15:00:00+09:00') } });
    const announcement = await db.raceAnnouncement.create({ data: { raceId: race.id, version: 1, publishedBy: adminFixture.user.id, reason: '障害対応結合試験' } });
    const event = await db.notificationEvent.create({ data: { announcementId: announcement.id, eventType: 'RACE_ANNOUNCED', status: 'SENDING', expandedAt: new Date(), payload: { raceId: race.id, visibility: 'FREE' } } });
    const delivery = await db.notificationDelivery.create({ data: { eventId: event.id, userId: recipient.user.id, status: 'SENDING', idempotencyKey: `incident-${randomUUID()}`, leaseToken: randomUUID(), lockedAt: new Date(Date.now() - 6 * 60_000) } });

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    const response = await operator.call('admin/incidents'); expect(response.status).toBe(200);
    expect(response.body.generatedAt).toBeTruthy();
    expect(response.body.monitoring.stuckDeliveries).toBeGreaterThanOrEqual(1);
    expect(response.body.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DELIVERY_STUCK', severity: 'CRITICAL', href: '/admin/notifications' })]));
    expect(response.body.publicMessage).toContain('Web会員ページ');
    expect(JSON.stringify(response.body)).not.toMatch(/lineAccessToken|lineChannelSecretEncrypted|leaseToken/);

    const member = new Client(); await member.login(recipient);
    expect((await member.call('admin/incidents')).status).toBe(403);
    await db.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', lockedAt: null, leaseToken: null, lastErrorCode: 'INCIDENT_TEST' } });
  });
});
