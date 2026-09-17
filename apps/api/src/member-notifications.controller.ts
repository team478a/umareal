import { Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unread: z.enum(['true', 'false']).default('false')
});

@Controller('me/notifications')
export class MemberNotificationsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async visibleWhere(userId: string): Promise<Prisma.NotificationEventWhereInput> {
    const now = new Date();
    const [user, entitlements] = await Promise.all([
      this.auth.db.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } }),
      this.auth.db.entitlement.findMany({ where: { userId, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } }, select: { raceDate: true } })
    ]);
    const allPaid = entitlements.some(item => item.raceDate === null);
    const paidDates = [...new Set(entitlements.flatMap(item => item.raceDate ? [item.raceDate] : []))];
    const visible: Prisma.NotificationEventWhereInput[] = [
      { announcementId: { not: null } },
      { freeReportVersionId: { not: null } },
      { productVersionId: { not: null } },
      { raceResultVersionId: { not: null } },
      { win5EvaluationVersionId: { not: null } },
      { supportEvent: { is: { request: { userId } } } },
      { version: { is: { visibility: 'FREE' } } }
    ];
    if (allPaid) visible.push({ version: { is: { visibility: 'PAID' } } });
    else if (paidDates.length) visible.push({ version: { is: { visibility: 'PAID', prediction: { race: { raceDate: { in: paidDates } } } } } });
    return { AND: [{ createdAt: { gte: user.createdAt } }, { OR: visible }] };
  }

  @Get()
  async list(@Req() req: AppRequest, @Query() query: unknown) {
    const actor = await this.auth.authenticate(req);
    const { page, limit, unread } = listQuery.parse(query);
    const visible = await this.visibleWhere(actor.id);
    const unreadWhere: Prisma.NotificationEventWhereInput = { AND: [visible, { memberReads: { none: { userId: actor.id } } }] };
    const where: Prisma.NotificationEventWhereInput = unread === 'true' ? unreadWhere : visible;
    const select = {
      id: true, eventType: true, createdAt: true,
      memberReads: { where: { userId: actor.id }, select: { readAt: true }, take: 1 },
      announcement: { select: { version: true, publishedAt: true, race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } },
      freeReportVersion: { select: { version: true, kind: true, publishedAt: true, race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } },
      version: { select: { version: true, visibility: true, publishedAt: true, prediction: { select: { race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } } } },
      productVersion: { select: { version: true, accessScope: true, publishedAt: true, product: { select: { id: true, targetDate: true, title: true } } } },
      raceResultVersion: { select: { version: true, confirmedAt: true, race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } },
      win5EvaluationVersion: { select: { version: true, confirmedAt: true, product: { select: { id: true, targetDate: true, title: true } } } },
      supportEvent: { select: { occurredAt: true, request: { select: { id: true, subject: true } } } }
    } satisfies Prisma.NotificationEventSelect;
    const [events, total, unreadCount] = await this.auth.db.$transaction([
      this.auth.db.notificationEvent.findMany({ where, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.auth.db.notificationEvent.count({ where }),
      this.auth.db.notificationEvent.count({ where: unreadWhere })
    ]);
    const items = events.map(event => {
      if (event.supportEvent) return { id: event.id, eventType: event.eventType, createdAt: event.createdAt, publishedAt: event.supportEvent.occurredAt, version: 1, visibility: 'FREE', readAt: event.memberReads[0]?.readAt ?? null, race: null, win5: null, support: { requestId: event.supportEvent.request.id, subject: event.supportEvent.request.subject }, href: '/support', title: 'お問い合わせへの回答があります' };
      if (event.win5EvaluationVersion) return { id: event.id, eventType: event.eventType, createdAt: event.createdAt, publishedAt: event.win5EvaluationVersion.confirmedAt, version: event.win5EvaluationVersion.version, visibility: 'FREE', readAt: event.memberReads[0]?.readAt ?? null, race: null, win5: event.win5EvaluationVersion.product, href: `/win5/${event.win5EvaluationVersion.product.id}`, title: 'WIN5紙面予想の評価結果が確定しました' };
      if (event.raceResultVersion) return { id: event.id, eventType: event.eventType, createdAt: event.createdAt, publishedAt: event.raceResultVersion.confirmedAt, version: event.raceResultVersion.version, visibility: 'FREE', readAt: event.memberReads[0]?.readAt ?? null, race: event.raceResultVersion.race, win5: null, href: `/races/${event.raceResultVersion.race.id}`, title: 'パドック直前予想の評価結果が確定しました' };
      if (event.productVersion) return { id: event.id, eventType: event.eventType, createdAt: event.createdAt, publishedAt: event.productVersion.publishedAt, version: event.productVersion.version, visibility: event.productVersion.accessScope, readAt: event.memberReads[0]?.readAt ?? null, race: null, win5: event.productVersion.product, href: `/win5/${event.productVersion.product.id}`,
        title: event.eventType === 'WIN5_PREVIEW_CORRECTED' ? 'WIN5紙面予想の訂正版を公開しました' : 'WIN5紙面予想を公開しました' };
      const target = event.announcement ?? event.version ?? event.freeReportVersion!;
      const race = event.announcement?.race ?? event.version?.prediction.race ?? event.freeReportVersion!.race;
      const corrected = event.eventType === 'PREDICTION_CORRECTED';
      return { id: event.id, eventType: event.eventType, createdAt: event.createdAt, publishedAt: target.publishedAt, version: target.version, visibility: event.version?.visibility ?? 'FREE', readAt: event.memberReads[0]?.readAt ?? null, race, win5: null, href: `/races/${race.id}`,
        title: event.eventType === 'RACE_ANNOUNCED' ? '予想対象レースが決まりました' : event.eventType === 'FREE_REPORT_PUBLISHED' ? '無料パドック速報を公開しました' : event.eventType === 'FREE_REPORT_REVIEW_PUBLISHED' ? '無料速報のレース後検証を公開しました' : corrected ? '最終予想の訂正版を公開しました' : '最終予想を公開しました' };
    });
    return { items, total, unreadCount, page, limit };
  }

  @Post(':eventId/read')
  async read(@Req() req: AppRequest, @Param('eventId') eventId: string) {
    const actor = await this.auth.authenticate(req);
    z.string().uuid().parse(eventId);
    const event = await this.auth.db.notificationEvent.findFirst({ where: { AND: [{ id: eventId }, await this.visibleWhere(actor.id)] }, select: { id: true } });
    if (!event) throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'お知らせが見つかりません。' });
    const receipt = await this.auth.db.memberNotificationRead.upsert({ where: { userId_eventId: { userId: actor.id, eventId } }, create: { userId: actor.id, eventId }, update: {} });
    return { eventId: receipt.eventId, readAt: receipt.readAt };
  }
}
