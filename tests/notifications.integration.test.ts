import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NotificationTransport } from '../apps/worker/src/notification-runner';
import { runEmailNotificationBatch, runNotificationBatch, skipPendingNotificationEvents, TestNotificationTransport } from '../apps/worker/src/notification-runner';
import { account, Client, db } from './helpers';

let settingsBefore: Awaited<ReturnType<typeof db.systemSetting.findUniqueOrThrow>>;
beforeAll(async () => {
  settingsBefore = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
  await db.systemSetting.update({ where: { id: 'global' }, data: { emailNotificationsEnabled: true, lineNotificationsEnabled: true, lineChannelId: 'notification-test', lineChannelSecretEncrypted: 'test-encrypted', lineAccessTokenEncrypted: 'test-encrypted', notificationMaxAttempts: 3, notificationBaseDelaySeconds: 10 } });
  // A developer database can contain pending events from an interrupted earlier run. Never turn those into email during this test run.
  await db.notificationEvent.updateMany({ where: { emailExpandedAt: null }, data: { emailExpandedAt: new Date(), updatedAt: new Date() } });
  // Preserve the append-only history while draining due work left by earlier local runs.
  for (let index = 0; index < 100; index += 1) {
    const result = await runNotificationBatch({ db, transport: new TestNotificationTransport(), limit: 200 });
    if (!result.expandedEvents && !result.claimedDeliveries) break;
  }
}, 120000);
afterAll(async () => {
  await db.systemSetting.update({ where: { id: 'global' }, data: { emailNotificationsEnabled: settingsBefore.emailNotificationsEnabled, lineNotificationsEnabled: settingsBefore.lineNotificationsEnabled, lineChannelId: settingsBefore.lineChannelId, lineChannelSecretEncrypted: settingsBefore.lineChannelSecretEncrypted, lineAccessTokenEncrypted: settingsBefore.lineAccessTokenEncrypted, notificationMaxAttempts: settingsBefore.notificationMaxAttempts, notificationBaseDelaySeconds: settingsBefore.notificationBaseDelaySeconds } });
  await db.$disconnect();
});

