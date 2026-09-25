import { randomUUID } from 'node:crypto';
import { retryDelayMs } from '@keiba/domain';
import { Prisma, PrismaClient } from '@keiba/db';

type Severity = 'CRITICAL' | 'WARNING';
type AlertCandidate = { dedupeKey: string; code: string; severity: Severity; sourceType: string; sourceId: string; title: string; summary: string };
export type OperationalAlertOutcome =
  | { kind: 'SENT'; providerMessageId: string }
  | { kind: 'TRANSIENT_FAILURE'; errorCode: string }
  | { kind: 'PERMANENT_FAILURE'; errorCode: string };

export interface OperationalAlertTransport {
  send(input: { recipient: string; retryKey: string; severity: Severity; code: string; title: string; text: string }): Promise<OperationalAlertOutcome>;
}

export class TestOperationalAlertTransport implements OperationalAlertTransport {
  async send(input: { retryKey: string }): Promise<OperationalAlertOutcome> {
    return { kind: 'SENT', providerMessageId: `test-alert-${input.retryKey.slice(-24)}` };
  }
}

async function candidates(db: PrismaClient, now: Date): Promise<AlertCandidate[]> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const dueSoon = new Date(now.getTime() + 24 * 60 * 60_000);
  const [failedDeliveries, failedSchedules, missedRaces, supportDeadlines] = await Promise.all([
    db.$queryRaw<Array<{ id: string; channel: string; eventType: string }>>(Prisma.sql`SELECT d.id, d.channel, e."eventType" FROM notification_deliveries d JOIN notification_events e ON e.id = d."eventId" WHERE d.status = 'FAILED' AND NOT EXISTS (SELECT 1 FROM operational_alerts a WHERE a."dedupeKey" = 'DELIVERY_FAILED:' || d.id::text) ORDER BY d."updatedAt" DESC, d.id LIMIT 200`),
    db.$queryRaw<Array<{ id: string; kind: string; raceDate: string; venue: string; number: number }>>(Prisma.sql`SELECT s.id, s.kind, r."raceDate", r.venue, r.number FROM publication_schedules s JOIN races r ON r.id = s."raceId" WHERE s.status = 'FAILED' AND NOT EXISTS (SELECT 1 FROM operational_alerts a WHERE a."dedupeKey" = 'PUBLICATION_SCHEDULE_FAILED:' || s.id::text) ORDER BY s."processedAt" DESC, s.id LIMIT 200`),
    db.$queryRaw<Array<{ id: string; raceDate: string; venue: string; number: number }>>(Prisma.sql`SELECT r.id, r."raceDate", r.venue, r.number FROM races r LEFT JOIN predictions p ON p."raceId" = r.id WHERE r."startsAt" > ${since} AND r."startsAt" <= ${now} AND r.status <> 'CANCELLED' AND NOT EXISTS (SELECT 1 FROM prediction_versions v WHERE v."predictionId" = p.id) AND NOT EXISTS (SELECT 1 FROM operational_alerts a WHERE a."dedupeKey" = 'PUBLICATION_DEADLINE_MISSED:' || r.id::text) ORDER BY r."startsAt" DESC, r.id LIMIT 200`),
    db.$queryRaw<Array<{ id: string; dueAt: Date }>>(Prisma.sql`SELECT id, "dueAt" FROM support_requests WHERE status <> 'RESOLVED' AND "dueAt" IS NOT NULL AND "dueAt" <= ${dueSoon} ORDER BY "dueAt", id LIMIT 200`)
  ]);
  return [
    ...failedDeliveries.map(item => ({ dedupeKey: `DELIVERY_FAILED:${item.id}`, code: 'DELIVERY_FAILED', severity: 'WARNING' as const, sourceType: 'NOTIFICATION_DELIVERY', sourceId: item.id, title: '会員通知の送信に失敗', summary: `${item.channel}の${item.eventType}通知が最終失敗になりました。` })),
    ...failedSchedules.map(item => ({ dedupeKey: `PUBLICATION_SCHEDULE_FAILED:${item.id}`, code: 'PUBLICATION_SCHEDULE_FAILED', severity: 'CRITICAL' as const, sourceType: 'PUBLICATION_SCHEDULE', sourceId: item.id, title: '予約公開に失敗', summary: `${item.raceDate} ${item.venue} ${item.number}Rの${item.kind}予約が失敗しました。` })),
    ...missedRaces.map(item => ({ dedupeKey: `PUBLICATION_DEADLINE_MISSED:${item.id}`, code: 'PUBLICATION_DEADLINE_MISSED', severity: 'CRITICAL' as const, sourceType: 'RACE', sourceId: item.id, title: '最終予想の公開期限を超過', summary: `${item.raceDate} ${item.venue} ${item.number}Rは発走時刻までに最終予想が公開されませんでした。` })),
    ...supportDeadlines.map(item => item.dueAt <= now
      ? ({ dedupeKey: `SUPPORT_DEADLINE:${item.id}`, code: 'SUPPORT_DEADLINE_OVERDUE', severity: 'CRITICAL' as const, sourceType: 'SUPPORT_REQUEST', sourceId: item.id, title: 'お問い合わせの対応期限を超過', summary: '未解決のお問い合わせが対応期限を超過しています。管理画面で担当と内容を確認してください。' })
      : ({ dedupeKey: `SUPPORT_DEADLINE:${item.id}`, code: 'SUPPORT_DEADLINE_DUE_SOON', severity: 'WARNING' as const, sourceType: 'SUPPORT_REQUEST', sourceId: item.id, title: 'お問い合わせの対応期限が接近', summary: '未解決のお問い合わせの対応期限が24時間以内です。管理画面で担当と内容を確認してください。' }))
  ];
}

