import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Req } from '@nestjs/common';
import { canManage, jstDate, managedStaffRoles, requiresMfa, staffAccountStatusSchema, staffResponsibilityTransferSchema, staffRoleChangeSchema } from '@keiba/domain';
import type { ManagedStaffRole, Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

@Controller('admin/staff')
export class StaffController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async administrator(req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    if (!canManage(identity, ['ADMIN'])) throw new ForbiddenException({ code: identity.role === 'ADMIN' ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '管理者権限と二段階認証が必要です。' });
    return identity;
  }

  private async dependencies(tx: Prisma.TransactionClient | AuthService['db'], userId: string, now = new Date()) {
    const [upcomingRaceAssignments, activeWin5Products, pendingPublicationSchedules] = await Promise.all([
      tx.expertAssignment.count({ where: { userId, race: { startsAt: { gt: now }, status: { notIn: ['FINISHED', 'CANCELLED'] } } } }),
      tx.predictionProduct.count({ where: { expertId: userId, targetDate: { gte: jstDate(now) }, status: { notIn: ['CANCELLED', 'CLOSED'] } } }),
      tx.publicationSchedule.count({ where: { createdBy: userId, status: { in: ['PENDING', 'PROCESSING'] } } })
    ]);
    return { upcomingRaceAssignments, activeWin5Products, pendingPublicationSchedules };
  }

  private async memberAccessDependencies(tx: Prisma.TransactionClient, userId: string, now = new Date()) {
    const [activeSubscriptions, activeDayPasses, activeEntitlements, pendingCheckouts] = await Promise.all([
      tx.subscription.count({ where: { userId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] }, currentPeriodEndsAt: { gt: now } } }),
      tx.dayPass.count({ where: { userId, status: { in: ['PENDING', 'ACTIVE'] }, endsAt: { gt: now } } }),
      tx.entitlement.count({ where: { userId, revokedAt: null, endsAt: { gt: now } } }),
      tx.billingCheckout.count({ where: { userId, status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: now } } })
    ]);
    return { activeSubscriptions, activeDayPasses, activeEntitlements, pendingCheckouts };
  }

  @Get()
  async list(@Req() req: AppRequest) {
    await this.administrator(req);
    const users = await this.auth.db.user.findMany({
      where: { email: { not: null }, emailVerifiedAt: { not: null }, OR: [{ disabledAt: null, role: { in: [...managedStaffRoles] } }, { disabledAt: { not: null }, role: { in: ['EXPERT', 'EDITOR', 'OPERATOR'] } }] },
      select: { id: true, displayName: true, email: true, role: true, registrationMethod: true, disabledAt: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { role: 'asc' }, { id: 'asc' }],
      take: 200
    });
    const accounts = await Promise.all(users.map(async user => ({ ...user, dependencies: ['EXPERT', 'OPERATOR'].includes(user.role) ? await this.dependencies(this.auth.db, user.id) : { upcomingRaceAssignments: 0, activeWin5Products: 0, pendingPublicationSchedules: 0 } })));
    return {
      accounts,
      roles: managedStaffRoles.map(role => ({ role, mfaRequired: requiresMfa(role as Role), win5MfaRequired: role === 'OPERATOR', reserved: role === 'EDITOR' })),
      policy: { administratorChangesManagedSeparately: true, verifiedEmailRequired: true, reasonRequired: true, sessionsRevoked: true, expertDependenciesProtected: true }
    };
  }

  @Patch(':userId/role')
  async changeRole(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.administrator(req);
    z.string().uuid().parse(userId);
    const input = staffRoleChangeSchema.parse(body);
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262027)::text`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))::text`;
        const rows = await tx.$queryRaw<Array<{ id: string; email: string | null; role: Role; disabledAt: Date | null; emailVerifiedAt: Date | null }>>`
          SELECT "id", "email", "role", "disabledAt", "emailVerifiedAt"
          FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE
        `;
        const target = rows[0];
        if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '対象アカウントが見つかりません。' });
        if (target.id === actor.id || target.role === 'ADMIN') throw new ConflictException({ code: 'STAFF_ADMIN_MANAGED_SEPARATELY', message: '管理者ロールは管理者継続運用画面で管理してください。' });
        if (target.disabledAt || !target.email || !target.emailVerifiedAt) throw new ConflictException({ code: 'STAFF_ACCOUNT_NOT_READY', message: '有効でメール確認済みのアカウントだけを変更できます。' });
        if (!managedStaffRoles.includes(target.role as ManagedStaffRole)) throw new ConflictException({ code: 'STAFF_ROLE_NOT_MANAGED', message: 'このロールはスタッフ権限管理の対象外です。' });
        if (target.email.toLowerCase() !== input.confirmationEmail) throw new ConflictException({ code: 'STAFF_CONFIRMATION_MISMATCH', message: '確認用メールアドレスが一致しません。' });
        if (target.role !== input.expectedRole) throw new ConflictException({ code: 'STAFF_ROLE_CHANGED', message: '別の操作でロールが変更されました。最新の状態を確認してください。' });
        if (target.role === 'MEMBER' && input.nextRole !== 'MEMBER') {
          const access = await this.memberAccessDependencies(tx, target.id);
          if (Object.values(access).some(Boolean)) throw new ConflictException({ code: 'STAFF_ACTIVE_MEMBER_ACCESS', message: '有効または申込中の契約、1日利用、閲覧権限があります。会員利用が終了してからスタッフロールへ変更してください。' });
        }
        const dependencies = await this.dependencies(tx, target.id);
        if (target.role === 'OPERATOR' && input.nextRole !== 'OPERATOR' && dependencies.pendingPublicationSchedules) throw new ConflictException({ code: 'STAFF_SCHEDULES_PENDING', message: '待機中または処理中の配信予約を取消・完了してから運営担当ロールを変更してください。' });
        if (target.role === 'EXPERT' && input.nextRole !== 'EXPERT') {
          if (dependencies.upcomingRaceAssignments || dependencies.activeWin5Products) throw new ConflictException({
            code: 'STAFF_EXPERT_STILL_ASSIGNED',
            message: '今後の担当レースまたは有効なWIN5担当を解除してから専門家ロールを変更してください。',
            details: dependencies
          });
        }
        await tx.user.update({ where: { id: target.id }, data: { role: input.nextRole } });
        const revokedLocalSessions = await tx.session.deleteMany({ where: { userId: target.id } });
        await this.auth.audit(tx, req, 'STAFF_ROLE_CHANGED', target.id, input.reason, {
          previousRole: target.role, nextRole: input.nextRole, localSessionsRevoked: revokedLocalSessions.count
        });
        return {
          userId: target.id,
          previousRole: target.role,
          nextRole: input.nextRole,
          localSessionsRevoked: revokedLocalSessions.count,
          mfaEnrollmentRequired: requiresMfa(input.nextRole),
          win5MfaRequired: input.nextRole === 'OPERATOR'
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictException({ code: 'STAFF_ROLE_CHANGE_CONFLICT', message: '同時に状態が変わりました。最新の状態を確認してください。' });
      throw error;
    }
  }

  @Patch(':userId/status')
  async changeStatus(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.administrator(req);
    z.string().uuid().parse(userId);
    const input = staffAccountStatusSchema.parse(body);
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262027)::text`;
        const rows = await tx.$queryRaw<Array<{ id: string; email: string | null; role: Role; disabledAt: Date | null; emailVerifiedAt: Date | null }>>`
          SELECT "id", "email", "role", "disabledAt", "emailVerifiedAt"
          FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE
        `;
        const target = rows[0];
        if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '対象アカウントが見つかりません。' });
        if (target.id === actor.id || target.role === 'ADMIN' || target.role === 'MEMBER') throw new ConflictException({ code: 'STAFF_STATUS_NOT_MANAGED', message: '専門家・編集担当・運営担当のアカウントだけを停止・再開できます。' });
        if (target.role !== input.expectedRole) throw new ConflictException({ code: 'STAFF_ROLE_CHANGED', message: '別の操作でロールが変更されました。最新の状態を確認してください。' });
        if (!target.email || !target.emailVerifiedAt) throw new ConflictException({ code: 'STAFF_ACCOUNT_NOT_READY', message: '確認済みメールを持つスタッフアカウントだけを変更できます。' });
        if (target.email.toLowerCase() !== input.confirmationEmail) throw new ConflictException({ code: 'STAFF_CONFIRMATION_MISMATCH', message: '確認用メールアドレスが一致しません。' });
        const closure = await tx.accountClosure.findUnique({ where: { userId: target.id }, select: { id: true } });
        if (closure) throw new ConflictException({ code: 'STAFF_ACCOUNT_CLOSED', message: '退会記録があるアカウントはスタッフ管理から再開できません。' });
        if (input.action === 'RESTORE') {
          if (!target.disabledAt) throw new ConflictException({ code: 'STAFF_ALREADY_ACTIVE', message: 'このスタッフアカウントはすでに有効です。' });
          await tx.user.update({ where: { id: target.id }, data: { disabledAt: null } });
          const revokedLocalSessions = await tx.session.deleteMany({ where: { userId: target.id } });
          await this.auth.audit(tx, req, 'STAFF_ACCOUNT_RESTORED', target.id, input.reason, { role: target.role, localSessionsRevoked: revokedLocalSessions.count });
          return { userId: target.id, role: target.role, status: 'ACTIVE' as const, localSessionsRevoked: revokedLocalSessions.count };
        }
        if (target.disabledAt) throw new ConflictException({ code: 'STAFF_ALREADY_SUSPENDED', message: 'このスタッフアカウントはすでに停止済みです。' });
        const now = new Date(); const dependencies = await this.dependencies(tx, target.id, now);
        if (dependencies.upcomingRaceAssignments || dependencies.activeWin5Products || dependencies.pendingPublicationSchedules) throw new ConflictException({ code: 'STAFF_OPERATIONAL_DEPENDENCIES', message: '担当レース、WIN5、配信予約を移管または完了してから停止してください。' });
        const access = await this.memberAccessDependencies(tx, target.id, now);
        if (Object.values(access).some(Boolean)) throw new ConflictException({ code: 'STAFF_ACTIVE_MEMBER_ACCESS', message: '有効または申込中の契約、1日利用、閲覧権限があります。会員アクセスへの影響を確認してから停止してください。' });
        await tx.user.update({ where: { id: target.id }, data: { disabledAt: now } });
        const revokedLocalSessions = await tx.session.deleteMany({ where: { userId: target.id } });
        await this.auth.audit(tx, req, 'STAFF_ACCOUNT_SUSPENDED', target.id, input.reason, { role: target.role, suspendedAt: now.toISOString(), localSessionsRevoked: revokedLocalSessions.count });
        return { userId: target.id, role: target.role, status: 'SUSPENDED' as const, suspendedAt: now, localSessionsRevoked: revokedLocalSessions.count };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictException({ code: 'STAFF_STATUS_CONFLICT', message: '同時に状態が変わりました。最新の状態を確認してください。' });
      throw error;
    }
  }

  @Patch(':userId/responsibilities')
  async transferResponsibilities(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.administrator(req);
    z.string().uuid().parse(userId);
    const input = staffResponsibilityTransferSchema.parse(body);
    if (userId === input.nextExpertId) throw new ConflictException({ code: 'STAFF_TRANSFER_SAME_EXPERT', message: '移管先には別の専門家を選択してください。' });
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262027)::text`;
        const ids = [userId, input.nextExpertId].sort();
        const users = await tx.$queryRaw<Array<{ id: string; email: string | null; displayName: string; role: Role; disabledAt: Date | null; emailVerifiedAt: Date | null }>>`
          SELECT "id", "email", "displayName", "role", "disabledAt", "emailVerifiedAt"
          FROM "users" WHERE "id" IN (${ids[0]}::uuid, ${ids[1]}::uuid) ORDER BY "id" FOR UPDATE
        `;
        const source = users.find(user => user.id === userId); const destination = users.find(user => user.id === input.nextExpertId);
        if (!source) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '移管元アカウントが見つかりません。' });
        if (!destination) throw new NotFoundException({ code: 'DESTINATION_EXPERT_NOT_FOUND', message: '移管先の専門家が見つかりません。' });
        if (source.role !== 'EXPERT' || source.disabledAt || !source.email || !source.emailVerifiedAt) throw new ConflictException({ code: 'SOURCE_EXPERT_NOT_READY', message: '有効な確認済み専門家だけを移管元にできます。' });
        if (destination.role !== 'EXPERT' || destination.disabledAt || !destination.emailVerifiedAt) throw new ConflictException({ code: 'DESTINATION_EXPERT_NOT_READY', message: '有効な確認済み専門家だけを移管先にできます。' });
        if (source.email.toLowerCase() !== input.confirmationEmail) throw new ConflictException({ code: 'STAFF_CONFIRMATION_MISMATCH', message: '移管元の確認用メールアドレスが一致しません。' });
        const now = new Date(); const current = await this.dependencies(tx, source.id, now);
        if (current.upcomingRaceAssignments !== input.expectedUpcomingRaceAssignments || current.activeWin5Products !== input.expectedActiveWin5Products) throw new ConflictException({ code: 'STAFF_DEPENDENCIES_CHANGED', message: '担当件数が変更されました。最新の状態を確認してください。' });
        if (!current.upcomingRaceAssignments && !current.activeWin5Products) throw new ConflictException({ code: 'STAFF_NOTHING_TO_TRANSFER', message: '移管対象の担当はありません。' });
        const assignments = await tx.expertAssignment.findMany({ where: { userId: source.id, race: { startsAt: { gt: now }, status: { notIn: ['FINISHED', 'CANCELLED'] } } }, select: { raceId: true } });
        if (assignments.length) {
          await tx.expertAssignment.createMany({ data: assignments.map(item => ({ raceId: item.raceId, userId: destination.id })), skipDuplicates: true });
          await tx.expertAssignment.deleteMany({ where: { userId: source.id, raceId: { in: assignments.map(item => item.raceId) } } });
        }
        const products = await tx.predictionProduct.updateMany({
          where: { expertId: source.id, targetDate: { gte: jstDate(now) }, status: { notIn: ['CANCELLED', 'CLOSED'] } },
          data: { expertId: destination.id, revision: { increment: 1 }, updatedBy: actor.id, updatedAt: now }
        });
        await this.auth.audit(tx, req, 'STAFF_RESPONSIBILITIES_TRANSFERRED', source.id, input.reason, {
          nextExpertId: destination.id, upcomingRaceAssignments: assignments.length, activeWin5Products: products.count
        });
        return { sourceExpertId: source.id, nextExpert: { id: destination.id, displayName: destination.displayName }, upcomingRaceAssignments: assignments.length, activeWin5Products: products.count };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictException({ code: 'STAFF_TRANSFER_CONFLICT', message: '同時に担当が変更されました。最新の状態を確認してください。' });
      throw error;
    }
  }
}
