import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { canManage, dateSchema, jstDate, publicationScheduleCancelSchema, publicationScheduleSchema, requiresMfa } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function deliverySummary(deliveries: Array<{ channel: string; status: string }>, channel: 'LINE' | 'EMAIL', expandedAt: Date | null) {
  const selected = deliveries.filter(delivery => delivery.channel === channel);
  const count = (status: string) => selected.filter(delivery => delivery.status === status).length;
  return { expandedAt, total: selected.length, queued: count('QUEUED'), sending: count('SENDING'), sent: count('SENT'), failed: count('FAILED'), skipped: count('SKIPPED') };
}

@Controller('admin/publication-schedules')
export class PublicationSchedulesController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async staff(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN', 'OPERATOR'])) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '配信予約を管理する権限を確認してください。' });
    return actor;
  }

  @Get()
  async list(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req); const { date } = z.object({ date: dateSchema.default(jstDate(new Date())) }).parse(query); const now = new Date(); const dueSoon = new Date(now.getTime() + 30 * 60_000); const overdueAt = new Date(now.getTime() - 60_000);
    const [races, notificationEvents] = await this.auth.db.$transaction([
      this.auth.db.race.findMany({ where: { raceDate: date }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], select: {
        id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true, status: true,
        announcements: { orderBy: { version: 'desc' }, take: 1, select: { version: true, publishedAt: true } },
        freeReportDraft: { select: { revision: true, updatedAt: true } },
        freeReportVersions: { where: { kind: 'PRE_RACE' }, orderBy: { version: 'desc' }, take: 1, select: { version: true, publishedAt: true } },
        publicationSchedules: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, kind: true, draftRevision: true, scheduledAt: true, status: true, reason: true, createdAt: true, processedAt: true, errorCode: true, publishedTargetId: true } }
      } }),
      this.auth.db.notificationEvent.findMany({
        where: { OR: [
          { announcement: { is: { race: { is: { raceDate: date } } } } },
          { freeReportVersion: { is: { race: { is: { raceDate: date } } } } }
        ] },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true, eventType: true, status: true, expandedAt: true, emailExpandedAt: true,
          announcement: { select: { raceId: true, version: true, publishedAt: true } },
          freeReportVersion: { select: { raceId: true, version: true, kind: true, publishedAt: true } },
          deliveries: { select: { channel: true, status: true } }
        }
      })
    ]);
    const resultsByRace = new Map<string, Array<{
      eventId: string; contentType: 'RACE_ANNOUNCEMENT' | 'FREE_REPORT_PRE_RACE' | 'FREE_REPORT_POST_RACE_REVIEW'; label: string; version: number; publishedAt: Date; eventStatus: string;
      line: ReturnType<typeof deliverySummary>; email: ReturnType<typeof deliverySummary>;
    }>>();
    for (const event of notificationEvents) {
      const target = event.announcement ?? event.freeReportVersion;
      if (!target) continue;
      const contentType: 'RACE_ANNOUNCEMENT' | 'FREE_REPORT_PRE_RACE' | 'FREE_REPORT_POST_RACE_REVIEW' = event.announcement ? 'RACE_ANNOUNCEMENT' : event.freeReportVersion!.kind === 'PRE_RACE' ? 'FREE_REPORT_PRE_RACE' : 'FREE_REPORT_POST_RACE_REVIEW';
      const label = event.announcement ? '対象レース告知' : event.freeReportVersion!.kind === 'PRE_RACE' ? '無料パドック速報' : 'レース後検証';
      const result = { eventId: event.id, contentType, label, version: target.version, publishedAt: target.publishedAt, eventStatus: event.status, line: deliverySummary(event.deliveries, 'LINE', event.expandedAt), email: deliverySummary(event.deliveries, 'EMAIL', event.emailExpandedAt) };
      resultsByRace.set(target.raceId, [...(resultsByRace.get(target.raceId) ?? []), result]);
    }
    const failedDeliveries = notificationEvents.reduce((count, event) => count + event.deliveries.filter(delivery => delivery.status === 'FAILED').length, 0);
    const items = races.map(race => {
      const active = race.publicationSchedules.filter(schedule => ['PENDING', 'PROCESSING'].includes(schedule.status)); const warnings: string[] = [];
      if (race.startsAt > now && race.startsAt <= dueSoon && !race.announcements.length && !active.some(schedule => schedule.kind === 'RACE_ANNOUNCEMENT')) warnings.push('発走30分前までに対象レース告知が公開・予約されていません。');
      if (race.startsAt > now && race.startsAt <= dueSoon && race.freeReportDraft && !race.freeReportVersions.length && !active.some(schedule => schedule.kind === 'FREE_REPORT_PRE_RACE')) warnings.push('無料速報の下書きがありますが公開・予約されていません。');
      if (active.some(schedule => schedule.scheduledAt < overdueAt)) warnings.push('実行時刻を1分以上過ぎた配信予約があります。');
      if (race.publicationSchedules.some(schedule => schedule.status === 'FAILED')) warnings.push('失敗した配信予約があります。');
      return { ...race, deliveryResults: resultsByRace.get(race.id) ?? [], warnings };
    });
    return { generatedAt: now, items, alerts: items.reduce((count, race) => count + race.warnings.length, 0) + failedDeliveries, failedDeliveries };
  }

  @Post()
  async create(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req); const input = publicationScheduleSchema.parse(body); const requestKey = z.string().uuid().parse(req.headers['idempotency-key']); const key = `publication-schedule:${actor.id}:${requestKey}`; const requestHash = hashToken(JSON.stringify(body));
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`publication-schedule:${input.raceId}:${input.kind}`}))::text`;
      const creators = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "users" WHERE "id" = ${actor.id}::uuid AND "disabledAt" IS NULL AND "role" IN ('ADMIN', 'OPERATOR') FOR SHARE`;
      if (!creators[0]) throw new ForbiddenException({ code: 'STAFF_ACCOUNT_UNAVAILABLE', message: '有効な運営アカウントで再度ログインしてください。' });
      const previous = await tx.idempotencyKey.findUnique({ where: { key } });
      if (previous) { if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じリクエストキーの内容が変わっています。' }); return previous.response; }
      const race = await tx.race.findUnique({ where: { id: input.raceId }, include: { freeReportDraft: true } });
      if (!race) throw new NotFoundException({ code: 'RACE_NOT_FOUND', message: 'レースが見つかりません。' });
      if (input.scheduledAt <= new Date()) throw new BadRequestException({ code: 'SCHEDULE_IN_PAST', message: '現在より後の実行日時を指定してください。' });
      if (input.scheduledAt >= race.startsAt || ['FINISHED', 'CANCELLED'].includes(race.status)) throw new ConflictException({ code: 'SCHEDULE_AFTER_DEADLINE', message: '発走時刻より前の開催中レースだけ予約できます。' });
      if (input.kind === 'RACE_ANNOUNCEMENT' && input.draftRevision !== null) throw new BadRequestException({ code: 'SCHEDULE_REVISION_INVALID', message: '対象レース告知には下書きrevisionを指定しません。' });
      if (input.kind === 'FREE_REPORT_PRE_RACE' && (!race.freeReportDraft || race.freeReportDraft.revision !== input.draftRevision)) throw new ConflictException({ code: 'FREE_REPORT_DRAFT_CONFLICT', message: '無料速報の下書きを保存し、最新内容を再確認してください。' });
      const schedule = await tx.publicationSchedule.create({ data: { raceId: race.id, kind: input.kind, draftRevision: input.draftRevision, scheduledAt: input.scheduledAt, reason: input.reason, createdBy: actor.id } });
      await this.auth.audit(tx, req, 'PUBLICATION_SCHEDULE_CREATE', schedule.id, input.reason, { raceId: race.id, kind: input.kind, draftRevision: input.draftRevision, scheduledAt: input.scheduledAt.toISOString() });
      const response = json(schedule); await tx.idempotencyKey.create({ data: { key, requestHash, response } }); return response;
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Post(':scheduleId/cancel')
  async cancel(@Req() req: AppRequest, @Param('scheduleId') scheduleId: string, @Body() body: unknown) {
    await this.staff(req); z.string().uuid().parse(scheduleId); const input = publicationScheduleCancelSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`publication-schedule-id:${scheduleId}`}))::text`;
      const before = await tx.publicationSchedule.findUnique({ where: { id: scheduleId } });
      if (!before) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND', message: '配信予約が見つかりません。' });
      if (before.status !== 'PENDING') throw new ConflictException({ code: 'SCHEDULE_NOT_PENDING', message: '待機中の予約だけ取り消せます。' });
      const schedule = await tx.publicationSchedule.update({ where: { id: scheduleId }, data: { status: 'CANCELLED', processedAt: new Date(), errorCode: null } });
      await this.auth.audit(tx, req, 'PUBLICATION_SCHEDULE_CANCEL', schedule.id, input.reason, { raceId: schedule.raceId, kind: schedule.kind, scheduledAt: schedule.scheduledAt.toISOString() }); return schedule;
    });
  }
}
