import { Controller, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { Prisma } from '@keiba/db';
import { dayPassWindow, memberNotificationListResponseSchema, parseContentAccessPolicy, planCanReadContent } from '@keiba/domain';
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
    const [user, entitlements, settings] = await Promise.all([
      this.auth.db.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } }),
      this.auth.db.entitlement.findMany({ where: { userId, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } }, select: { planCode: true, raceDate: true } }),
      this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { contentAccessPolicy: true } })
    ]);
    const allPaid = entitlements.some(item => item.raceDate === null);
    const paidDates = [...new Set(entitlements.flatMap(item => item.raceDate ? [item.raceDate] : []))];
    const visible: Prisma.NotificationEventWhereInput[] = [
      { announcementId: { not: null } },
      { freeReportVersionId: { not: null } },
      { productVersionId: { not: null } },
      { paperVersionId: { not: null } },
      { raceResultVersionId: { not: null } },
      { win5EvaluationVersionId: { not: null } },
      { supportEvent: { is: { request: { userId } } } },
      { billingEvent: { is: { userId } } },
      { version: { is: { visibility: 'FREE' } } },
      { contentVersion: { is: { visibility: { in: ['PUBLIC', 'MEMBERS'] } } } }
    ];
    if (allPaid) visible.push({ version: { is: { visibility: 'PAID' } } });
    else if (paidDates.length) visible.push({ version: { is: { visibility: 'PAID', prediction: { race: { raceDate: { in: paidDates } } } } } });
    const policy = parseContentAccessPolicy(settings.contentAccessPolicy);
    const contentEntitlements = entitlements.filter(item => planCanReadContent(item.planCode, 'CONTENT', policy));
    if (contentEntitlements.some(item => item.raceDate === null)) visible.push({ contentVersion: { is: { visibility: 'PAID' } } });
    else {
      const dates = [...new Set(contentEntitlements.flatMap(item => item.raceDate ? [item.raceDate] : []))];
      for (const date of dates) {
        const window = dayPassWindow(date);
        visible.push({ contentVersion: { is: { visibility: 'PAID', publishedAt: { gte: window.startsAt, lt: window.endsAt } } } });
      }
    }
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
      contentVersion: { select: { contentId: true, version: true, kind: true, title: true, category: true, visibility: true, publishedAt: true } },
      paperVersion: { select: { paperId: true, targetDate: true, title: true, accessScope: true, version: true, publishedAt: true } },
      memberReads: { where: { userId: actor.id }, select: { readAt: true }, take: 1 },
      announcement: { select: { version: true, publishedAt: true, race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } },
      freeReportVersion: { select: { version: true, kind: true, publishedAt: true, race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } },
      version: { select: { version: true, visibility: true, publishedAt: true, prediction: { select: { race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } } } },
      productVersion: { select: { version: true, accessScope: true, publishedAt: true, product: { select: { id: true, targetDate: true, title: true } } } },
      raceResultVersion: { select: { version: true, confirmedAt: true, race: { select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true } } } },
      win5EvaluationVersion: { select: { version: true, confirmedAt: true, product: { select: { id: true, targetDate: true, title: true } } } },
      supportEvent: { select: { occurredAt: true, request: { select: { id: true, subject: true } } } },
      billingEvent: { select: { occurredAt: true, eventType: true, subscription: { select: { planCode: true } }, dayPass: { select: { raceDate: true } } } }
    } satisfies Prisma.NotificationEventSelect;
    const [events, total, unreadCount] = await this.auth.db.$transaction([
      this.auth.db.notificationEvent.findMany({ where, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.auth.db.notificationEvent.count({ where }),
      this.auth.db.notificationEvent.count({ where: unreadWhere })
    ]);
    const items = events.map(event => {
      if (event.contentVersion) return { id: event.id, eventType: event.eventType, createdAt: event.createdAt, publishedAt: event.contentVersion.publishedAt, version: event.contentVersion.version, visibility: event.contentVersion.visibility === 'PAID' ? 'PAID' : 'FREE', readAt: event.memberReads[0]?.readAt ?? null, race: null, win5: null, content: { id: event.contentVersion.contentId, kind: event.contentVersion.kind, title: event.contentVersion.title, category: event.contentVersion.category }, href: `/content/${event.contentVersion.contentId}`, title: event.eventType === 'CONTENT_UPDATED' ? `${event.contentVersion.kind === 'ARTICLE' ? '記事' : event.contentVersion.kind === 'VIDEO' ? '動画' : '音声'}を更新しました` : `${event.contentVersion.kind === 'ARTICLE' ? '記事' : event.contentVersion.kind === 'VIDEO' ? '動画' : '音声'}を公開しました` };
      if (event.paperVersion) return { id: event.id, eventType: event.eventType, createdAt: event.createdAt, publishedAt: event.paperVersion.publishedAt, version: event.paperVersion.version, visibility: event.paperVersion.accessScope === 'PAID' ? 'PAID' : 'FREE', readAt: event.memberReads[0]?.readAt ?? null, race: null, win5: null, paper: { id: event.paperVersion.paperId, targetDate: event.paperVersion.targetDate, title: event.paperVersion.title }, href: `/papers/${event.paperVersion.paperId}`, title: event.eventType === 'RACE_PAPER_CORRECTED' ? '通常レース紙面の訂正版を公開しました' : '通常レース紙面を公開しました' };
      if (event.billingEvent) {
        const title = {
          BILLING_PAYMENT_SUCCEEDED: 'お支払いを確認しました', BILLING_PAYMENT_FAILED: 'お支払いを確認できませんでした',
          BILLING_PAYMENT_RECOVERED: 'お支払い状態が回復しました', BILLING_CANCELLATION_SCHEDULED: '解約予約を受け付けました',
          BILLING_CANCELLATION_REVERSED: '解約予約を取り消しました', BILLING_SUBSCRIPTION_ENDED: '月額契約が終了しました',
          BILLING_REFUND_COMPLETED: '返金手続きが完了しました'
        }[event.eventType] ?? 'お支払いに関するお知らせ';
        return { id: event.id, eventType: event.eventType, createdAt: event.createdAt, publishedAt: event.billingEvent.occurredAt, version: 1, visibility: 'FREE', readAt: event.memberReads[0]?.readAt ?? null, race: null, win5: null, billing: { planCode: event.billingEvent.subscription?.planCode ?? 'DAY_PASS', raceDate: event.billingEvent.dayPass?.raceDate ?? null }, href: '/account', title };
      }
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
    return memberNotificationListResponseSchema.parse({ items, total, unreadCount, page, limit });
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
