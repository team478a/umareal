import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@keiba/db';
import { adminContentItemResponseSchema, adminContentListResponseSchema, adminContentMutationResponseSchema, adminContentRaceOptionsResponseSchema, canManage, canReadPrediction, contentDraftSchema, contentPublishSchema, contentSaveSchema, contentScheduleSchema, contentStateChangeSchema, dateSchema, jstDate, parseContentAccessPolicy, publicContentDetailResponseSchema, publicContentListResponseSchema, publicRaceRelatedContentResponseSchema } from '@keiba/domain';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest, AuthContext } from './context';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const itemSelect = {
  id: true, revision: true, status: true, isVisible: true, kind: true, title: true, summary: true, body: true, thumbnailUrl: true, mediaUrl: true,
  category: true, tags: true, relatedRaceIds: true, visibility: true, scheduledAt: true, scheduleError: true, createdAt: true, updatedAt: true,
  versions: { orderBy: { version: 'desc' as const }, take: 50, select: { id: true, version: true, kind: true, title: true, summary: true, thumbnailUrl: true, category: true, tags: true, visibility: true, publishedAt: true } }
};
const versionSelect = { id: true, version: true, kind: true, title: true, summary: true, thumbnailUrl: true, category: true, tags: true, relatedRaceIds: true, visibility: true, publishedAt: true, snapshot: true } as const;
type PublicVersionRow = { contentId: string; version: number; kind: string; title: string; summary: string; thumbnailUrl: string | null; category: string; tags: string[]; relatedRaceIds: string[]; visibility: string; publishedAt: Date };
const publicMetadata = (contentId: string, version: Omit<PublicVersionRow, 'contentId'>) => ({ id: contentId, version: version.version, kind: version.kind, title: version.title, summary: version.summary, thumbnailUrl: version.thumbnailUrl, category: version.category, tags: version.tags, visibility: version.visibility, publishedAt: version.publishedAt });

@Controller()
export class ContentController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private locked<T>(work: (tx: Tx) => Promise<T>) {
    return this.auth.db.$transaction(async tx => { await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262027)::text`; return work(tx); }, { timeout: 20000, maxWait: 10000 });
  }

  private async editor(req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, ['ADMIN', 'EDITOR'])) throw new ForbiddenException({ code: 'CONTENT_ACCESS_DENIED', message: 'コンテンツ編集権限を確認してください。' });
    return actor;
  }

  private draft(row: { kind: string; title: string; summary: string; body: string; thumbnailUrl: string | null; mediaUrl: string | null; category: string; tags: string[]; relatedRaceIds: string[]; visibility: string }) {
    return contentDraftSchema.parse({ kind: row.kind, title: row.title, summary: row.summary, body: row.body, thumbnailUrl: row.thumbnailUrl, mediaUrl: row.mediaUrl, category: row.category, tags: row.tags, relatedRaceIds: row.relatedRaceIds, visibility: row.visibility });
  }

  private async validateRelatedRaces(tx: Tx, relatedRaceIds: string[]) {
    if (!relatedRaceIds.length) return;
    const count = await tx.race.count({ where: { id: { in: relatedRaceIds } } });
    if (count !== relatedRaceIds.length) throw new ConflictException({ code: 'CONTENT_RACE_NOT_FOUND', message: '選択した関連レースを確認できません。最新のレース一覧から選び直してください。' });
  }

  private adminItem(row: Prisma.ContentItemGetPayload<{ select: typeof itemSelect }>) {
    return adminContentItemResponseSchema.parse({
      id: row.id,
      revision: row.revision,
      status: row.status,
      isVisible: row.isVisible,
      draft: this.draft(row),
      scheduledAt: row.scheduledAt,
      scheduleError: row.scheduleError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      versions: row.versions
    });
  }

  private async loadLocked(tx: Tx, id: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM content_items WHERE id = ${id}::uuid FOR UPDATE`;
    if (!locked.length) throw new NotFoundException();
    return tx.contentItem.findUniqueOrThrow({ where: { id }, select: itemSelect });
  }

