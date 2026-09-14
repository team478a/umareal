import { randomUUID } from 'node:crypto';
import { buildPredictionLineMessage, notificationIdempotencyKey, retryDelayMs } from '@keiba/domain';
import type { LineTextMessage } from '@keiba/domain';
import { PrismaClient } from '@keiba/db';

export type DeliveryOutcome =
  | { kind: 'SENT'; providerMessageId: string }
  | { kind: 'TRANSIENT_FAILURE'; errorCode: string }
  | { kind: 'PERMANENT_FAILURE'; errorCode: string };

export interface NotificationTransport {
  send(input: { recipient: string; idempotencyKey: string; retryKey: string; eventType: string; targetId: string; raceId: string; message: LineTextMessage }): Promise<DeliveryOutcome>;
}

export class TestNotificationTransport implements NotificationTransport {
  async send(input: { recipient: string; idempotencyKey: string }): Promise<DeliveryOutcome> {
    if (input.recipient.startsWith('test:permanent')) return { kind: 'PERMANENT_FAILURE', errorCode: 'TEST_RECIPIENT_REJECTED' };
    if (input.recipient.startsWith('test:transient')) return { kind: 'TRANSIENT_FAILURE', errorCode: 'TEST_PROVIDER_UNAVAILABLE' };
    return { kind: 'SENT', providerMessageId: `test-${input.idempotencyKey.slice(-24)}` };
  }
}

export type BatchResult = { disabled: boolean; expandedEvents: number; claimedDeliveries: number; sent: number; retried: number; failed: number; skipped: number };

async function refreshEventStatus(db: PrismaClient, eventId: string) {
  const deliveries = await db.notificationDelivery.findMany({ where: { eventId }, select: { status: true, attemptCount: true } });
  let status = 'QUEUED';
  if (!deliveries.length) status = 'SKIPPED';
  else if (deliveries.some(item => item.status === 'SENDING')) status = 'SENDING';
  else if (deliveries.some(item => item.status === 'QUEUED')) status = deliveries.some(item => item.attemptCount > 0) ? 'RETRIED' : 'QUEUED';
  else if (deliveries.some(item => item.status === 'FAILED')) status = 'FAILED';
  else if (deliveries.some(item => item.status === 'SENT')) status = 'SENT';
  else status = 'SKIPPED';
  await db.notificationEvent.update({ where: { id: eventId }, data: { status, updatedAt: new Date() } });
}