async function detect(db: PrismaClient, now: Date) {
  const setting = await db.operationalAlertSetting.findUniqueOrThrow({ where: { id: 'global' } });
  const found = await candidates(db, now);
  let created = 0;
  for (const item of found) {
    const wasCreated = await db.$transaction(async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${item.dedupeKey}))::text`);
      const existing = await tx.operationalAlert.findUnique({ where: { dedupeKey: item.dedupeKey } });
      if (existing && (existing.status === 'RESOLVED' || existing.code !== item.code)) {
        await tx.operationalAlert.update({ where: { id: existing.id }, data: { dedupeKey: `${item.dedupeKey}:ARCHIVED:${existing.id}`, ...(existing.status === 'RESOLVED' ? {} : { status: 'RESOLVED', resolvedAt: now, resolvedBy: null, resolutionReason: 'SYSTEM: 検知状態が変化したため、新しいアラートへ切り替えました。' }) } });
      } else if (existing) {
        await tx.operationalAlert.update({ where: { id: existing.id }, data: { code: item.code, severity: item.severity, title: item.title, summary: item.summary, lastObservedAt: now } });
        return false;
      }
      await tx.operationalAlert.create({ data: { ...item, detectedAt: now, lastObservedAt: now } });
      return true;
    });
    if (wasCreated) created += 1;
  }
  const staleSupportAlerts = await db.operationalAlert.findMany({ where: { sourceType: 'SUPPORT_REQUEST', status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, select: { id: true, sourceId: true, dedupeKey: true } });
  const stillActiveSupport = staleSupportAlerts.length ? await db.supportRequest.findMany({ where: { id: { in: staleSupportAlerts.map(item => item.sourceId) }, status: { not: 'RESOLVED' }, dueAt: { not: null, lte: new Date(now.getTime() + 24 * 60 * 60_000) } }, select: { id: true } }) : [];
  const activeSupportIds = new Set(stillActiveSupport.map(item => item.id));
  for (const alert of staleSupportAlerts) {
    if (activeSupportIds.has(alert.sourceId)) continue;
    await db.operationalAlert.update({ where: { id: alert.id }, data: { status: 'RESOLVED', resolvedAt: now, resolvedBy: null, resolutionReason: 'SYSTEM: 問い合わせの対応期限条件が解消されました。', dedupeKey: `${alert.dedupeKey}:ARCHIVED:${alert.id}`, lastObservedAt: now } });
  }
  if (setting.enabled && setting.destinationEmails.length) {
    const severity = setting.minimumSeverity === 'CRITICAL' ? 'CRITICAL' : { in: ['CRITICAL', 'WARNING'] };
    for (const recipient of setting.destinationEmails) {
      const eligible = await db.operationalAlert.findMany({
        where: { status: 'OPEN', severity, deliveries: { none: { recipient } } },
        orderBy: [{ detectedAt: 'desc' }, { id: 'asc' }],
        take: 500,
        select: { id: true }
      });
      if (eligible.length) await db.operationalAlertDelivery.createMany({ data: eligible.map(alert => ({ alertId: alert.id, recipient, nextAttemptAt: now })), skipDuplicates: true });
    }
  }
  return { observed: found.length, created };
}

async function claim(db: PrismaClient, now: Date, limit: number, sourceId?: string) {
  const leaseToken = randomUUID(); const staleAt = new Date(now.getTime() - 5 * 60_000);
  const ids = await db.$transaction(async tx => {
    const rows = sourceId
      ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT d.id FROM operational_alert_deliveries d JOIN operational_alerts a ON a.id = d."alertId" WHERE a.status = 'OPEN' AND a."sourceId" = ${sourceId}::uuid AND ((d.status = 'QUEUED' AND d."nextAttemptAt" <= ${now}) OR (d.status = 'SENDING' AND d."lockedAt" < ${staleAt})) ORDER BY a."detectedAt" DESC, CASE a.severity WHEN 'CRITICAL' THEN 2 ELSE 1 END DESC, d."nextAttemptAt", d.id FOR UPDATE OF d SKIP LOCKED LIMIT ${limit}`)
      : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT d.id FROM operational_alert_deliveries d JOIN operational_alerts a ON a.id = d."alertId" WHERE a.status = 'OPEN' AND ((d.status = 'QUEUED' AND d."nextAttemptAt" <= ${now}) OR (d.status = 'SENDING' AND d."lockedAt" < ${staleAt})) ORDER BY a."detectedAt" DESC, CASE a.severity WHEN 'CRITICAL' THEN 2 ELSE 1 END DESC, d."nextAttemptAt", d.id FOR UPDATE OF d SKIP LOCKED LIMIT ${limit}`);
    if (rows.length) await tx.operationalAlertDelivery.updateMany({ where: { id: { in: rows.map(row => row.id) } }, data: { status: 'SENDING', leaseToken, lockedAt: now, updatedAt: now } });
    return rows.map(row => row.id);
  });
  return { ids, leaseToken };
}

export async function runOperationalAlerts(input: { db: PrismaClient; transport?: OperationalAlertTransport; now?: () => Date; limit?: number; sourceId?: string }) {
  const now = input.now ?? (() => new Date()); const observedAt = now(); const detected = await detect(input.db, observedAt);
  const setting = await input.db.operationalAlertSetting.findUniqueOrThrow({ where: { id: 'global' } });
  const result = { enabled: setting.enabled, ...detected, claimed: 0, sent: 0, retried: 0, failed: 0 };
  if (!setting.enabled || !setting.destinationEmails.length) return result;
  const transport = input.transport ?? new TestOperationalAlertTransport(); const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const leased = await claim(input.db, now(), limit, input.sourceId); result.claimed = leased.ids.length;
  const notificationPolicy = await input.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { notificationMaxAttempts: true, notificationBaseDelaySeconds: true } });
  for (const id of leased.ids) {
    const delivery = await input.db.operationalAlertDelivery.findFirst({ where: { id, leaseToken: leased.leaseToken, status: 'SENDING' }, include: { alert: true } });
    if (!delivery) continue;
    const alertPath = delivery.alert.sourceType === 'SUPPORT_REQUEST' ? '/admin/support' : '/admin/incidents';
    const text = `${delivery.alert.title}\n重大度: ${delivery.alert.severity}\n検知コード: ${delivery.alert.code}\n${delivery.alert.summary}\n検知時刻: ${delivery.alert.detectedAt.toISOString()}\n確認: ${process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000'}${alertPath}`;
    const outcome = await transport.send({ recipient: delivery.recipient, retryKey: delivery.id, severity: delivery.alert.severity as Severity, code: delivery.alert.code, title: delivery.alert.title, text });
    const finishedAt = now(); const attemptCount = delivery.attemptCount + 1;
    if (outcome.kind === 'SENT') {
      await input.db.operationalAlertDelivery.update({ where: { id }, data: { status: 'SENT', attemptCount, providerMessageId: outcome.providerMessageId, lastErrorCode: null, sentAt: finishedAt, lockedAt: null, leaseToken: null, updatedAt: finishedAt } }); result.sent += 1;
    } else {
      const retry = outcome.kind === 'TRANSIENT_FAILURE' && attemptCount < notificationPolicy.notificationMaxAttempts;
      const nextAttemptAt = retry ? new Date(finishedAt.getTime() + retryDelayMs(notificationPolicy.notificationBaseDelaySeconds, attemptCount)) : finishedAt;
      await input.db.operationalAlertDelivery.update({ where: { id }, data: { status: retry ? 'QUEUED' : 'FAILED', attemptCount, lastErrorCode: outcome.errorCode, nextAttemptAt, lockedAt: null, leaseToken: null, updatedAt: finishedAt } });
      if (retry) result.retried += 1; else result.failed += 1;
    }
  }
  return result;
}
