import { PrismaClient } from '@keiba/db';

class ScheduleFailure extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new ScheduleFailure(code); };

export type ScheduleRunResult = { claimed: number; published: number; failed: number };

export async function runPublicationSchedules(input: { db: PrismaClient; limit?: number; now?: () => Date }): Promise<ScheduleRunResult> {
  const { db } = input; const limit = Math.min(Math.max(input.limit ?? 20, 1), 100); const clock = input.now ?? (() => new Date()); const dueAt = clock();
  const candidates = await db.$transaction(async tx => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM publication_schedules WHERE status = 'PENDING' AND "scheduledAt" <= ${dueAt} ORDER BY "scheduledAt", id FOR UPDATE SKIP LOCKED LIMIT ${limit}`);
  const result = { claimed: candidates.length, published: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      const published = await db.$transaction(async tx => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM publication_schedules WHERE id = ${candidate.id}::uuid AND status = 'PENDING' FOR UPDATE`;
        if (!locked.length) return false;
        const schedule = await tx.publicationSchedule.findUniqueOrThrow({ where: { id: candidate.id }, include: { creator: { select: { role: true, disabledAt: true } }, race: { include: { announcements: { orderBy: { version: 'desc' }, take: 1 }, freeReportDraft: true, freeReportVersions: { orderBy: { version: 'desc' }, take: 1 }, entries: true } } } });
        const now = clock(); const race = schedule.race;
        if (schedule.creator.disabledAt || !['ADMIN', 'OPERATOR'].includes(schedule.creator.role)) fail('SCHEDULE_CREATOR_INVALID');
        if (now >= race.startsAt || ['FINISHED', 'CANCELLED'].includes(race.status)) fail('SCHEDULE_DEADLINE_PASSED');
        let targetId = '';
        if (schedule.kind === 'RACE_ANNOUNCEMENT') {
          const announcement = await tx.raceAnnouncement.create({ data: { raceId: race.id, version: (race.announcements[0]?.version ?? 0) + 1, publishedBy: schedule.createdBy, reason: schedule.reason, publishedAt: now } });
          await tx.notificationEvent.create({ data: { announcementId: announcement.id, eventType: 'RACE_ANNOUNCED', status: 'QUEUED', payload: { announcementId: announcement.id, raceId: race.id, visibility: 'FREE' } } }); targetId = announcement.id;
        } else if (schedule.kind === 'FREE_REPORT_PRE_RACE') {
          const draft = race.freeReportDraft;
          if (!draft || draft.revision !== schedule.draftRevision) throw new ScheduleFailure('SCHEDULE_DRAFT_CHANGED');
          const entries = new Map(race.entries.map(entry => [entry.id, entry])); const up = entries.get(draft.upEntryId); const down = entries.get(draft.downEntryId);
          if (!up || !down || up.id === down.id || up.status !== 'ACTIVE' || down.status !== 'ACTIVE') throw new ScheduleFailure('SCHEDULE_ENTRIES_INVALID');
          const version = await tx.freeReportVersion.create({ data: { raceId: race.id, version: (race.freeReportVersions[0]?.version ?? 0) + 1, kind: 'PRE_RACE', upEntryId: up.id, upHorseNumber: up.number, upHorseName: up.horseName, upReason: draft.upReason, downEntryId: down.id, downHorseNumber: down.number, downHorseName: down.horseName, downReason: draft.downReason, audioUrl: draft.audioUrl, reviewText: null, publishedBy: schedule.createdBy, publishReason: schedule.reason, publishedAt: now } });
          await tx.notificationEvent.create({ data: { freeReportVersionId: version.id, eventType: 'FREE_REPORT_PUBLISHED', status: 'QUEUED', payload: { freeReportVersionId: version.id, raceId: race.id } } }); targetId = version.id;
        } else throw new ScheduleFailure('SCHEDULE_KIND_INVALID');
        if (!targetId) throw new ScheduleFailure('SCHEDULE_EXECUTION_FAILED');
        await tx.publicationSchedule.update({ where: { id: schedule.id }, data: { status: 'PUBLISHED', processedAt: now, publishedTargetId: targetId, errorCode: null } });
        await tx.auditLog.create({ data: { actorId: schedule.createdBy, actorRole: schedule.creator.role, action: 'PUBLICATION_SCHEDULE_EXECUTE', targetType: 'PUBLICATION_SCHEDULE', targetId: schedule.id, reason: schedule.reason, details: { raceId: race.id, kind: schedule.kind, scheduledAt: schedule.scheduledAt, publishedTargetId: targetId }, requestId: `schedule:${schedule.id}` } });
        return true;
      }, { timeout: 20000, maxWait: 10000 });
      if (published) result.published += 1;
    } catch (error) {
      const errorCode = error instanceof ScheduleFailure ? error.code : 'SCHEDULE_EXECUTION_FAILED'; const failedAt = clock();
      await db.$transaction(async tx => {
        const changed = await tx.publicationSchedule.updateMany({ where: { id: candidate.id, status: 'PENDING' }, data: { status: 'FAILED', processedAt: failedAt, errorCode } });
        if (changed.count) { const schedule = await tx.publicationSchedule.findUniqueOrThrow({ where: { id: candidate.id }, include: { creator: { select: { role: true } } } }); await tx.auditLog.create({ data: { actorId: schedule.createdBy, actorRole: schedule.creator.role, action: 'PUBLICATION_SCHEDULE_FAILED', targetType: 'PUBLICATION_SCHEDULE', targetId: schedule.id, reason: schedule.reason, details: { raceId: schedule.raceId, kind: schedule.kind, scheduledAt: schedule.scheduledAt, errorCode }, requestId: `schedule:${schedule.id}` } }); result.failed += 1; }
      });
    }
  }
  return result;
}