async function expandEvents(db: PrismaClient, limit: number) {
  const candidates = await db.notificationEvent.findMany({ where: { expandedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true } });
  let expanded = 0;
  for (const candidate of candidates) {
    const didExpand = await db.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM notification_events WHERE id = ${candidate.id}::uuid AND "expandedAt" IS NULL FOR UPDATE`;
      if (!locked.length) return false;
      const event = await tx.notificationEvent.findUniqueOrThrow({ where: { id: candidate.id }, include: { version: { include: { prediction: { include: { race: true } } } }, announcement: { include: { race: true } }, freeReportVersion: { include: { race: true } } } });
      const race = event.version?.prediction.race ?? event.announcement?.race ?? event.freeReportVersion?.race;
      if (!race) throw new Error('Notification event target is missing');
      const preference = event.eventType === 'PREDICTION_CORRECTED' ? { changes: true } : { predictions: true };
      const now = new Date();
      const paidFilter = event.version?.visibility === 'PAID' ? { entitlements: { some: { revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now }, OR: [{ raceDate: null }, { raceDate: race.raceDate }] } } } : {};
      const recipients = await tx.user.findMany({ where: { disabledAt: null, lineAccount: { is: { notificationDisabledAt: null, unlinkedAt: null } }, preferences: { is: preference }, ...paidFilter }, select: { id: true } });
      const targetVersion = event.version?.version ?? event.announcement?.version ?? event.freeReportVersion!.version;
      if (recipients.length) await tx.notificationDelivery.createMany({ data: recipients.map(recipient => ({ eventId: event.id, userId: recipient.id, channel: 'LINE', idempotencyKey: notificationIdempotencyKey({ eventType: event.eventType, targetId: race.id, recipientId: recipient.id, version: targetVersion }) })), skipDuplicates: true });
      await tx.notificationEvent.update({ where: { id: event.id }, data: { expandedAt: now, updatedAt: now, status: recipients.length ? 'QUEUED' : 'SKIPPED' } });
      return true;
    });
    if (didExpand) expanded += 1;
  }
  return expanded;
}

async function claimDeliveries(db: PrismaClient, limit: number) {
  const leaseToken = randomUUID();
  const staleAt = new Date(Date.now() - 5 * 60_000);
  const now = new Date();
  const ids = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM notification_deliveries WHERE ((status = 'QUEUED' AND "nextAttemptAt" <= ${now}) OR (status = 'SENDING' AND "lockedAt" < ${staleAt})) ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
    if (rows.length) await tx.notificationDelivery.updateMany({ where: { id: { in: rows.map(row => row.id) } }, data: { status: 'SENDING', leaseToken, lockedAt: now, updatedAt: now } });
    return rows.map(row => row.id);
  });
  return { ids, leaseToken };
}

export async function runNotificationBatch(input: { db: PrismaClient; transport?: NotificationTransport; limit?: number; now?: () => Date }): Promise<BatchResult> {
  const { db } = input;
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const now = input.now ?? (() => new Date());
  const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
  const result: BatchResult = { disabled: !settings.lineNotificationsEnabled, expandedEvents: 0, claimedDeliveries: 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  if (result.disabled) return result;
  const transport = input.transport ?? new TestNotificationTransport();
  result.expandedEvents = await expandEvents(db, limit);
  const claim = await claimDeliveries(db, limit);
  result.claimedDeliveries = claim.ids.length;

  for (const id of claim.ids) {
    const startedAt = now();
    const delivery = await db.notificationDelivery.findFirst({ where: { id, leaseToken: claim.leaseToken, status: 'SENDING' }, include: { attempts: { orderBy: { attemptNumber: 'asc' }, take: 1 }, user: { include: { lineAccount: true, preferences: true, entitlements: true } }, event: { include: { version: { include: { prediction: { include: { race: true } } } }, announcement: { include: { race: true } }, freeReportVersion: { include: { race: true } } } } } });
    if (!delivery) continue;
    const version = delivery.event.version;
    const announcement = delivery.event.announcement;
    const freeReport = delivery.event.freeReportVersion;
    const race = version?.prediction.race ?? announcement?.race ?? freeReport?.race;
    if (!race) throw new Error('Notification event target is missing');
    const preferenceEnabled = delivery.event.eventType === 'PREDICTION_CORRECTED' ? delivery.user.preferences?.changes !== false : delivery.user.preferences?.predictions !== false;
    const entitlementActive = !version || version.visibility === 'FREE' || delivery.user.entitlements.some(item => !item.revokedAt && item.startsAt <= startedAt && item.endsAt > startedAt && (!item.raceDate || item.raceDate === race.raceDate));
    const skipCode = delivery.user.disabledAt ? 'USER_DISABLED' : !delivery.user.lineAccount || delivery.user.lineAccount.unlinkedAt ? 'LINE_UNLINKED' : delivery.user.lineAccount.notificationDisabledAt ? 'LINE_BLOCKED' : !preferenceEnabled ? 'PREFERENCE_DISABLED' : !entitlementActive ? 'ENTITLEMENT_INACTIVE' : null;
    const attemptNumber = delivery.attemptCount + 1;
    if (skipCode) {
      await db.$transaction([db.notificationAttempt.create({ data: { deliveryId: id, attemptNumber, outcome: 'SKIPPED', errorCode: skipCode, startedAt, finishedAt: now() } }), db.notificationDelivery.update({ where: { id }, data: { status: 'SKIPPED', attemptCount: attemptNumber, forceAttempt: false, lastErrorCode: skipCode, lockedAt: null, leaseToken: null, updatedAt: now() } })]);
      result.skipped += 1;
      await refreshEventStatus(db, delivery.eventId);
      continue;
    }
    if (delivery.attemptCount >= settings.notificationMaxAttempts && !delivery.forceAttempt) {
      await db.notificationDelivery.update({ where: { id }, data: { status: 'FAILED', lastErrorCode: 'ATTEMPT_LIMIT_REACHED', lockedAt: null, leaseToken: null, updatedAt: now() } });
      result.failed += 1;
      await refreshEventStatus(db, delivery.eventId);
      continue;
    }
    const firstAttemptAt = delivery.attempts[0]?.startedAt ?? startedAt;
    if (delivery.attemptCount > 0 && startedAt.getTime() - firstAttemptAt.getTime() >= 24 * 60 * 60 * 1000) {
      await db.notificationDelivery.update({ where: { id }, data: { status: 'FAILED', forceAttempt: false, lastErrorCode: 'LINE_RETRY_WINDOW_EXPIRED', lockedAt: null, leaseToken: null, updatedAt: now() } });
      result.failed += 1;
      await refreshEventStatus(db, delivery.eventId);
      continue;
    }
    const message = buildPredictionLineMessage({ eventType: delivery.event.eventType as 'PREDICTION_PUBLISHED' | 'PREDICTION_CORRECTED' | 'RACE_ANNOUNCED' | 'FREE_REPORT_PUBLISHED' | 'FREE_REPORT_REVIEW_PUBLISHED', raceId: race.id, raceDate: race.raceDate, venue: race.venue, raceNumber: race.number, raceName: race.name, version: version?.version ?? announcement?.version ?? freeReport!.version, visibility: (version?.visibility ?? 'FREE') as 'FREE' | 'PAID', appBaseUrl: process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000' });
    const outcome = await transport.send({ recipient: delivery.user.lineAccount!.subject, idempotencyKey: delivery.idempotencyKey, retryKey: delivery.id, eventType: delivery.event.eventType, targetId: version?.id ?? announcement?.id ?? freeReport!.id, raceId: race.id, message });
    const finishedAt = now();
    const nextAttemptCount = delivery.attemptCount + 1;
    if (outcome.kind === 'SENT') {
      await db.$transaction([db.notificationAttempt.create({ data: { deliveryId: id, attemptNumber, outcome: 'SENT', providerMessageId: outcome.providerMessageId, startedAt, finishedAt } }), db.notificationDelivery.update({ where: { id }, data: { status: 'SENT', attemptCount: nextAttemptCount, forceAttempt: false, lastErrorCode: null, sentAt: finishedAt, lockedAt: null, leaseToken: null, updatedAt: finishedAt } })]);
      result.sent += 1;
    } else {
      const proposedNextAttempt = new Date(finishedAt.getTime() + retryDelayMs(settings.notificationBaseDelaySeconds, nextAttemptCount));
      const withinRetryWindow = proposedNextAttempt.getTime() - firstAttemptAt.getTime() < 24 * 60 * 60 * 1000;
      const retry = outcome.kind === 'TRANSIENT_FAILURE' && nextAttemptCount < settings.notificationMaxAttempts && withinRetryWindow;
      const lastErrorCode = outcome.kind === 'TRANSIENT_FAILURE' && !withinRetryWindow ? 'LINE_RETRY_WINDOW_EXPIRED' : outcome.errorCode;
      await db.$transaction([db.notificationAttempt.create({ data: { deliveryId: id, attemptNumber, outcome: outcome.kind, errorCode: outcome.errorCode, startedAt, finishedAt } }), db.notificationDelivery.update({ where: { id }, data: { status: retry ? 'QUEUED' : 'FAILED', attemptCount: nextAttemptCount, forceAttempt: false, lastErrorCode, nextAttemptAt: retry ? proposedNextAttempt : finishedAt, lockedAt: null, leaseToken: null, updatedAt: finishedAt } })]);
      if (retry) result.retried += 1; else result.failed += 1;
    }
    await refreshEventStatus(db, delivery.eventId);
  }
  return result;
}
