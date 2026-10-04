import { contentDraftSchema } from '@keiba/domain';
import { Prisma, PrismaClient } from '@keiba/db';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
class ContentScheduleFailure extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new ContentScheduleFailure(code); };

export type ContentScheduleRunResult = { claimed: number; published: number; failed: number };

export async function runContentSchedules(input: { db: PrismaClient; limit?: number; now?: () => Date }): Promise<ContentScheduleRunResult> {
  const { db } = input; const limit = Math.min(Math.max(input.limit ?? 20, 1), 100); const clock = input.now ?? (() => new Date()); const dueAt = clock();
  const candidates = await db.$transaction(async tx => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM content_items WHERE status = 'SCHEDULED' AND "scheduledAt" <= ${dueAt} ORDER BY "scheduledAt", id FOR UPDATE SKIP LOCKED LIMIT ${limit}`);
  const result = { claimed: candidates.length, published: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      const published = await db.$transaction(async tx => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM content_items WHERE id = ${candidate.id}::uuid AND status = 'SCHEDULED' FOR UPDATE`;
        if (!locked.length) return false;
        const item = await tx.contentItem.findUniqueOrThrow({ where: { id: candidate.id }, include: { updater: { select: { role: true, disabledAt: true } }, versions: { orderBy: { version: 'desc' }, take: 1 } } });
        const reason = item.scheduleReason ?? '予約公開';
        if (item.scheduledRevision !== item.revision) fail('CONTENT_SCHEDULE_REVISION_CHANGED');
        if (item.updater.disabledAt || !['ADMIN', 'EDITOR'].includes(item.updater.role)) fail('CONTENT_SCHEDULE_ACTOR_INVALID');
        const draft = contentDraftSchema.parse({
          kind: item.kind,
          title: item.title,
          summary: item.summary,
          body: item.body,
          thumbnailUrl: item.thumbnailUrl,
          mediaUrl: item.mediaUrl,
          category: item.category,
          tags: item.tags,
          visibility: item.visibility
        });
        const versionNumber = (item.versions[0]?.version ?? 0) + 1;
        const version = await tx.contentVersion.create({ data: { contentId: item.id, version: versionNumber, kind: draft.kind, title: draft.title, summary: draft.summary, thumbnailUrl: draft.thumbnailUrl, category: draft.category, tags: draft.tags, visibility: draft.visibility, snapshot: json(draft), publishedBy: item.updatedBy } });
        await tx.contentItem.update({ where: { id: item.id }, data: { status: 'PUBLISHED', isVisible: true, revision: { increment: 1 }, scheduledAt: null, scheduledRevision: null, scheduleReason: null, scheduleError: null, updatedAt: clock() } });
        await tx.auditLog.create({ data: { actorId: item.updatedBy, actorRole: item.updater.role, action: versionNumber === 1 ? 'CONTENT_SCHEDULE_PUBLISHED' : 'CONTENT_SCHEDULE_VERSION_PUBLISHED', targetType: 'CONTENT_VERSION', targetId: version.id, reason, details: { contentId: item.id, version: versionNumber, scheduledAt: item.scheduledAt }, requestId: `content-schedule:${item.id}:${version.id}` } });
        return true;
      }, { timeout: 20000, maxWait: 10000 });
      if (published) result.published += 1;
    } catch (error) {
      const errorCode = error instanceof ContentScheduleFailure ? error.code : 'CONTENT_SCHEDULE_FAILED';
      await db.$transaction(async tx => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM content_items WHERE id = ${candidate.id}::uuid AND status = 'SCHEDULED' FOR UPDATE`;
        if (!locked.length) return;
        const item = await tx.contentItem.findUniqueOrThrow({ where: { id: candidate.id }, include: { updater: { select: { role: true } } } });
        await tx.contentItem.update({ where: { id: item.id }, data: { status: 'DRAFT', revision: { increment: 1 }, scheduledAt: null, scheduledRevision: null, scheduleReason: null, scheduleError: errorCode, updatedAt: clock() } });
        await tx.auditLog.create({ data: { actorId: item.updatedBy, actorRole: item.updater.role, action: 'CONTENT_SCHEDULE_FAILED', targetType: 'CONTENT_ITEM', targetId: item.id, reason: item.scheduleReason ?? '予約公開', details: { errorCode, scheduledAt: item.scheduledAt }, requestId: `content-schedule:${item.id}:failed` } });
        result.failed += 1;
      });
    }
  }
  return result;
}