  private async publish(tx: Tx, item: Awaited<ReturnType<ContentController['loadLocked']>>, actor: AuthContext, reason: string, requestId: string) {
    if (item.status === 'ARCHIVED') throw new ConflictException({ code: 'CONTENT_ARCHIVED', message: '公開終了したコンテンツは公開できません。' });
    if (item.status === 'SCHEDULED') throw new ConflictException({ code: 'CONTENT_SCHEDULED', message: '予約を取り消してから即時公開してください。' });
    const latest = item.versions[0]; const draft = this.draft(item); const nextVersion = (latest?.version ?? 0) + 1;
    await this.validateRelatedRaces(tx, draft.relatedRaceIds);
    const version = await tx.contentVersion.create({ data: { contentId: item.id, version: nextVersion, kind: draft.kind, title: draft.title, summary: draft.summary, thumbnailUrl: draft.thumbnailUrl, category: draft.category, tags: draft.tags, relatedRaceIds: draft.relatedRaceIds, visibility: draft.visibility, snapshot: json(draft), publishedBy: actor.id } });
    await tx.notificationEvent.create({ data: { contentVersionId: version.id, eventType: nextVersion === 1 ? 'CONTENT_PUBLISHED' : 'CONTENT_UPDATED', status: 'QUEUED', payload: json({ contentVersionId: version.id, contentId: item.id }) } });
    const updated = await tx.contentItem.update({ where: { id: item.id }, data: { status: 'PUBLISHED', isVisible: true, revision: { increment: 1 }, scheduledAt: null, scheduledRevision: null, scheduleReason: null, scheduleError: null, updatedBy: actor.id, updatedAt: new Date() } });
    await tx.auditLog.create({ data: { actorId: actor.id, actorRole: actor.role, action: nextVersion === 1 ? 'CONTENT_PUBLISHED' : 'CONTENT_VERSION_PUBLISHED', targetType: 'CONTENT_VERSION', targetId: version.id, reason, details: { contentId: item.id, version: nextVersion, kind: draft.kind, visibility: draft.visibility }, requestId } });
    return adminContentMutationResponseSchema.parse({ id: item.id, revision: updated.revision, status: updated.status, scheduledAt: null, version: nextVersion });
  }

  @Get('admin/content') async adminList(@Req() req: AppRequest) {
    await this.editor(req);
    const items = await this.auth.db.contentItem.findMany({ orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 100, select: itemSelect });
    return adminContentListResponseSchema.parse({ items: items.map(item => this.adminItem(item)) });
  }

