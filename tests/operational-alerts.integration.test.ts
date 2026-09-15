import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { runOperationalAlerts, type OperationalAlertTransport } from '../apps/worker/src/operational-alert-runner';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('external operational alerts', () => {
  it('records source failures once, sends safe external mail, and audits acknowledgement and resolution', async () => {
    const original = await db.operationalAlertSetting.findUniqueOrThrow({ where: { id: 'global' } });
    const adminFixture = await account('ADMIN'); const recipient = await account(); const now = new Date();
    const race = await db.race.create({ data: { raceDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now), venue: `外部通知-${randomUUID().slice(0, 6)}`, number: 4, name: '本文へ含めないレース名', startsAt: new Date(now.getTime() - 60_000) } });
    const announcement = await db.raceAnnouncement.create({ data: { raceId: race.id, version: 1, publishedBy: adminFixture.user.id, reason: '運用アラート試験' } });
    const event = await db.notificationEvent.create({ data: { announcementId: announcement.id, eventType: 'RACE_ANNOUNCED', status: 'FAILED', payload: { privatePrediction: '外部へ送らない予想本文' } } });
    const delivery = await db.notificationDelivery.create({ data: { eventId: event.id, userId: recipient.user.id, channel: 'EMAIL', status: 'FAILED', idempotencyKey: `alert-${randomUUID()}`, attemptCount: 5, lastErrorCode: 'TEST_FINAL_FAILURE' } });
    const scheduledRace = await db.race.create({ data: { raceDate: '2098-11-02', venue: `予約失敗-${randomUUID().slice(0, 6)}`, number: 5, name: '予約失敗試験', startsAt: new Date('2098-11-02T15:00:00+09:00') } });
    const schedule = await db.publicationSchedule.create({ data: { raceId: scheduledRace.id, kind: 'RACE_ANNOUNCEMENT', scheduledAt: new Date(), status: 'FAILED', reason: '運用アラート試験', createdBy: adminFixture.user.id, processedAt: new Date(), errorCode: 'SCHEDULE_EXECUTION_FAILED' } });
    await db.operationalAlertSetting.update({ where: { id: 'global' }, data: { enabled: true, minimumSeverity: 'WARNING', destinationEmails: ['ops@example.test'] } });
    const messages: string[] = [];
    const transport: OperationalAlertTransport = { async send(input) { messages.push(input.text); return { kind: 'SENT', providerMessageId: randomUUID() }; } };
    try {
      const first = await runOperationalAlerts({ db, transport, now: () => now }); expect(first.created).toBeGreaterThanOrEqual(3);
      await runOperationalAlerts({ db, transport, now: () => new Date(now.getTime() + 1) });
      const alert = await db.operationalAlert.findUniqueOrThrow({ where: { dedupeKey: `DELIVERY_FAILED:${delivery.id}` }, include: { deliveries: true } });
      expect(alert).toMatchObject({ code: 'DELIVERY_FAILED', severity: 'WARNING', status: 'OPEN' });
      expect(alert.deliveries).toEqual(expect.arrayContaining([expect.objectContaining({ recipient: 'ops@example.test' })]));
      expect(await db.operationalAlert.count({ where: { dedupeKey: `DELIVERY_FAILED:${delivery.id}` } })).toBe(1);
      expect(await db.operationalAlertDelivery.count({ where: { alertId: alert.id, recipient: 'ops@example.test' } })).toBe(1);
      const scheduleAlert = await db.operationalAlert.findUnique({ where: { dedupeKey: `PUBLICATION_SCHEDULE_FAILED:${schedule.id}` } }); expect(scheduleAlert?.severity).toBe('CRITICAL');
      const deadlineAlert = await db.operationalAlert.findUnique({ where: { dedupeKey: `PUBLICATION_DEADLINE_MISSED:${race.id}` } }); expect(deadlineAlert?.severity).toBe('CRITICAL');
      expect(messages.length).toBeGreaterThan(0); expect(messages.join('\n')).not.toContain(recipient.user.email!); expect(messages.join('\n')).not.toContain('外部へ送らない予想本文');

      const admin = new Client(); await admin.login(adminFixture); await admin.mfa();
      const listed = await admin.call('admin/operational-alerts?status=OPEN'); expect(listed.status).toBe(200); expect(JSON.stringify(listed.body)).not.toContain('外部へ送らない予想本文');
      expect((await admin.call(`admin/operational-alerts/${alert.id}/acknowledge`, 'POST', { reason: '担当者が原因調査を開始' })).status).toBe(201);
      expect((await admin.call(`admin/operational-alerts/${alert.id}/resolve`, 'POST', { reason: 'メール配送経路の復旧を確認' })).status).toBe(201);
      expect(await db.auditLog.count({ where: { targetId: alert.id, action: { in: ['OPERATIONAL_ALERT_ACKNOWLEDGED', 'OPERATIONAL_ALERT_RESOLVED'] } } })).toBe(2);
      const member = new Client(); await member.login(recipient); expect((await member.call('admin/operational-alerts')).status).toBe(403);
    } finally {
      await db.operationalAlertSetting.update({ where: { id: 'global' }, data: { enabled: original.enabled, minimumSeverity: original.minimumSeverity, destinationEmails: original.destinationEmails, revision: original.revision, updatedBy: original.updatedBy, updatedAt: original.updatedAt } });
    }
  });

  it('requires an AAL2 administrator and optimistic revision to change destinations', async () => {
    const original = await db.operationalAlertSetting.findUniqueOrThrow({ where: { id: 'global' } });
    const fixture = await account('ADMIN'); const admin = new Client(); await admin.login(fixture);
    try {
      expect((await admin.call('admin/operational-alerts/settings', 'PATCH', { revision: original.revision, enabled: true, minimumSeverity: 'CRITICAL', destinationEmails: ['owner@example.test'], reason: '通知先設定' })).body.code).toBe('MFA_REQUIRED');
      await admin.mfa(); const current = await admin.call('admin/operational-alerts/settings');
      const updated = await admin.call('admin/operational-alerts/settings', 'PATCH', { revision: current.body.revision, enabled: true, minimumSeverity: 'CRITICAL', destinationEmails: ['owner@example.test'], reason: '本番運用担当へ通知' }); expect(updated.status).toBe(200);
      const stale = await admin.call('admin/operational-alerts/settings', 'PATCH', { revision: current.body.revision, enabled: false, minimumSeverity: 'CRITICAL', destinationEmails: [], reason: '競合試験' }); expect(stale.body.code).toBe('STALE_REVISION');
    } finally {
      await db.operationalAlertSetting.update({ where: { id: 'global' }, data: { enabled: original.enabled, minimumSeverity: original.minimumSeverity, destinationEmails: original.destinationEmails, revision: original.revision, updatedBy: original.updatedBy, updatedAt: original.updatedAt } });
    }
  });
});
