import { randomUUID } from 'node:crypto';
import { buildBillingLineMessage, buildPredictionLineMessage, buildRaceResultLineMessage, buildSupportReplyLineMessage, buildWin5LineMessage, buildWin5ResultLineMessage, notificationIdempotencyKey, retryDelayMs } from '@keiba/domain';
import type { LineTextMessage } from '@keiba/domain';
import { notificationRecipientWhere, PrismaClient } from '@keiba/db';

export type DeliveryChannel = 'LINE' | 'EMAIL';
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

/** Marks the LINE side of pending events as handled when LINE is outside the launch mode. */
export async function skipPendingNotificationEvents(db: PrismaClient, limit = 100): Promise<BatchResult> {
  const candidates = await db.notificationEvent.findMany({ where: { expandedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true } });
  let skipped = 0;
  for (const candidate of candidates) {
    const now = new Date();
    const changed = await db.notificationEvent.updateMany({ where: { id: candidate.id, expandedAt: null }, data: { expandedAt: now, updatedAt: now } });
    skipped += changed.count;
    if (changed.count) await refreshEventStatus(db, candidate.id);
  }
  return { disabled: true, expandedEvents: skipped, claimedDeliveries: 0, sent: 0, retried: 0, failed: 0, skipped };
}

async function refreshEventStatus(db: PrismaClient, eventId: string) {
  const deliveries = await db.notificationDelivery.groupBy({ by: ['status'], where: { eventId }, _count: { _all: true } });
  const statuses = new Set(deliveries.map(item => item.status));
  let status = 'QUEUED';
  if (!deliveries.length) status = 'SKIPPED';
  else if (statuses.has('SENDING')) status = 'SENDING';
  else if (statuses.has('QUEUED')) status = await db.notificationDelivery.count({ where: { eventId, status: 'QUEUED', attemptCount: { gt: 0 } } }) ? 'RETRIED' : 'QUEUED';
  else if (statuses.has('FAILED')) status = 'FAILED';
  else if (statuses.has('SENT')) status = 'SENT';
  else status = 'SKIPPED';
  await db.notificationEvent.update({ where: { id: eventId }, data: { status, updatedAt: new Date() } });
}