  @Get('admin/content/races') async raceOptions(@Req() req: AppRequest, @Query() query: unknown) {
    await this.editor(req);
    const input = z.object({ date: dateSchema.optional(), ids: z.string().trim().max(400).optional() }).strict().parse(query);
    const ids = input.ids ? input.ids.split(',').filter(Boolean).map(value => z.string().uuid().parse(value)).slice(0, 10) : [];
    const items = await this.auth.db.race.findMany({
      where: input.date && ids.length ? { OR: [{ raceDate: input.date }, { id: { in: ids } }] } : input.date ? { raceDate: input.date } : ids.length ? { id: { in: ids } } : { raceDate: jstDate(new Date()) },
      select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true }, orderBy: [{ raceDate: 'desc' }, { venue: 'asc' }, { number: 'asc' }], take: 100
    });
    return adminContentRaceOptionsResponseSchema.parse({ items });
  }

  @Post('admin/content/draft') async save(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.editor(req); const input = contentSaveSchema.parse(body);
    return this.locked(async tx => {
      const current = await tx.contentItem.findUnique({ where: { id: input.id }, select: itemSelect });
      if (current?.status === 'SCHEDULED') throw new ConflictException({ code: 'CONTENT_SCHEDULED', message: '予約を取り消してから編集してください。' });
      if (current?.status === 'ARCHIVED') throw new ConflictException({ code: 'CONTENT_ARCHIVED', message: '公開終了を解除してから編集してください。' });
      if ((current?.revision ?? 0) !== input.revision) throw new ConflictException({ code: 'CONTENT_CONFLICT', message: '別の端末で内容が変更されました。再読み込みしてください。' });
      if (current?.versions.length && current.kind !== input.draft.kind) throw new ConflictException({ code: 'CONTENT_KIND_FROZEN', message: '公開後はコンテンツ種別を変更できません。新しいコンテンツとして作成してください。' });
      await this.validateRelatedRaces(tx, input.draft.relatedRaceIds);
      const values = { ...input.draft, status: 'DRAFT', updatedBy: actor.id, scheduleError: null } as const;
      const item = current
        ? await tx.contentItem.update({ where: { id: input.id }, data: { ...values, revision: { increment: 1 }, updatedAt: new Date() }, select: itemSelect })
        : await tx.contentItem.create({ data: { id: input.id, ...input.draft, createdBy: actor.id, updatedBy: actor.id }, select: itemSelect });
      await this.auth.audit(tx, req, current ? 'CONTENT_DRAFT_UPDATED' : 'CONTENT_DRAFT_CREATED', item.id, input.reason, { revision: item.revision, kind: item.kind, visibility: item.visibility }, 'CONTENT_ITEM');
      return this.adminItem(item);
    });
  }

  @Post('admin/content/:id/publish') async publishNow(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    z.string().uuid().parse(id); const actor = await this.editor(req); const input = contentPublishSchema.parse(body);
    return this.locked(async tx => { const item = await this.loadLocked(tx, id); if (item.revision !== input.revision) throw new ConflictException({ code: 'CONTENT_CONFLICT', message: '内容が変更されました。再確認してください。' }); return this.publish(tx, item, actor, input.reason, req.requestId); });
  }

  @Post('admin/content/:id/schedule') async schedule(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    z.string().uuid().parse(id); const actor = await this.editor(req); const input = contentScheduleSchema.parse(body); const scheduledAt = new Date(input.scheduledAt);
    if (scheduledAt <= new Date()) throw new ConflictException({ code: 'CONTENT_SCHEDULE_PAST', message: '公開予約時刻は現在より後にしてください。' });
    return this.locked(async tx => {
      const item = await this.loadLocked(tx, id);
      if (item.revision !== input.revision) throw new ConflictException({ code: 'CONTENT_CONFLICT', message: '内容が変更されました。再確認してください。' });
      if (item.status === 'ARCHIVED') throw new ConflictException({ code: 'CONTENT_ARCHIVED', message: '公開終了を解除してから予約してください。' });
      if (item.status === 'SCHEDULED') throw new ConflictException({ code: 'CONTENT_ALREADY_SCHEDULED', message: 'すでに公開予約されています。' });
      const revision = item.revision + 1;
      const updated = await tx.contentItem.update({ where: { id }, data: { status: 'SCHEDULED', revision, scheduledAt, scheduledRevision: revision, scheduleReason: input.reason, scheduleError: null, updatedBy: actor.id, updatedAt: new Date() } });
      await this.auth.audit(tx, req, 'CONTENT_SCHEDULED', id, input.reason, { revision, scheduledAt: scheduledAt.toISOString() }, 'CONTENT_ITEM');
      return adminContentMutationResponseSchema.parse({ id, revision, status: updated.status, scheduledAt });
    });
  }

  @Post('admin/content/:id/schedule/cancel') async cancelSchedule(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    z.string().uuid().parse(id); const actor = await this.editor(req); const input = contentStateChangeSchema.parse(body);
    return this.locked(async tx => {
      const item = await this.loadLocked(tx, id);
      if (item.revision !== input.revision) throw new ConflictException({ code: 'CONTENT_CONFLICT', message: '予約状態が変更されました。再読み込みしてください。' });
      if (item.status !== 'SCHEDULED') throw new ConflictException({ code: 'CONTENT_NOT_SCHEDULED', message: '公開予約されていません。' });
      const updated = await tx.contentItem.update({ where: { id }, data: { status: 'DRAFT', revision: { increment: 1 }, scheduledAt: null, scheduledRevision: null, scheduleReason: null, scheduleError: null, updatedBy: actor.id, updatedAt: new Date() } });
      await this.auth.audit(tx, req, 'CONTENT_SCHEDULE_CANCELLED', id, input.reason, {}, 'CONTENT_ITEM');
      return adminContentMutationResponseSchema.parse({ id, revision: updated.revision, status: updated.status, scheduledAt: null });
    });
  }

  @Post('admin/content/:id/archive') async archive(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    z.string().uuid().parse(id); const actor = await this.editor(req); const input = contentStateChangeSchema.parse(body);
    return this.locked(async tx => {
      const item = await this.loadLocked(tx, id);
      if (item.revision !== input.revision) throw new ConflictException({ code: 'CONTENT_CONFLICT', message: '内容が変更されました。' });
      if (item.status === 'SCHEDULED') throw new ConflictException({ code: 'CONTENT_SCHEDULED', message: '予約を取り消してから公開終了してください。' });
      if (!item.versions.length) throw new ConflictException({ code: 'CONTENT_UNPUBLISHED', message: '未公開の下書きは公開終了できません。' });
      const updated = await tx.contentItem.update({ where: { id }, data: { status: 'ARCHIVED', isVisible: false, revision: { increment: 1 }, updatedBy: actor.id, updatedAt: new Date() } });
      await this.auth.audit(tx, req, 'CONTENT_ARCHIVED', id, input.reason, { latestVersion: item.versions[0]?.version }, 'CONTENT_ITEM');
      return adminContentMutationResponseSchema.parse({ id, revision: updated.revision, status: updated.status, scheduledAt: null });
    });
  }

  @Post('admin/content/:id/restore') async restore(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    z.string().uuid().parse(id); const actor = await this.editor(req); const input = contentStateChangeSchema.parse(body);
    return this.locked(async tx => {
      const item = await this.loadLocked(tx, id);
      if (item.revision !== input.revision || item.status !== 'ARCHIVED') throw new ConflictException({ code: 'CONTENT_CONFLICT', message: '公開終了状態を確認してください。' });
      const updated = await tx.contentItem.update({ where: { id }, data: { status: 'DRAFT', revision: { increment: 1 }, updatedBy: actor.id, updatedAt: new Date() } });
      await this.auth.audit(tx, req, 'CONTENT_RESTORED', id, input.reason, {}, 'CONTENT_ITEM');
      return adminContentMutationResponseSchema.parse({ id, revision: updated.revision, status: updated.status, scheduledAt: null });
    });
  }

  private async optionalActor(req: AppRequest) {
    try { return await this.auth.authenticate(req); } catch (error) { if (error instanceof UnauthorizedException) return null; throw error; }
  }

  private async access(actor: AuthContext | null, version: { visibility: string; publishedAt: Date }) {
    if (version.visibility === 'PUBLIC') return true;
    if (!actor) return false;
    if (version.visibility === 'MEMBERS' || actor.role !== 'MEMBER') return true;
    const [entitlements, settings] = await Promise.all([
      this.auth.db.entitlement.findMany({ where: { userId: actor.id } }),
      this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { contentAccessPolicy: true } })
    ]);
    return canReadPrediction({ now: new Date(), publishedAt: version.publishedAt, visibility: 'PAID', raceDate: jstDate(version.publishedAt), entitlements, contentKind: 'CONTENT', contentAccessPolicy: parseContentAccessPolicy(settings.contentAccessPolicy) });
  }

  @Get('content') async list(@Req() req: AppRequest, @Query() query: unknown) {
    const actor = await this.optionalActor(req);
    const { page, kind, category } = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1), kind: z.enum(['ALL', 'ARTICLE', 'VIDEO', 'AUDIO']).default('ALL'), category: z.string().trim().max(80).optional() }).parse(query);
    const conditions = [Prisma.sql`ci."isVisible" = true`];
    if (kind !== 'ALL') conditions.push(Prisma.sql`latest.kind = ${kind}`);
    if (category) conditions.push(Prisma.sql`latest.category = ${category}`);
    const where = Prisma.join(conditions, ' AND ');
    const [items, totals, categories] = await this.auth.db.$transaction([
      this.auth.db.$queryRaw<PublicVersionRow[]>`
        WITH latest AS (
          SELECT DISTINCT ON (v."contentId") v."contentId", v.version, v.kind, v.title, v.summary, v."thumbnailUrl", v.category, v.tags, v."relatedRaceIds", v.visibility, v."publishedAt"
          FROM content_versions v ORDER BY v."contentId", v.version DESC
        )
        SELECT ci.id AS "contentId", latest.version, latest.kind, latest.title, latest.summary, latest."thumbnailUrl", latest.category, latest.tags, latest.visibility, latest."publishedAt"
        FROM content_items ci JOIN latest ON latest."contentId" = ci.id
        WHERE ${where}
        ORDER BY latest."publishedAt" DESC, ci.id DESC LIMIT 20 OFFSET ${(page - 1) * 20}`,
      this.auth.db.$queryRaw<Array<{ count: bigint }>>`
        WITH latest AS (
          SELECT DISTINCT ON (v."contentId") v."contentId", v.kind, v.category
          FROM content_versions v ORDER BY v."contentId", v.version DESC
        )
        SELECT count(*)::bigint AS count FROM content_items ci JOIN latest ON latest."contentId" = ci.id WHERE ${where}`,
      this.auth.db.$queryRaw<Array<{ category: string }>>`
        WITH latest AS (
          SELECT DISTINCT ON (v."contentId") v."contentId", v.category
          FROM content_versions v ORDER BY v."contentId", v.version DESC
        )
        SELECT DISTINCT latest.category FROM content_items ci JOIN latest ON latest."contentId" = ci.id
        WHERE ci."isVisible" = true ORDER BY latest.category`
    ]);
    const rows = await Promise.all(items.map(async version => ({ ...publicMetadata(version.contentId, version), locked: !await this.access(actor, version) })));
    return publicContentListResponseSchema.parse({ items: rows, total: Number(totals[0]?.count ?? 0), page, limit: 20, filters: { kind, category: category ?? null, categories: categories.map(row => row.category) } });
  }

  @Get('content/:id') async read(@Req() req: AppRequest, @Param('id') id: string) {
    z.string().uuid().parse(id); const actor = await this.optionalActor(req);
    const item = await this.auth.db.contentItem.findFirst({ where: { id, isVisible: true, versions: { some: {} } }, select: { id: true, versions: { orderBy: { version: 'desc' }, take: 1, select: versionSelect } } });
    if (!item?.versions[0]) throw new NotFoundException();
    const version = item.versions[0]; const metadata = publicMetadata(item.id, version);
    const relatedRaces = version.relatedRaceIds.length ? await this.auth.db.race.findMany({ where: { id: { in: version.relatedRaceIds } }, select: { id: true, raceDate: true, venue: true, number: true, name: true, startsAt: true }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }] }) : [];
    if (!await this.access(actor, version)) return publicContentDetailResponseSchema.parse({ ...metadata, locked: true, relatedRaces });
    const snapshot = contentDraftSchema.parse(version.snapshot);
    return publicContentDetailResponseSchema.parse({ ...metadata, locked: false, body: snapshot.body, mediaUrl: snapshot.mediaUrl, relatedRaces });
  }

  @Get('races/:raceId/content') async relatedToRace(@Req() req: AppRequest, @Param('raceId') raceId: string) {
    z.string().uuid().parse(raceId); const actor = await this.optionalActor(req);
    if (!await this.auth.db.race.count({ where: { id: raceId } })) throw new NotFoundException();
    const items = await this.auth.db.$queryRaw<PublicVersionRow[]>`
      WITH latest AS (
        SELECT DISTINCT ON (v."contentId") v."contentId", v.version, v.kind, v.title, v.summary, v."thumbnailUrl", v.category, v.tags, v."relatedRaceIds", v.visibility, v."publishedAt"
        FROM content_versions v ORDER BY v."contentId", v.version DESC
      )
      SELECT ci.id AS "contentId", latest.version, latest.kind, latest.title, latest.summary, latest."thumbnailUrl", latest.category, latest.tags, latest."relatedRaceIds", latest.visibility, latest."publishedAt"
      FROM content_items ci JOIN latest ON latest."contentId" = ci.id
      WHERE ci."isVisible" = true AND latest."relatedRaceIds" @> ARRAY[${raceId}::uuid]
      ORDER BY latest."publishedAt" DESC, ci.id DESC LIMIT 20`;
    const rows = await Promise.all(items.map(async version => ({ ...publicMetadata(version.contentId, version), locked: !await this.access(actor, version) })));
    return publicRaceRelatedContentResponseSchema.parse({ items: rows });
  }
}
