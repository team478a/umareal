import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { canManage, requiresMfa, supportEventType, supportMessageSchema, supportRequestSchema, supportStatuses, supportStatusSchema, supportTriageSchema } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

const adminQuerySchema = z.object({ status: z.enum(['ALL', ...supportStatuses]).default('ALL') }).strict();

@Controller()
export class SupportController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private key(req: AppRequest, userId: string, scope = 'create') {
    return `support:${scope}:${userId}:${z.string().uuid().parse(req.headers['idempotency-key'])}`;
  }

  private async staff(req: AppRequest, roles: Role[]) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, roles)) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '問い合わせ対応の権限を確認してください。' });
    return actor;
  }

  @Get('support/me')
  async mine(@Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    const items = await this.auth.db.supportRequest.findMany({
      where: { userId: actor.id },
      select: { id: true, category: true, subject: true, message: true, status: true, createdAt: true, updatedAt: true, events: { where: { publicMessage: { not: null } }, select: { id: true, eventType: true, actorRole: true, publicMessage: true, occurredAt: true }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] } },
      orderBy: { createdAt: 'desc' }, take: 100
    });
    return { items };
  }

  @Post('support/requests/:id/messages')
  async addMessage(@Param('id') id: string, @Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    z.string().uuid().parse(id);
    const input = supportMessageSchema.parse(body);
    const key = this.key(req, actor.id, `message:${id}`); const requestHash = hashToken(JSON.stringify(input));
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`support:${id}`}))::text`;
        const previous = await tx.idempotencyKey.findUnique({ where: { key } });
        if (previous) {
          if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ受付キーが異なる内容で使われています。' });
          return previous.response;
        }
        const current = await tx.supportRequest.findFirst({ where: { id, userId: actor.id } });
        if (!current) throw new NotFoundException({ code: 'SUPPORT_REQUEST_NOT_FOUND', message: '問い合わせを確認できません。' });
        const reopened = current.status === 'RESOLVED';
        const updated = await tx.supportRequest.update({ where: { id }, data: { status: reopened ? 'OPEN' : current.status, updatedAt: new Date() } });
        const supportEvent = await tx.supportEvent.create({ data: { requestId: id, eventType: 'MEMBER_MESSAGE', actorId: actor.id, actorRole: 'MEMBER', reason: reopened ? '会員本人の追加質問により受付を再開' : '会員本人による追加情報', publicMessage: input.message } });
        const response = { id: supportEvent.id, requestId: id, status: updated.status, reopened, occurredAt: supportEvent.occurredAt.toISOString() };
        await tx.idempotencyKey.create({ data: { key, requestHash, response } });
        await this.auth.audit(tx, req, 'SUPPORT_MEMBER_MESSAGE_ADDED', id, reopened ? '会員本人の追加質問により受付を再開' : '会員本人による追加情報', { previousStatus: current.status, status: updated.status, reopened });
        return response;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (previous?.requestHash === requestHash) return previous.response;
      throw new ConflictException({ code: 'SUPPORT_MESSAGE_CONFLICT', message: '追記状態が競合しました。再読み込みしてください。' });
    }
  }

  @Post('support/requests')
  async create(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    const input = supportRequestSchema.parse(body);
    const key = this.key(req, actor.id); const requestHash = hashToken(JSON.stringify(input));
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
        const previous = await tx.idempotencyKey.findUnique({ where: { key } });
        if (previous) {
          if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ受付キーが異なる内容で使われています。' });
          return previous.response;
        }
        const support = await tx.supportRequest.create({ data: { userId: actor.id, category: input.category, subject: input.subject, message: input.message, events: { create: { eventType: 'CREATED', actorId: actor.id, actorRole: 'MEMBER', reason: '会員本人による問い合わせ受付' } } } });
        const response = { id: support.id, category: support.category, subject: support.subject, status: support.status, createdAt: support.createdAt.toISOString() };
        await tx.idempotencyKey.create({ data: { key, requestHash, response } });
        await this.auth.audit(tx, req, 'SUPPORT_REQUEST_CREATED', support.id, '会員本人による一般問い合わせ受付', { category: support.category });
        return response;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (previous?.requestHash === requestHash) return previous.response;
      throw new ConflictException({ code: 'SUPPORT_REQUEST_CONFLICT', message: '受付状態が競合しました。再読み込みしてください。' });
    }
  }

  @Get('admin/support')
  async admin(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    const { status } = adminQuerySchema.parse(query);
    const now = new Date();
    const [items, assignees] = await Promise.all([
      this.auth.db.supportRequest.findMany({
        where: status === 'ALL' ? {} : { status },
        select: { id: true, category: true, subject: true, message: true, status: true, priority: true, assignedToId: true, dueAt: true, createdAt: true, updatedAt: true, user: { select: { id: true, displayName: true, email: true } }, assignee: { select: { id: true, displayName: true, role: true, disabledAt: true } }, events: { select: { id: true, eventType: true, actorRole: true, reason: true, publicMessage: true, occurredAt: true, actor: { select: { displayName: true } } }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] } },
        take: 200
      }),
      this.auth.db.user.findMany({ where: { role: { in: ['ADMIN', 'OPERATOR'] }, disabledAt: null }, select: { id: true, displayName: true, role: true }, orderBy: [{ role: 'asc' }, { displayName: 'asc' }] })
    ]);
    const priorityRank: Record<string, number> = { LOW: 0, NORMAL: 1, HIGH: 2, URGENT: 3 };
    items.sort((a, b) => {
      const aQueue = a.status === 'RESOLVED' ? 2 : a.dueAt && a.dueAt < now ? 0 : 1;
      const bQueue = b.status === 'RESOLVED' ? 2 : b.dueAt && b.dueAt < now ? 0 : 1;
      return aQueue - bQueue || priorityRank[b.priority] - priorityRank[a.priority] || (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) || b.updatedAt.getTime() - a.updatedAt.getTime();
    });
    return { items, assignees, now: now.toISOString() };
  }

  @Post('admin/support/:id/triage')
  async triage(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN', 'OPERATOR']); z.string().uuid().parse(id);
    const input = supportTriageSchema.parse(body); const dueAt = input.dueAt ? new Date(input.dueAt) : null;
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`support:${id}`}))::text`;
      const current = await tx.supportRequest.findUnique({ where: { id }, select: { id: true, priority: true, assignedToId: true, dueAt: true, category: true } });
      if (!current) throw new NotFoundException({ code: 'SUPPORT_REQUEST_NOT_FOUND', message: '問い合わせを確認できません。' });
      if (input.assignedToId && !await tx.user.findFirst({ where: { id: input.assignedToId, role: { in: ['ADMIN', 'OPERATOR'] }, disabledAt: null }, select: { id: true } })) {
        throw new ConflictException({ code: 'SUPPORT_ASSIGNEE_INVALID', message: '有効な管理者または運営担当を選択してください。' });
      }
      const unchanged = current.priority === input.priority && current.assignedToId === input.assignedToId && current.dueAt?.getTime() === dueAt?.getTime();
      if (unchanged) throw new ConflictException({ code: 'SUPPORT_TRIAGE_UNCHANGED', message: '担当、優先度、対応期限のいずれかを変更してください。' });
      const updated = await tx.supportRequest.update({ where: { id }, data: { priority: input.priority, assignedToId: input.assignedToId, dueAt, updatedAt: new Date() }, select: { id: true, priority: true, assignedToId: true, dueAt: true, updatedAt: true, assignee: { select: { id: true, displayName: true, role: true } } } });
      await tx.supportEvent.create({ data: { requestId: id, eventType: 'TRIAGED', actorId: actor.id, actorRole: actor.role, reason: input.reason } });
      await this.auth.audit(tx, req, 'SUPPORT_TRIAGE_UPDATED', id, input.reason, { category: current.category, previous: { priority: current.priority, assignedToId: current.assignedToId, dueAt: current.dueAt?.toISOString() ?? null }, next: { priority: input.priority, assignedToId: input.assignedToId, dueAt: input.dueAt } });
      return updated;
    });
  }

  @Post('admin/support/:id/status')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN', 'OPERATOR']); z.string().uuid().parse(id);
    const input = supportStatusSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`support:${id}`}))::text`;
      const current = await tx.supportRequest.findUnique({ where: { id } });
      if (!current) throw new NotFoundException({ code: 'SUPPORT_REQUEST_NOT_FOUND', message: '問い合わせを確認できません。' });
      const eventType = supportEventType(current.status, input.status);
      if (!eventType) throw new ConflictException({ code: 'SUPPORT_TRANSITION_INVALID', message: '現在の状態から指定された状態へ変更できません。' });
      const updated = await tx.supportRequest.update({ where: { id }, data: { status: input.status, updatedAt: new Date() } });
      const supportEvent = await tx.supportEvent.create({ data: { requestId: id, eventType, actorId: actor.id, actorRole: actor.role, reason: input.reason, publicMessage: input.status === 'RESOLVED' ? input.publicReply! : null } });
      if (input.status === 'RESOLVED') await tx.notificationEvent.create({ data: { supportEventId: supportEvent.id, eventType: 'SUPPORT_RESPONSE_POSTED', status: 'QUEUED', payload: { supportRequestId: id, supportEventId: supportEvent.id } } });
      await this.auth.audit(tx, req, 'SUPPORT_STATUS_CHANGED', id, input.reason, { category: current.category, previousStatus: current.status, status: input.status, memberReplyProvided: input.status === 'RESOLVED' });
      return { id: updated.id, status: updated.status, updatedAt: updated.updatedAt };
    });
  }
}