async function publication(visibility: 'FREE' | 'PAID' = 'FREE') {
  const publisher = await account('ADMIN');
  const suffix = randomUUID().slice(0, 8);
  return db.$transaction(async tx => {
    const race = await tx.race.create({ data: { raceDate: '2098-06-01', venue: `通知${suffix}`, number: 1, name: `通知試験${suffix}`, startsAt: new Date('2098-06-01T10:00:00+09:00') } });
    const prediction = await tx.prediction.create({ data: { raceId: race.id, draft: {}, revision: 1, updatedBy: publisher.user.id } });
    const version = await tx.predictionVersion.create({ data: { predictionId: prediction.id, version: 1, status: 'PUBLISHED', visibility, confidence: 'A', stance: 'SKIP', summary: '通知試験', estimatedTotalYen: 0, contentSnapshot: {}, assessmentSnapshot: {}, publisherId: publisher.user.id, deadlineAt: race.startsAt } });
    const event = await tx.notificationEvent.create({ data: { versionId: version.id, eventType: 'PREDICTION_PUBLISHED', status: 'QUEUED', payload: { versionId: version.id, raceId: race.id, visibility } } });
    return { race, version, event };
  });
}
async function recipient(subject = `test:sent:${randomUUID()}`, entitled = false) {
  const member = await account();
  await db.lineAccount.create({ data: { userId: member.user.id, subject } });
  if (entitled) await db.entitlement.create({ data: { userId: member.user.id, planCode: 'MANUAL', startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2099-01-01T00:00:00Z'), reason: '通知権限試験', grantedBy: member.user.id } });
  return member.user;
}
async function processFirstAttempt(eventId: string, userId: string, transport: NotificationTransport) {
  for (let index = 0; index < 20; index += 1) {
    const delivery = await db.notificationDelivery.findFirst({ where: { eventId, userId } });
    if (delivery?.attemptCount) return delivery;
    if (delivery?.status === 'QUEUED') await db.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
    await runNotificationBatch({ db, transport, limit: 200 });
  }
  throw new Error(`Target notification delivery was not attempted for event ${eventId}`);
}
async function processFirstEmailAttempt(eventId: string, userId: string, transport: NotificationTransport) {
  for (let index = 0; index < 20; index += 1) {
    const delivery = await db.notificationDelivery.findFirst({ where: { eventId, userId, channel: 'EMAIL' } });
    if (delivery?.attemptCount) return delivery;
    if (delivery?.status === 'QUEUED') await db.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
    await runEmailNotificationBatch({ db, transport, limit: 200 });
  }
  throw new Error(`Target email delivery was not attempted for event ${eventId}`);
}

describe('notification worker and administration', () => {
  it('sends safe publication email only to verified members who opted in', async () => {
    const target = await publication('FREE');
    const enabled = await account();
    const optedOut = await account();
    const unverified = await account();
    await db.notificationPreference.update({ where: { userId: optedOut.user.id }, data: { emailEnabled: false } });
    await db.user.update({ where: { id: unverified.user.id }, data: { emailVerifiedAt: null } });
    const sent: { recipient: string; text: string }[] = [];
    const transport: NotificationTransport = { async send(input) { sent.push({ recipient: input.recipient, text: input.message.text }); return { kind: 'SENT', providerMessageId: `email-${input.retryKey}` }; } };
    const delivery = await processFirstEmailAttempt(target.event.id, enabled.user.id, transport);
    expect(delivery).toMatchObject({ channel: 'EMAIL', status: 'SENT', attemptCount: 1 });
    expect(sent.some(item => item.recipient === enabled.user.email && item.text.includes(target.race.name))).toBe(true);
    expect(sent.find(item => item.recipient === enabled.user.email)?.text).not.toMatch(/買い目|本命|円/);
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: { in: [optedOut.user.id, unverified.user.id] }, channel: 'EMAIL' } })).toBe(0);
    expect(await db.notificationEvent.findUniqueOrThrow({ where: { id: target.event.id } })).toMatchObject({ emailExpandedAt: expect.any(Date) });
  });

  it('keeps email and LINE delivery expansion independent', async () => {
    const target = await publication('FREE'); const member = await recipient();
    await runNotificationBatch({ db, transport: new TestNotificationTransport(), limit: 200 });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: member.id, channel: 'LINE' } })).toBe(1);
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: member.id, channel: 'EMAIL' } })).toBe(0);
    await runEmailNotificationBatch({ db, transport: new TestNotificationTransport(), limit: 200 });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: member.id, channel: 'EMAIL' } })).toBe(1);
  });

  it('finalizes web-only events without creating delayed LINE deliveries', async () => {
    const target = await publication('FREE');
    const result = await skipPendingNotificationEvents(db, 200);
    expect(result).toMatchObject({ disabled: true, claimedDeliveries: 0, sent: 0 });
    expect(await db.notificationEvent.findUnique({ where: { id: target.event.id } })).toMatchObject({ status: 'SKIPPED', expandedAt: expect.any(Date) });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id } })).toBe(0);
    await runNotificationBatch({ db, transport: new TestNotificationTransport(), limit: 200 });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id } })).toBe(0);
  });

  it('publishes an append-only target-race announcement and sends it to free members', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const suffix = randomUUID().slice(0, 8);
    const race = await db.race.create({ data: { raceDate: '2098-08-01', venue: `告知${suffix}`, number: 3, name: `スマホ告知試験${suffix}`, startsAt: new Date('2098-08-01T15:00:00+09:00') } });
    const subject = `test:announcement-target:${randomUUID()}`; const member = await recipient(subject); const headers = { 'Idempotency-Key': randomUUID() };
    const first = await admin.call(`admin/races/${race.id}/announce`, 'POST', { reason: '対象レース決定の結合試験' }, undefined, headers);
    const repeated = await admin.call(`admin/races/${race.id}/announce`, 'POST', { reason: '対象レース決定の結合試験' }, undefined, headers);
    expect(first.status).toBe(201); expect(repeated.body).toEqual(first.body);
    expect(await db.raceAnnouncement.count({ where: { raceId: race.id } })).toBe(1);
    const announcement = await db.raceAnnouncement.findUniqueOrThrow({ where: { id: first.body.id } });
    await expect(db.raceAnnouncement.update({ where: { id: announcement.id }, data: { reason: '上書き' } })).rejects.toThrow();
    await expect(db.raceAnnouncement.delete({ where: { id: announcement.id } })).rejects.toThrow();
    const publicList = await new Client().call('announcements');
    expect(publicList.body.items.some((item: { id: string }) => item.id === announcement.id)).toBe(true);
    const messages: string[] = [];
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { announcementId: announcement.id } });
    const transport: NotificationTransport = { async send(input) { if (input.recipient === subject && input.targetId === announcement.id) messages.push(input.message.text); return { kind: 'SENT', providerMessageId: `announcement-${input.retryKey}` }; } };
    expect(await processFirstAttempt(event.id, member.id, transport)).toMatchObject({ status: 'SENT', attemptCount: 1 });
    expect(messages.some(message => message.includes('予想対象レースのお知らせ') && message.includes(race.name))).toBe(true);
  });

  it('keeps the outbox untouched while the emergency stop is active', async () => {
    const target = await publication('FREE');
    await db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: false } });
    const result = await runNotificationBatch({ db, transport: new TestNotificationTransport(), limit: 200 });
    expect(result).toMatchObject({ disabled: true, expandedEvents: 0, claimedDeliveries: 0 });
    expect(await db.notificationEvent.findUnique({ where: { id: target.event.id } })).toMatchObject({ status: 'QUEUED', expandedAt: null });
    await db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: true } });
  });

  it('expands and claims idempotently across concurrent workers', async () => {
    const target = await publication('FREE'); const subject = `test:concurrent-target:${randomUUID()}`; const member = await recipient(subject); let sends = 0; let message = '';
    let retryKey = ''; const transport: NotificationTransport = { async send(input) { if (input.recipient === subject && input.targetId === target.version.id) { sends += 1; message = input.message.text; retryKey = input.retryKey; } return { kind: 'SENT', providerMessageId: `concurrent-${input.retryKey}` }; } };
    await Promise.all([runNotificationBatch({ db, transport, limit: 200 }), runNotificationBatch({ db, transport, limit: 200 })]);
    await processFirstAttempt(target.event.id, member.id, transport);
    const deliveries = await db.notificationDelivery.findMany({ where: { eventId: target.event.id }, include: { attempts: true } });
    expect(deliveries.filter(item => item.userId === member.id)).toHaveLength(1);
    expect(deliveries.find(item => item.userId === member.id)).toMatchObject({ status: 'SENT', attemptCount: 1 });
    expect(deliveries.find(item => item.userId === member.id)?.attempts).toHaveLength(1);
    expect(sends).toBe(1);
    expect(message).toContain('内容は会員ページでご確認ください。');
    expect(message).not.toMatch(/買い目|本命|円/);
    expect(retryKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('filters paid recipients and rechecks preferences immediately before delivery', async () => {
    const target = await publication('PAID'); const entitled = await recipient(undefined, true); const excluded = await recipient();
    expect(await processFirstAttempt(target.event.id, entitled.id, new TestNotificationTransport())).toMatchObject({ status: 'SENT', attemptCount: 1 });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: excluded.id } })).toBe(0);

    const recheck = await publication('FREE');
    await db.notificationEvent.update({ where: { id: recheck.event.id }, data: { expandedAt: new Date() } });
    await db.notificationDelivery.create({ data: { eventId: recheck.event.id, userId: entitled.id, idempotencyKey: `recheck:${randomUUID()}`, nextAttemptAt: new Date(0) } });
    await db.notificationPreference.update({ where: { userId: entitled.id }, data: { predictions: false } });
    expect(await processFirstAttempt(recheck.event.id, entitled.id, new TestNotificationTransport())).toMatchObject({ status: 'SKIPPED', lastErrorCode: 'PREFERENCE_DISABLED' });
  });

  it('records transient failure, schedules a retry, then sends once', async () => {
    const target = await publication('PAID'); const subject = `test:retry-target:${randomUUID()}`; const member = await recipient(subject, true); let attempt = 0;
    const transport: NotificationTransport = { async send(input) { if (input.recipient !== subject) return { kind: 'SENT', providerMessageId: 'unrelated-test' }; attempt += 1; return attempt === 1 ? { kind: 'TRANSIENT_FAILURE', errorCode: 'TEMPORARY_TEST' } : { kind: 'SENT', providerMessageId: 'recovered-test' }; } };
    const delivery = await processFirstAttempt(target.event.id, member.id, transport);
    expect(delivery).toMatchObject({ status: 'QUEUED', attemptCount: 1, lastErrorCode: 'TEMPORARY_TEST' });
    await db.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
    await runNotificationBatch({ db, transport, limit: 200 });
    expect(await db.notificationDelivery.findUnique({ where: { id: delivery.id } })).toMatchObject({ status: 'SENT', attemptCount: 2, lastErrorCode: null });
    expect(await db.notificationAttempt.count({ where: { deliveryId: delivery.id } })).toBe(2);
  });

  it('lets authorized staff requeue failed delivery with an audited reason and protects attempt history', async () => {
    const target = await publication('PAID'); const member = await recipient(undefined, true);
    const delivery = await processFirstAttempt(target.event.id, member.id, { async send() { return { kind: 'PERMANENT_FAILURE', errorCode: 'INVALID_TEST_TARGET' }; } });
    const attempt = await db.notificationAttempt.findFirstOrThrow({ where: { deliveryId: delivery.id } });
    await expect(db.notificationAttempt.update({ where: { id: attempt.id }, data: { errorCode: 'overwrite' } })).rejects.toThrow();
    await expect(db.notificationAttempt.delete({ where: { id: attempt.id } })).rejects.toThrow();

    const admin = new Client(); await admin.login(await account('ADMIN')); expect((await admin.call('admin/notifications')).body.code).toBe('MFA_REQUIRED'); await admin.mfa();
    const listed = await admin.call('admin/notifications?status=FAILED&limit=50'); expect(listed.status).toBe(200); expect(listed.body.total).toBeGreaterThan(0); expect(listed.body.items.every((item: { status: string }) => item.status === 'FAILED')).toBe(true);
    const emailListed = await admin.call('admin/notifications?channel=EMAIL&limit=50'); expect(emailListed.status).toBe(200); expect(emailListed.body.items.every((item: { channel: string }) => item.channel === 'EMAIL')).toBe(true);
    const retried = await admin.call(`admin/notifications/${delivery.id}/retry`, 'POST', { reason: '試験用配送先を修正したため' });
    expect(retried.status).toBe(201); expect(retried.body).toMatchObject({ status: 'QUEUED', manualRetryCount: 1 });
    const retryAudit = await db.auditLog.findFirstOrThrow({ where: { action: 'NOTIFICATION_RETRY_REQUEST', targetId: delivery.id, reason: '試験用配送先を修正したため' }, orderBy: { createdAt: 'desc' } });
    expect(retryAudit.details).toMatchObject({ channel: 'LINE' });

    const expiredTarget = await publication('PAID'); const expiredMember = await recipient(undefined, true); const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.notificationEvent.update({ where: { id: expiredTarget.event.id }, data: { expandedAt: new Date(), status: 'FAILED' } });
    const expired = await db.notificationDelivery.create({ data: { eventId: expiredTarget.event.id, userId: expiredMember.id, idempotencyKey: `expired:${randomUUID()}`, status: 'FAILED', attemptCount: 1, lastErrorCode: 'LINE_TIMEOUT' } });
    await db.notificationAttempt.create({ data: { deliveryId: expired.id, attemptNumber: 1, outcome: 'TRANSIENT_FAILURE', errorCode: 'LINE_TIMEOUT', startedAt: old, finishedAt: old } });
    const rejected = await admin.call(`admin/notifications/${expired.id}/retry`, 'POST', { reason: '24時間経過後の再送確認' });
    expect(rejected.status).toBe(400); expect(rejected.body.code).toBe('NOTIFICATION_RETRY_WINDOW_EXPIRED');
  });
});
