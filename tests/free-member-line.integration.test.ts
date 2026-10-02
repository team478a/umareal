import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchCapabilities, resolveLaunchMode } from '../packages/domain/src';
import { runNotificationBatch, type NotificationTransport } from '../apps/worker/src/notification-runner';
import { assessmentFixture } from './assessment-fixtures';
import { account, Client, db } from './helpers';

let settings: Awaited<ReturnType<typeof db.systemSetting.findUniqueOrThrow>>;
beforeAll(async () => {
  if (process.env.AUTH_PROVIDER !== 'local' || !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)) throw new Error('Local test database required');
  settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
  await db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: true, lineChannelId: 'local-line-test', lineChannelSecretEncrypted: 'local-only', lineAccessTokenEncrypted: 'local-only' } });
});
afterAll(async () => {
  if (settings) await db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: settings.lineNotificationsEnabled, lineChannelId: settings.lineChannelId, lineChannelSecretEncrypted: settings.lineChannelSecretEncrypted, lineAccessTokenEncrypted: settings.lineAccessTokenEncrypted } });
  await db.$disconnect();
});

describe('free-member LINE launch boundaries', () => {
  it('exposes LINE independently of billing and applies the server launch mode to Checkout', async () => {
    const client = new Client(); const config = await client.call('auth/config');
    const mode = resolveLaunchMode(process.env.LAUNCH_MODE);
    expect(config.status).toBe(200);
    expect(config.body.launchMode).toBe(mode);
    expect(config.body.capabilities).toEqual(launchCapabilities(mode));
    expect(config.body.lineNotificationsEnabled).toBe(true);
    const checkout = await client.call('billing/checkout', 'POST', {});
    expect(checkout.body.code).toBe(mode === 'FREE_REGISTRATION' ? 'BILLING_NOT_IN_LAUNCH' : 'UNAUTHENTICATED');
    expect(checkout.status).toBe(mode === 'FREE_REGISTRATION' ? 503 : 401);
    expect(JSON.stringify(config.body)).not.toMatch(/Encrypted|accessToken|channelSecret|passwordHash|authSubject/i);
  });

  it('delivers an announcement once to a free member and excludes blocked, opted-out and closed accounts', async () => {
    const admin = await assessmentFixture('ADMIN');
    const recipient = await account(); const optedOut = await account(); const blocked = await account(); const closed = await account();
    for (const fixture of [recipient, optedOut, blocked, closed]) await db.lineAccount.create({ data: { userId: fixture.user.id, subject: `test:free-line:${fixture.user.id}`, ...(fixture === blocked ? { notificationDisabledAt: new Date() } : {}) } });
    await db.notificationPreference.update({ where: { userId: optedOut.user.id }, data: { predictions: false } });
    await db.user.update({ where: { id: closed.user.id }, data: { disabledAt: new Date() } });
    expect(await db.entitlement.count({ where: { userId: recipient.user.id } })).toBe(0);
    const notice = await admin.client.call(`admin/races/${admin.race.id}/announce`, 'POST', { reason: '無料会員のLINE告知を確認' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(notice.status).toBe(201);
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { announcementId: notice.body.id } });
    const messages: string[] = [];
    const transport: NotificationTransport = { async send(input) {
      if (input.recipient === `test:free-line:${recipient.user.id}`) messages.push(input.message.text);
      return { kind: 'SENT', providerMessageId: `local-${input.retryKey}` };
    } };
    await runNotificationBatch({ db, transport, eventId: event.id, limit: 2000 });
    const delivery = await db.notificationDelivery.findFirstOrThrow({ where: { eventId: event.id, userId: recipient.user.id, channel: 'LINE' } });
    expect(delivery.status).toBe('SENT');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`/races/${admin.race.id}`);
    expect(messages[0]).not.toMatch(/評価試験馬|password|token|secret/i);
    for (const fixture of [optedOut, blocked, closed]) expect(await db.notificationDelivery.count({ where: { eventId: event.id, userId: fixture.user.id, channel: 'LINE' } })).toBe(0);
    await runNotificationBatch({ db, transport, eventId: event.id, limit: 2000 });
    expect(messages).toHaveLength(1);
    expect(await db.notificationDelivery.count({ where: { eventId: event.id, userId: recipient.user.id, channel: 'LINE' } })).toBe(1);
  });

  it('requires ADMIN and AAL2 for the existing notification self-test', async () => {
    const member = await assessmentFixture('MEMBER'); const aal1 = await assessmentFixture('ADMIN', 1); const admin = await assessmentFixture('ADMIN');
    const input = { channel: 'LINE', contentType: 'RACE_ANNOUNCEMENT', raceId: admin.race.id, reason: '担当者本人への配信確認' };
    const headers = { 'Idempotency-Key': randomUUID() };
    expect((await member.client.call('admin/notifications/test-send', 'POST', input, undefined, headers)).status).toBe(403);
    expect((await aal1.client.call('admin/notifications/test-send', 'POST', input, undefined, headers)).body.code).toBe('MFA_REQUIRED');
    await db.lineAccount.create({ data: { userId: admin.owner.user.id, subject: `test:self:${randomUUID()}` } });
    const result = await admin.client.call('admin/notifications/test-send', 'POST', input, undefined, headers);
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ status: 'SIMULATED', channel: 'LINE', transport: 'TEST_ONLY' });
    expect(await db.notificationDelivery.count({ where: { userId: admin.owner.user.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorId: admin.owner.user.id, action: 'NOTIFICATION_TEST_SENT' } })).toBe(1);
  });
});
