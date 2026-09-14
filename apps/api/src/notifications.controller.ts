import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { buildPredictionLineMessage, canManage, notificationListQuerySchema, notificationRetrySchema, requiresMfa } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { z } from 'zod';
import { notificationRecipientWhere, Prisma } from '@keiba/db';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

@Controller('admin/notifications')
export class NotificationsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async staff(req: AppRequest, roles: Role[]) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, roles)) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '通知運用の権限と二段階認証を確認してください。' });
    return actor;
  }

  private async audience(eventType: string, raceDate: string, now: Date) {
    const [settings, lineEligible, emailEligible, bothEligible] = await this.auth.db.$transaction([
      this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineNotificationsEnabled: true, emailNotificationsEnabled: true } }),
      this.auth.db.user.count({ where: notificationRecipientWhere({ channel: 'LINE', eventType, visibility: 'FREE', raceDate, now }) }),
      this.auth.db.user.count({ where: notificationRecipientWhere({ channel: 'EMAIL', eventType, visibility: 'FREE', raceDate, now }) }),
      this.auth.db.user.count({ where: { AND: [
        notificationRecipientWhere({ channel: 'LINE', eventType, visibility: 'FREE', raceDate, now }),
        notificationRecipientWhere({ channel: 'EMAIL', eventType, visibility: 'FREE', raceDate, now })
      ] } })
    ]);
    const lineScheduled = settings.lineNotificationsEnabled ? lineEligible : 0;
    const emailScheduled = settings.emailNotificationsEnabled ? emailEligible : 0;
    const duplicateChannelMembers = settings.lineNotificationsEnabled && settings.emailNotificationsEnabled ? bothEligible : 0;
    return {
      uniqueMembers: lineScheduled + emailScheduled - duplicateChannelMembers,
      totalDeliveries: lineScheduled + emailScheduled,
      duplicateChannelMembers,
      line: { enabled: settings.lineNotificationsEnabled, eligibleRecipients: lineEligible, scheduledDeliveries: lineScheduled },
      email: { enabled: settings.emailNotificationsEnabled, eligibleRecipients: emailEligible, scheduledDeliveries: emailScheduled }
    };
  }

  @Get('previews/race-announcement')
  async previewRaceAnnouncement(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    const input = z.object({ raceId: z.string().uuid(), scheduledAt: z.coerce.date().optional() }).parse(query);
    const generatedAt = new Date();
    const race = await this.auth.db.race.findUnique({
      where: { id: input.raceId },
      select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, status: true, announcements: { orderBy: { version: 'desc' }, take: 1, select: { version: true } } }
    });
    if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
    const plannedAt = input.scheduledAt ?? generatedAt;
    if (input.scheduledAt && input.scheduledAt <= generatedAt) throw new BadRequestException({ code: 'PREVIEW_SCHEDULE_IN_PAST', message: '現在より後の配信予定時刻を指定してください。' });
    if (plannedAt >= race.startsAt || ['FINISHED', 'CANCELLED'].includes(race.status)) throw new BadRequestException({ code: 'PREVIEW_AFTER_DEADLINE', message: '発走時刻より前の開催中レースだけ確認できます。' });

    const version = (race.announcements[0]?.version ?? 0) + 1;
    const message = buildPredictionLineMessage({ eventType: 'RACE_ANNOUNCED', raceId: race.id, raceDate: race.raceDate, venue: race.venue, raceNumber: race.number, raceName: race.name, version, visibility: 'FREE', appBaseUrl: process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000' });
    return {
      eventType: 'RACE_ANNOUNCED', contentLabel: '対象レース告知', generatedAt, plannedAt, timing: input.scheduledAt ? 'SCHEDULED' : 'IMMEDIATE', version,
      race: { id: race.id, raceDate: race.raceDate, venue: race.venue, number: race.number, name: race.name, startsAt: race.startsAt },
      audience: await this.audience('RACE_ANNOUNCED', race.raceDate, generatedAt),
      message
    };
  }

  @Get('previews/free-report')
  async previewFreeReport(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    const input = z.object({
      raceId: z.string().uuid(),
      kind: z.enum(['PRE_RACE', 'POST_RACE_REVIEW']),
      revision: z.coerce.number().int().positive(),
      scheduledAt: z.coerce.date().optional()
    }).parse(query);
    const generatedAt = new Date();
    if (input.scheduledAt && input.scheduledAt <= generatedAt) throw new BadRequestException({ code: 'PREVIEW_SCHEDULE_IN_PAST', message: '現在より後の配信予定時刻を指定してください。' });
    if (input.kind === 'POST_RACE_REVIEW' && input.scheduledAt) throw new BadRequestException({ code: 'FREE_REPORT_REVIEW_SCHEDULE_UNSUPPORTED', message: 'レース後検証は即時公開で確認してください。' });
    const race = await this.auth.db.race.findUnique({ where: { id: input.raceId }, select: {
      id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, status: true,
      entries: { select: { id: true, status: true } },
      freeReportDraft: { select: { revision: true, upEntryId: true, downEntryId: true, reviewText: true } },
      freeReportVersions: { orderBy: { version: 'desc' }, select: { version: true, kind: true } },
      resultVersions: { take: 1, select: { id: true } }
    } });
    if (!race || !race.freeReportDraft) throw new NotFoundException({ code: 'FREE_REPORT_DRAFT_NOT_FOUND', message: '無料速報の下書きを保存してください。' });
    if (race.freeReportDraft.revision !== input.revision) throw new ConflictException({ code: 'FREE_REPORT_DRAFT_CONFLICT', message: '無料速報が変更されています。再確認してください。' });
    const plannedAt = input.scheduledAt ?? generatedAt;
    const latestPre = race.freeReportVersions.find(version => version.kind === 'PRE_RACE');
    if (input.kind === 'PRE_RACE' && (plannedAt >= race.startsAt || ['FINISHED', 'CANCELLED'].includes(race.status))) throw new ConflictException({ code: 'FREE_REPORT_PRE_RACE_CLOSED', message: '発走後または中止レースの事前速報は公開できません。' });
    if (input.kind === 'POST_RACE_REVIEW' && (!latestPre || generatedAt < race.startsAt || !race.resultVersions.length)) throw new ConflictException({ code: 'FREE_REPORT_REVIEW_NOT_READY', message: '事前速報と確定結果があり、発走時刻を過ぎてから検証を公開できます。' });
    if (input.kind === 'POST_RACE_REVIEW' && !race.freeReportDraft.reviewText.trim()) throw new BadRequestException({ code: 'FREE_REPORT_REVIEW_REQUIRED', message: 'レース後の検証コメントを入力してください。' });
    if (input.kind === 'PRE_RACE') {
      const entries = new Map(race.entries.map(entry => [entry.id, entry.status]));
      if (entries.get(race.freeReportDraft.upEntryId) !== 'ACTIVE' || entries.get(race.freeReportDraft.downEntryId) !== 'ACTIVE') throw new BadRequestException({ code: 'FREE_REPORT_ENTRY_INVALID', message: '選択した出走馬の状態を確認してください。' });
    }
    const eventType = input.kind === 'PRE_RACE' ? 'FREE_REPORT_PUBLISHED' : 'FREE_REPORT_REVIEW_PUBLISHED';
    const version = (race.freeReportVersions[0]?.version ?? 0) + 1;
    const message = buildPredictionLineMessage({ eventType, raceId: race.id, raceDate: race.raceDate, venue: race.venue, raceNumber: race.number, raceName: race.name, version, visibility: 'FREE', appBaseUrl: process.env.APP_BASE_URL ?? 'http://127.0.0.1:3000' });
    return {
      eventType,
      contentLabel: input.kind === 'PRE_RACE' ? '無料パドック速報' : 'レース後検証',
      kind: input.kind,
      draftRevision: race.freeReportDraft.revision,
      generatedAt,
      plannedAt,
      timing: input.scheduledAt ? 'SCHEDULED' : 'IMMEDIATE',
      version,
      race: { id: race.id, raceDate: race.raceDate, venue: race.venue, number: race.number, name: race.name, startsAt: race.startsAt },
      audience: await this.audience(eventType, race.raceDate, generatedAt),
      message
    };
  }

  @Get()
  async list(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    const { page, limit, status, channel } = notificationListQuerySchema.parse(query);
    const where: Prisma.NotificationDeliveryWhereInput = { ...(status ? { status } : {}), ...(channel ? { channel } : {}) };
    const countWhere = channel ? Prisma.sql`WHERE channel = ${channel}` : Prisma.empty;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [items, total, counts, lastWebhook, receivedWebhooks, unmatchedWebhooks, blockedAccounts, lastEmailWebhook, emailReceived24h, emailAction24h, blockedEmailAccounts, recentEmailWebhooks, blockedEmailMembers] = await this.auth.db.$transaction([
      this.auth.db.notificationDelivery.findMany({
        where, skip: (page - 1) * limit, take: limit, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true, status: true, channel: true, attemptCount: true, manualRetryCount: true, nextAttemptAt: true, lastErrorCode: true, sentAt: true, createdAt: true, updatedAt: true,
          user: { select: { id: true, displayName: true, email: true } },
          event: { select: { id: true, eventType: true, status: true, createdAt: true, version: { select: { id: true, version: true, visibility: true, prediction: { select: { race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } } } }, announcement: { select: { id: true, version: true, race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } }, freeReportVersion: { select: { id: true, version: true, kind: true, race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } } } },
          attempts: { select: { id: true, attemptNumber: true, outcome: true, errorCode: true, startedAt: true, finishedAt: true }, orderBy: { attemptNumber: 'desc' }, take: 10 }
        }
      }),
      this.auth.db.notificationDelivery.count({ where }),
      this.auth.db.$queryRaw<Array<{ status: string; count: bigint }>>(Prisma.sql`SELECT status, count(*)::bigint AS count FROM notification_deliveries ${countWhere} GROUP BY status ORDER BY status`),
      this.auth.db.lineWebhookEvent.findFirst({ orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }], select: { receivedAt: true, eventType: true, outcome: true } }),
      this.auth.db.lineWebhookEvent.count({ where: { receivedAt: { gte: since } } }),
      this.auth.db.lineWebhookEvent.count({ where: { receivedAt: { gte: since }, outcome: 'UNMATCHED' } }),
      this.auth.db.lineAccount.count({ where: { notificationDisabledAt: { not: null } } }),
      this.auth.db.emailWebhookEvent.findFirst({ orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }], select: { receivedAt: true, eventType: true, outcome: true } }),
      this.auth.db.emailWebhookEvent.count({ where: { receivedAt: { gte: since } } }),
      this.auth.db.emailWebhookEvent.count({ where: { receivedAt: { gte: since }, eventType: { in: ['email.bounced', 'email.complained', 'email.suppressed', 'email.failed'] } } }),
      this.auth.db.user.count({ where: { emailDeliveryDisabledAt: { not: null } } }),
      this.auth.db.emailWebhookEvent.findMany({ orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }], take: 20, select: { id: true, eventType: true, occurredAt: true, receivedAt: true, recipientCount: true, matchedCount: true, disabledCount: true, outcome: true } }),
      this.auth.db.user.findMany({ where: { emailDeliveryDisabledAt: { not: null } }, orderBy: [{ emailDeliveryDisabledAt: 'desc' }, { id: 'asc' }], take: 20, select: { id: true, displayName: true, email: true, emailDeliveryDisabledAt: true, emailDeliveryDisabledReason: true } })
    ]);
    return { items, total, page, limit, channel: channel ?? null, counts: Object.fromEntries(counts.map(item => [item.status, Number(item.count)])), webhook: { lastReceivedAt: lastWebhook?.receivedAt ?? null, lastEventType: lastWebhook?.eventType ?? null, lastOutcome: lastWebhook?.outcome ?? null, received24h: receivedWebhooks, unmatched24h: unmatchedWebhooks, blockedAccounts }, emailWebhook: { lastReceivedAt: lastEmailWebhook?.receivedAt ?? null, lastEventType: lastEmailWebhook?.eventType ?? null, lastOutcome: lastEmailWebhook?.outcome ?? null, received24h: emailReceived24h, actionRequired24h: emailAction24h, blockedAccounts: blockedEmailAccounts, recent: recentEmailWebhooks, blockedMembers: blockedEmailMembers } };
  }

  @Post(':notificationId/retry')
  async retry(@Param('notificationId') notificationId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN', 'OPERATOR']);
    z.string().uuid().parse(notificationId);
    const input = notificationRetrySchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      const delivery = await tx.notificationDelivery.findUnique({ where: { id: notificationId }, select: { id: true, eventId: true, channel: true, status: true, attemptCount: true, manualRetryCount: true, attempts: { orderBy: { attemptNumber: 'asc' }, take: 1, select: { startedAt: true } } } });
      if (!delivery) throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: '通知が見つかりません。' });
      if (delivery.status !== 'FAILED') throw new BadRequestException({ code: 'NOTIFICATION_NOT_FAILED', message: '失敗した通知だけを再送できます。' });
      if (delivery.attempts[0] && Date.now() - delivery.attempts[0].startedAt.getTime() >= 24 * 60 * 60 * 1000) throw new BadRequestException({ code: 'NOTIFICATION_RETRY_WINDOW_EXPIRED', message: '重複防止期間を過ぎているため、この通知は再送できません。' });
      const updated = await tx.notificationDelivery.update({ where: { id: delivery.id }, data: { status: 'QUEUED', forceAttempt: true, manualRetryCount: { increment: 1 }, nextAttemptAt: new Date(), lockedAt: null, leaseToken: null, updatedAt: new Date() } });
      await tx.notificationEvent.update({ where: { id: delivery.eventId }, data: { status: 'RETRIED', updatedAt: new Date() } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: 'NOTIFICATION_RETRY_REQUEST', targetType: 'NOTIFICATION_DELIVERY', targetId: delivery.id, reason: input.reason, details: { eventId: delivery.eventId, channel: delivery.channel, previousStatus: delivery.status, attemptCount: delivery.attemptCount, manualRetryCount: updated.manualRetryCount }, requestId: req.requestId } });
      return { id: updated.id, status: updated.status, manualRetryCount: updated.manualRetryCount, nextAttemptAt: updated.nextAttemptAt };
    });
  }

  @Post('email-blocks/:userId/release')
  async releaseEmailBlock(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    z.string().uuid().parse(userId);
    const input = notificationRetrySchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-block:${userId}`}))::text`;
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, emailDeliveryDisabledAt: true, emailDeliveryDisabledReason: true } });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '会員が見つかりません。' });
      if (!user.emailDeliveryDisabledAt) throw new BadRequestException({ code: 'EMAIL_DELIVERY_NOT_BLOCKED', message: 'この会員のメール通知は配信拒否で停止されていません。' });
      await tx.user.update({ where: { id: user.id }, data: { emailDeliveryDisabledAt: null, emailDeliveryDisabledReason: null } });
      await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: 'EMAIL_DELIVERY_BLOCK_RELEASE', targetType: 'USER', targetId: user.id, reason: input.reason, details: { previousReason: user.emailDeliveryDisabledReason, previousDisabledAt: user.emailDeliveryDisabledAt }, requestId: req.requestId } });
      return { userId: user.id, emailNotificationState: 'DISABLED', emailEnabled: false };
    });
  }
}