async function expandEvents(db: PrismaClient, limit: number, channel: DeliveryChannel, eventId?: string) {
  const marker = channel === 'LINE' ? 'expandedAt' : 'emailExpandedAt';
  const candidates = await db.notificationEvent.findMany({ where: { [marker]: null, ...(eventId ? { id: eventId } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true } });
  let expanded = 0;
  for (const candidate of candidates) {
    const didExpand = await db.$transaction(async tx => {
      const locked = channel === 'LINE'
        ? await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM notification_events WHERE id = ${candidate.id}::uuid AND "expandedAt" IS NULL FOR UPDATE`
        : await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM notification_events WHERE id = ${candidate.id}::uuid AND "emailExpandedAt" IS NULL FOR UPDATE`;
      if (!locked.length) return false;
      const event = await tx.notificationEvent.findUniqueOrThrow({ where: { id: candidate.id }, include: { version: { include: { prediction: { include: { race: true } } } }, announcement: { include: { race: true } }, freeReportVersion: { include: { race: true } }, productVersion: { include: { product: { include: { races: { orderBy: { legNumber: 'asc' }, include: { race: true } } } } } }, raceResultVersion: { include: { race: true } }, win5EvaluationVersion: { include: { product: { include: { races: { orderBy: { legNumber: 'asc' }, include: { race: true } } } } } }, supportEvent: { include: { request: true } }, billingEvent: true } });
      const race = event.version?.prediction.race ?? event.announcement?.race ?? event.freeReportVersion?.race ?? event.productVersion?.product.races[0]?.race ?? event.raceResultVersion?.race ?? event.win5EvaluationVersion?.product.races[0]?.race;
      if (!race && !event.supportEvent && !event.billingEvent) throw new Error('Notification event target is missing');
      const now = new Date();
      const recipients = event.billingEvent
        ? [{ id: event.billingEvent.userId }]
        : event.supportEvent
        ? [{ id: event.supportEvent.request.userId }]
        : await tx.user.findMany({ where: notificationRecipientWhere({ channel, eventType: event.eventType, visibility: event.productVersion ? 'FREE' : (event.version?.visibility ?? 'FREE') as 'FREE' | 'PAID', raceDate: event.productVersion?.product.targetDate ?? event.win5EvaluationVersion?.product.targetDate ?? race!.raceDate, now }), select: { id: true } });
      const targetVersion = event.version?.version ?? event.announcement?.version ?? event.freeReportVersion?.version ?? event.productVersion?.version ?? event.raceResultVersion?.version ?? event.win5EvaluationVersion?.version ?? 1;
      const targetId = event.billingEvent?.id ?? event.supportEvent?.id ?? event.productVersion?.id ?? event.raceResultVersion?.id ?? event.win5EvaluationVersion?.id ?? race!.id;
      if (recipients.length) await tx.notificationDelivery.createMany({ data: recipients.map(recipient => ({ eventId: event.id, userId: recipient.id, channel, idempotencyKey: notificationIdempotencyKey({ eventType: event.eventType, targetId, recipientId: recipient.id, version: targetVersion, channel }) })), skipDuplicates: true });
      await tx.notificationEvent.update({ where: { id: event.id }, data: { [marker]: now, updatedAt: now } });
      return true;
    });
    if (didExpand) {
      expanded += 1;
      await refreshEventStatus(db, candidate.id);
    }
  }
  return expanded;
}

async function claimDeliveries(db: PrismaClient, channel: DeliveryChannel, limit: number, eventId?: string) {
  const leaseToken = randomUUID();
  const staleAt = new Date(Date.now() - 5 * 60_000);
  const now = new Date();
  const ids = await db.$transaction(async tx => {
    const rows = eventId
      ? await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM notification_deliveries WHERE channel = ${channel} AND "eventId" = ${eventId}::uuid AND ((status = 'QUEUED' AND "nextAttemptAt" <= ${now}) OR (status = 'SENDING' AND "lockedAt" < ${staleAt})) ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT ${limit}`
      : await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM notification_deliveries WHERE channel = ${channel} AND ((status = 'QUEUED' AND "nextAttemptAt" <= ${now}) OR (status = 'SENDING' AND "lockedAt" < ${staleAt})) ORDER BY "nextAttemptAt", id FOR UPDATE SKIP LOCKED LIMIT ${limit}`;
    if (rows.length) await tx.notificationDelivery.updateMany({ where: { id: { in: rows.map(row => row.id) } }, data: { status: 'SENDING', leaseToken, lockedAt: now, updatedAt: now } });
    return rows.map(row => row.id);
  });
  return { ids, leaseToken };
}

async function runChannelBatch(input: { db: PrismaClient; channel: DeliveryChannel; transport?: NotificationTransport; limit?: number; now?: () => Date; eventId?: string }): Promise<BatchResult> {
  const { db, channel } = input;
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const now = input.now ?? (() => new Date());
  const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
  const enabled = channel === 'LINE' ? settings.lineNotificationsEnabled : settings.emailNotificationsEnabled;
  const result: BatchResult = { disabled: !enabled, expandedEvents: 0, claimedDeliveries: 0, sent: 0, retried: 0, failed: 0, skipped: 0 };
  if (result.disabled) return result;
  const transport = input.transport ?? new TestNotificationTransport();
  result.expandedEvents = await expandEvents(db, limit, channel, input.eventId);
  const claim = await claimDeliveries(db, channel, limit, input.eventId);
  result.claimedDeliveries = claim.ids.length;
  const touchedEvents = new Set<string>();

  const concurrency = 8;
  for (let offset = 0; offset < claim.ids.length; offset += concurrency) {
    await Promise.all(claim.ids.slice(offset, offset + concurrency).map(async id => {
    const startedAt = now();
    const delivery = await db.notificationDelivery.findFirst({
      where: { id, channel, leaseToken: claim.leaseToken, status: 'SENDING' },
      include: {
        attempts: { orderBy: { attemptNumber: 'asc' }, take: 1 },
        user: { include: { lineAccount: true, preferences: true, entitlements: true } },
        event: {
          include: {
            version: { include: { prediction: { include: { race: true } } } },
            announcement: { include: { race: true } },
            freeReportVersion: { include: { race: true } },
            productVersion: { include: { product: { include: { races: { orderBy: { legNumber: 'asc' }, include: { race: true } } } } } },
            raceResultVersion: { include: { race: true, predictionEvaluations: { include: { predictionVersion: { select: { version: true } } } } } },
            win5EvaluationVersion: { include: { product: { include: { races: { orderBy: { legNumber: 'asc' }, include: { race: true } } } } } },
            supportEvent: { include: { request: true } },
            billingEvent: { include: { subscription: true, dayPass: true, billingCheckout: true } }
          }
        }
      }
    });
    if (!delivery) return;
    touchedEvents.add(delivery.eventId);
    const stillEnabled = channel === 'LINE'
      ? (await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineNotificationsEnabled: true } })).lineNotificationsEnabled
      : (await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { emailNotificationsEnabled: true } })).emailNotificationsEnabled;
    if (!stillEnabled) {
      await db.notificationDelivery.updateMany({ where: { id, leaseToken: claim.leaseToken, status: 'SENDING' }, data: { status: 'QUEUED', lockedAt: null, leaseToken: null, updatedAt: now() } });
      return;
    }
    const version = delivery.event.version;
    const announcement = delivery.event.announcement;
    const freeReport = delivery.event.freeReportVersion;
    const productVersion = delivery.event.productVersion;
    const raceResultVersion = delivery.event.raceResultVersion;
    const win5EvaluationVersion = delivery.event.win5EvaluationVersion;
    const supportEvent = delivery.event.supportEvent;
    const billingEvent = delivery.event.billingEvent;
    const race = version?.prediction.race ?? announcement?.race ?? freeReport?.race ?? productVersion?.product.races[0]?.race ?? raceResultVersion?.race ?? win5EvaluationVersion?.product.races[0]?.race;
    if (!race && !supportEvent && !billingEvent) throw new Error('Notification event target is missing');
    const preferenceEnabled = supportEvent ? true : billingEvent ? delivery.user.preferences?.billing !== false : ['PREDICTION_CORRECTED', 'WIN5_PREVIEW_CORRECTED'].includes(delivery.event.eventType) ? delivery.user.preferences?.changes !== false : delivery.user.preferences?.predictions !== false;
    const entitlementActive = !!supportEvent || !!billingEvent || !!productVersion || !version || version.visibility === 'FREE' || delivery.user.entitlements.some(item => !item.revokedAt && item.startsAt <= startedAt && item.endsAt > startedAt && (!item.raceDate || item.raceDate === race!.raceDate));
    const channelSkipCode = channel === 'LINE'
      ? !delivery.user.lineAccount || delivery.user.lineAccount.unlinkedAt ? 'LINE_UNLINKED' : delivery.user.lineAccount.notificationDisabledAt ? 'LINE_BLOCKED' : null
      : !delivery.user.email ? 'EMAIL_MISSING' : !delivery.user.emailVerifiedAt ? 'EMAIL_UNVERIFIED' : delivery.user.emailDeliveryDisabledAt ? 'EMAIL_BLOCKED' : delivery.user.preferences?.emailEnabled === false ? 'EMAIL_DISABLED' : null;
    const skipCode = delivery.user.disabledAt ? 'USER_DISABLED' : channelSkipCode ?? (!preferenceEnabled ? 'PREFERENCE_DISABLED' : !entitlementActive ? 'ENTITLEMENT_INACTIVE' : null);
    const attemptNumber = delivery.attemptCount + 1;
    if (skipCode) {
      await db.$transaction([db.notificationAttempt.create({ data: { deliveryId: id, attemptNumber, outcome: 'SKIPPED', errorCode: skipCode, startedAt, finishedAt: now() } }), db.notificationDelivery.update({ where: { id }, data: { status: 'SKIPPED', attemptCount: attemptNumber, forceAttempt: false, lastErrorCode: skipCode, lockedAt: null, leaseToken: null, updatedAt: now() } })]);
      result.skipped += 1;
      return;
    }
    if (delivery.attemptCount >= settings.notificationMaxAttempts && !delivery.forceAttempt) {
      await db.notificationDelivery.update({ where: { id }, data: { status: 'FAILED', lastErrorCode: 'ATTEMPT_LIMIT_REACHED', lockedAt: null, leaseToken: null, updatedAt: now() } });
      result.failed += 1;
      return;
    }
    const firstAttemptAt = delivery.attempts[0]?.startedAt ?? startedAt;
    if (delivery.attemptCount > 0 && startedAt.getTime() - firstAttemptAt.getTime() >= 24 * 60 * 60 * 1000) {
      await db.notificationDelivery.update({ where: { id }, data: { status: 'FAILED', forceAttempt: false, lastErrorCode: 'RETRY_WINDOW_EXPIRED', lockedAt: null, leaseToken: null, updatedAt: now() } });
      result.failed += 1;
      return;
    }
    const appBaseUrl = process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000';
    const latestRaceEvaluation = raceResultVersion?.predictionEvaluations.sort((a, b) => b.predictionVersion.version - a.predictionVersion.version)[0];
    let message: LineTextMessage;
    if (billingEvent) {
      const eventType = ({
        BILLING_PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED', BILLING_PAYMENT_FAILED: 'PAYMENT_FAILED', BILLING_PAYMENT_RECOVERED: 'PAYMENT_RECOVERED',
        BILLING_CANCELLATION_SCHEDULED: 'CANCELLATION_SCHEDULED', BILLING_CANCELLATION_REVERSED: 'CANCELLATION_REVERSED',
        BILLING_SUBSCRIPTION_ENDED: 'SUBSCRIPTION_ENDED', BILLING_REFUND_COMPLETED: 'REFUND_COMPLETED'
      } as const)[delivery.event.eventType as 'BILLING_PAYMENT_SUCCEEDED' | 'BILLING_PAYMENT_FAILED' | 'BILLING_PAYMENT_RECOVERED' | 'BILLING_CANCELLATION_SCHEDULED' | 'BILLING_CANCELLATION_REVERSED' | 'BILLING_SUBSCRIPTION_ENDED' | 'BILLING_REFUND_COMPLETED'];
      if (!eventType) throw new Error('Billing notification event type is invalid');
      message = buildBillingLineMessage({ eventType, planCode: (billingEvent.subscription?.planCode ?? billingEvent.billingCheckout?.planCode ?? 'DAY_PASS') as 'FOUNDER' | 'STANDARD' | 'DAY_PASS', currentPeriodEndsAt: billingEvent.subscription?.currentPeriodEndsAt ?? billingEvent.dayPass?.endsAt ?? billingEvent.billingCheckout!.completedAt!, appBaseUrl });
    } else if (supportEvent) {
      message = buildSupportReplyLineMessage({ eventType: 'SUPPORT_RESPONSE_POSTED', requestId: supportEvent.requestId, appBaseUrl });
    } else if (win5EvaluationVersion) {
      message = buildWin5ResultLineMessage({ eventType: 'WIN5_EVALUATION_CONFIRMED', productId: win5EvaluationVersion.productId, targetDate: win5EvaluationVersion.product.targetDate, title: win5EvaluationVersion.product.title, resultVersion: win5EvaluationVersion.version, status: win5EvaluationVersion.status as 'WIN5_ALL_WINNERS_RECOMMENDED' | 'WIN5_PARTIAL' | 'WIN5_MISSED', recommendedLegs: win5EvaluationVersion.recommendedLegs, appBaseUrl });
    } else if (raceResultVersion) {
      if (!latestRaceEvaluation) throw new Error('Race evaluation result notification target has no evaluation');
      message = buildRaceResultLineMessage({ eventType: 'RACE_EVALUATION_CONFIRMED', raceId: race!.id, raceDate: race!.raceDate, venue: race!.venue, raceNumber: race!.number, raceName: race!.name, resultVersion: raceResultVersion.version, status: latestRaceEvaluation.status as 'PRIMARY_WIN' | 'PRIMARY_TOP2' | 'PRIMARY_TOP3' | 'WINNER_IN_RECOMMENDED' | 'WINNER_NOT_RECOMMENDED' | 'SKIPPED' | 'EXCLUDED' | 'CANCELED', appBaseUrl });
    } else if (productVersion) {
      message = buildWin5LineMessage({ eventType: delivery.event.eventType as 'WIN5_PREVIEW_PUBLISHED' | 'WIN5_PREVIEW_CORRECTED', productId: productVersion.productId, targetDate: productVersion.product.targetDate, title: productVersion.product.title, version: productVersion.version, appBaseUrl });
    } else {
      message = buildPredictionLineMessage({ eventType: delivery.event.eventType as 'PREDICTION_PUBLISHED' | 'PREDICTION_CORRECTED' | 'RACE_ANNOUNCED' | 'FREE_REPORT_PUBLISHED' | 'FREE_REPORT_REVIEW_PUBLISHED', raceId: race!.id, raceDate: race!.raceDate, venue: race!.venue, raceNumber: race!.number, raceName: race!.name, version: version?.version ?? announcement?.version ?? freeReport!.version, visibility: (version?.visibility ?? 'FREE') as 'FREE' | 'PAID', appBaseUrl });
    }
    const recipient = channel === 'LINE' ? delivery.user.lineAccount!.subject : delivery.user.email!;
    const targetId = billingEvent?.id ?? supportEvent?.id ?? version?.id ?? announcement?.id ?? freeReport?.id ?? productVersion?.id ?? raceResultVersion?.id ?? win5EvaluationVersion!.id;
    const outcome = await transport.send({ recipient, idempotencyKey: delivery.idempotencyKey, retryKey: delivery.id, eventType: delivery.event.eventType, targetId, raceId: race?.id ?? supportEvent?.requestId ?? billingEvent!.id, message });
    const finishedAt = now();
    const nextAttemptCount = delivery.attemptCount + 1;
    if (outcome.kind === 'SENT') {
      await db.$transaction([db.notificationAttempt.create({ data: { deliveryId: id, attemptNumber, outcome: 'SENT', providerMessageId: outcome.providerMessageId, startedAt, finishedAt } }), db.notificationDelivery.update({ where: { id }, data: { status: 'SENT', attemptCount: nextAttemptCount, forceAttempt: false, lastErrorCode: null, sentAt: finishedAt, lockedAt: null, leaseToken: null, updatedAt: finishedAt } })]);
      result.sent += 1;
    } else {
      const proposedNextAttempt = new Date(finishedAt.getTime() + retryDelayMs(settings.notificationBaseDelaySeconds, nextAttemptCount));
      const withinRetryWindow = proposedNextAttempt.getTime() - firstAttemptAt.getTime() < 24 * 60 * 60 * 1000;
      const retry = outcome.kind === 'TRANSIENT_FAILURE' && nextAttemptCount < settings.notificationMaxAttempts && withinRetryWindow;
      const lastErrorCode = outcome.kind === 'TRANSIENT_FAILURE' && !withinRetryWindow ? 'RETRY_WINDOW_EXPIRED' : outcome.errorCode;
      await db.$transaction([db.notificationAttempt.create({ data: { deliveryId: id, attemptNumber, outcome: outcome.kind, errorCode: outcome.errorCode, startedAt, finishedAt } }), db.notificationDelivery.update({ where: { id }, data: { status: retry ? 'QUEUED' : 'FAILED', attemptCount: nextAttemptCount, forceAttempt: false, lastErrorCode, nextAttemptAt: retry ? proposedNextAttempt : finishedAt, lockedAt: null, leaseToken: null, updatedAt: finishedAt } })]);
      if (retry) result.retried += 1; else result.failed += 1;
    }
    }));
  }
  for (const eventId of touchedEvents) await refreshEventStatus(db, eventId);
  return result;
}

export async function runNotificationBatch(input: { db: PrismaClient; transport?: NotificationTransport; limit?: number; now?: () => Date; eventId?: string }): Promise<BatchResult> {
  return runChannelBatch({ ...input, channel: 'LINE' });
}

export async function runEmailNotificationBatch(input: { db: PrismaClient; transport?: NotificationTransport; limit?: number; now?: () => Date; eventId?: string }): Promise<BatchResult> {
  return runChannelBatch({ ...input, channel: 'EMAIL' });
}
