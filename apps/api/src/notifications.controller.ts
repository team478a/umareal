import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { canManage, notificationListQuerySchema, notificationRetrySchema, requiresMfa } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { z } from 'zod';
import { Prisma } from '@keiba/db';
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
