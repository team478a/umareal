import { Inject, Injectable } from '@nestjs/common';
import {
  adminAuditResponseSchema,
  adminUsersResponseSchema,
} from '@keiba/domain';
import type {
  AdminAuditQuery,
  AdminAuditResponse,
  AdminUsersResponse,
} from '@keiba/domain';
import type { Prisma } from '@keiba/db';
import { DbService } from './db.service';

@Injectable()
export class AdminDirectoryQueryService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async users(page: number, limit: number): Promise<AdminUsersResponse> {
    const [items, total] = await this.db.$transaction([
      this.db.user.findMany({
        select: {
          id: true,
          email: true,
          emailVerifiedAt: true,
          registrationMethod: true,
          lineAccount: { select: { unlinkedAt: true } },
          displayName: true,
          role: true,
          createdAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.user.count(),
    ]);

    return adminUsersResponseSchema.parse({ items, total, page, limit });
  }

  async audit(input: AdminAuditQuery): Promise<AdminAuditResponse> {
    const { page, limit, from, to, action, targetType, requestId } = input;
    const createdAt = from || to
      ? {
          ...(from ? { gte: new Date(`${from}T00:00:00+09:00`) } : {}),
          ...(to ? { lt: new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 86_400_000) } : {}),
        }
      : undefined;
    const where: Prisma.AuditLogWhereInput = {
      ...(createdAt ? { createdAt } : {}),
      ...(action ? { action: { contains: action, mode: 'insensitive' } } : {}),
      ...(targetType ? { targetType: { contains: targetType, mode: 'insensitive' } } : {}),
      ...(requestId ? { requestId } : {}),
    };
    const [audits, total] = await this.db.$transaction([
      this.db.auditLog.findMany({
        where,
        select: {
          id: true,
          actorId: true,
          actorRole: true,
          action: true,
          targetType: true,
          targetId: true,
          reason: true,
          createdAt: true,
          requestId: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.db.auditLog.count({ where }),
    ]);
    const actorIds = [...new Set(audits.flatMap(audit => audit.actorId ? [audit.actorId] : []))];
    const actors = actorIds.length
      ? await this.db.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const actorNames = new Map(actors.map(actor => [actor.id, actor.displayName]));

    return adminAuditResponseSchema.parse({
      items: audits.map(audit => ({
        id: audit.id,
        action: audit.action,
        targetType: audit.targetType,
        targetId: audit.targetId,
        reason: audit.reason,
        actorRole: audit.actorRole,
        actorDisplayName: audit.actorId ? actorNames.get(audit.actorId) ?? null : null,
        createdAt: audit.createdAt,
        requestId: audit.requestId,
      })),
      total,
      page,
      limit,
      filters: {
        from: from ?? null,
        to: to ?? null,
        action: action ?? null,
        targetType: targetType ?? null,
        requestId: requestId ?? null,
      },
    });
  }
}
