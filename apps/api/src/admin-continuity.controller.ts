import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Req } from '@nestjs/common';
import { administratorContinuitySatisfied, administratorDemotionSchema, administratorStatusSchema, canManage, requiresMfa } from '@keiba/domain';
import type { ManagedStaffRole, Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

const promotionSchema = z.object({
  confirmationEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  reason: z.string().trim().min(1).max(500)
}).strict();

type AdministratorRow = {
  id: string; email: string | null; role: Role; disabledAt: Date | null; emailVerifiedAt: Date | null;
  mfaSecret: string | null; externalMfaFactorId: string | null; externalBackupMfaFactorId: string | null;
};

@Controller('admin/continuity')
export class AdminContinuityController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private provider(): 'SUPABASE' | 'LOCAL_DEVELOPMENT' {
    return process.env.AUTH_PROVIDER === 'supabase' ? 'SUPABASE' : 'LOCAL_DEVELOPMENT';
  }

  private readiness(admin: Pick<AdministratorRow, 'mfaSecret' | 'externalMfaFactorId' | 'externalBackupMfaFactorId'>) {
    return {
      primaryMfaReady: this.provider() === 'SUPABASE' ? !!admin.externalMfaFactorId : !!admin.mfaSecret,
      backupMfaReady: this.provider() === 'SUPABASE' ? !!admin.externalBackupMfaFactorId : false
    };
  }

  private async administrator(req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    if (!canManage(identity, ['ADMIN'])) throw new ForbiddenException({ code: identity.role === 'ADMIN' ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '管理者権限と二段階認証が必要です。' });
    return identity;
  }

  private async activeAdministrators(tx: Prisma.TransactionClient, excludedId?: string) {
    return tx.$queryRaw<AdministratorRow[]>`
      SELECT "id", "email", "role", "disabledAt", "emailVerifiedAt", "mfaSecret", "externalMfaFactorId", "externalBackupMfaFactorId"
      FROM "users"
      WHERE "role" = 'ADMIN'::"Role" AND "disabledAt" IS NULL
        AND (${excludedId ?? null}::uuid IS NULL OR "id" <> ${excludedId ?? null}::uuid)
      ORDER BY "id" FOR SHARE
    `;
  }

  private ensureContinuity(remaining: AdministratorRow[]) {
    if (administratorContinuitySatisfied({ provider: this.provider(), remaining: remaining.map(admin => this.readiness(admin)) })) return;
    throw new ConflictException({
      code: 'ADMIN_CONTINUITY_REQUIRED',
      message: this.provider() === 'SUPABASE'
        ? '変更後も主・予備の認証アプリを設定済みの有効な管理者を2名以上残してください。'
        : '変更後も有効な管理者を2名以上残してください。'
    });
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
  async status(@Req() req: AppRequest) {
    await this.administrator(req);
    const [admins, candidates] = await this.auth.db.$transaction([
      this.auth.db.user.findMany({
        where: { role: 'ADMIN' },
        select: { id: true, displayName: true, email: true, registrationMethod: true, mfaSecret: true, externalMfaFactorId: true, externalBackupMfaFactorId: true, disabledAt: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      }),
      this.auth.db.user.findMany({
        where: { role: { not: 'ADMIN' }, disabledAt: null, email: { not: null }, emailVerifiedAt: { not: null } },
        select: { id: true, displayName: true, email: true, role: true, registrationMethod: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100
      })
    ]);
    const provider = this.provider();
    const items = admins.map(admin => ({
      id: admin.id, displayName: admin.displayName, email: admin.email, registrationMethod: admin.registrationMethod,
      disabledAt: admin.disabledAt, createdAt: admin.createdAt, ...this.readiness(admin)
    }));
    const administrators = items.filter(item => !item.disabledAt);
    const suspendedAdministrators = items.filter(item => !!item.disabledAt);
    const primaryReady = administrators.filter(item => item.primaryMfaReady).length;
    const backupReady = administrators.filter(item => item.backupMfaReady).length;
    return {
      provider,
      counts: { administrators: administrators.length, suspendedAdministrators: suspendedAdministrators.length, primaryReady, backupReady },
      ready: administratorContinuitySatisfied({ provider, remaining: administrators }),
      administrators,
      suspendedAdministrators,
      candidates,
      policy: { minimumAdministrators: 2, backupFactorPerAdministrator: true, customRecoveryCodes: false }
    };
  }

  @Post('administrators/:userId/promote')
  async promote(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    await this.administrator(req); z.string().uuid().parse(userId); const input = promotionSchema.parse(body);
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262028)::text`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))::text`;
        const rows = await tx.$queryRaw<Array<{ id: string; email: string | null; role: Role; disabledAt: Date | null; emailVerifiedAt: Date | null }>>`
          SELECT "id", "email", "role", "disabledAt", "emailVerifiedAt" FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE
        `;
        const target = rows[0];
        if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '対象アカウントが見つかりません。' });
        if (target.disabledAt || !target.email || !target.emailVerifiedAt) throw new ConflictException({ code: 'ADMIN_CANDIDATE_NOT_READY', message: '有効で確認済みのメールアカウントだけを管理者にできます。' });
        if (target.email.toLowerCase() !== input.confirmationEmail) throw new ConflictException({ code: 'ADMIN_CONFIRMATION_MISMATCH', message: '確認用メールアドレスが一致しません。' });
        if (target.role === 'ADMIN') throw new ConflictException({ code: 'ADMIN_ALREADY_ASSIGNED', message: 'このアカウントはすでに管理者です。' });
        const access = await this.memberAccessDependencies(tx, target.id);
        if (Object.values(access).some(Boolean)) throw new ConflictException({ code: 'ADMIN_ACTIVE_MEMBER_ACCESS', message: '有効または申込中の契約、1日利用、閲覧権限があります。アクセス終了後に管理者へ変更してください。' });
        await tx.user.update({ where: { id: target.id }, data: { role: 'ADMIN' } });
        const revokedLocalSessions = await tx.session.deleteMany({ where: { userId: target.id } });
        await this.auth.audit(tx, req, 'ADMIN_PROMOTED', target.id, input.reason, { previousRole: target.role, nextRole: 'ADMIN', localSessionsRevoked: revokedLocalSessions.count });
        return { userId: target.id, role: 'ADMIN' as const, localSessionsRevoked: revokedLocalSessions.count, mfaEnrollmentRequired: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictException({ code: 'ADMIN_PROMOTION_CONFLICT', message: '同時に状態が変わりました。最新の状態を確認してください。' });
      throw error;
    }
  }

  @Patch('administrators/:userId/status')
  async changeStatus(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.administrator(req); z.string().uuid().parse(userId); const input = administratorStatusSchema.parse(body);
    if (actor.id === userId) throw new ConflictException({ code: 'ADMIN_SELF_CHANGE_FORBIDDEN', message: '自分自身の管理者アカウントは停止できません。別の管理者が操作してください。' });
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262028)::text`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))::text`;
        const rows = await tx.$queryRaw<AdministratorRow[]>`
          SELECT "id", "email", "role", "disabledAt", "emailVerifiedAt", "mfaSecret", "externalMfaFactorId", "externalBackupMfaFactorId"
          FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE
        `;
        const target = rows[0];
        if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '対象アカウントが見つかりません。' });
        if (target.role !== 'ADMIN' || !target.email || !target.emailVerifiedAt) throw new ConflictException({ code: 'ADMIN_ACCOUNT_NOT_READY', message: '確認済みメールを持つ管理者だけを停止・再開できます。' });
        if (target.email.toLowerCase() !== input.confirmationEmail) throw new ConflictException({ code: 'ADMIN_CONFIRMATION_MISMATCH', message: '確認用メールアドレスが一致しません。' });
        if (await tx.accountClosure.findUnique({ where: { userId: target.id }, select: { id: true } })) throw new ConflictException({ code: 'ADMIN_ACCOUNT_CLOSED', message: '退会記録があるアカウントは管理者管理から再開できません。' });
        if (input.action === 'RESTORE') {
          if (!target.disabledAt) throw new ConflictException({ code: 'ADMIN_ALREADY_ACTIVE', message: 'この管理者アカウントはすでに有効です。' });
          await tx.user.update({ where: { id: target.id }, data: { disabledAt: null } });
          const revokedLocalSessions = await tx.session.deleteMany({ where: { userId: target.id } });
          await this.auth.audit(tx, req, 'ADMIN_ACCOUNT_RESTORED', target.id, input.reason, { localSessionsRevoked: revokedLocalSessions.count });
          return { userId: target.id, role: 'ADMIN' as const, status: 'ACTIVE' as const, localSessionsRevoked: revokedLocalSessions.count };
        }
        if (target.disabledAt) throw new ConflictException({ code: 'ADMIN_ALREADY_SUSPENDED', message: 'この管理者アカウントはすでに停止済みです。' });
        this.ensureContinuity(await this.activeAdministrators(tx, target.id));
        const pendingPublicationSchedules = await tx.publicationSchedule.count({ where: { createdBy: target.id, status: { in: ['PENDING', 'PROCESSING'] } } });
        if (pendingPublicationSchedules) throw new ConflictException({ code: 'ADMIN_SCHEDULES_PENDING', message: 'この管理者が作成した待機中または処理中の配信予約を取消・完了してから停止してください。' });
        const now = new Date(); await tx.user.update({ where: { id: target.id }, data: { disabledAt: now } });
        const revokedLocalSessions = await tx.session.deleteMany({ where: { userId: target.id } });
        await this.auth.audit(tx, req, 'ADMIN_ACCOUNT_SUSPENDED', target.id, input.reason, { suspendedAt: now.toISOString(), localSessionsRevoked: revokedLocalSessions.count });
        return { userId: target.id, role: 'ADMIN' as const, status: 'SUSPENDED' as const, suspendedAt: now, localSessionsRevoked: revokedLocalSessions.count };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictException({ code: 'ADMIN_STATUS_CONFLICT', message: '同時に状態が変わりました。最新の状態を確認してください。' });
      throw error;
    }
  }

  @Patch('administrators/:userId/demote')
  async demote(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.administrator(req); z.string().uuid().parse(userId); const input = administratorDemotionSchema.parse(body);
    if (actor.id === userId) throw new ConflictException({ code: 'ADMIN_SELF_CHANGE_FORBIDDEN', message: '自分自身の管理者ロールは変更できません。別の管理者が操作してください。' });
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262028)::text`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))::text`;
        const rows = await tx.$queryRaw<AdministratorRow[]>`
          SELECT "id", "email", "role", "disabledAt", "emailVerifiedAt", "mfaSecret", "externalMfaFactorId", "externalBackupMfaFactorId"
          FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE
        `;
        const target = rows[0];
        if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '対象アカウントが見つかりません。' });
        if (target.role !== 'ADMIN' || target.disabledAt || !target.email || !target.emailVerifiedAt) throw new ConflictException({ code: 'ADMIN_ACCOUNT_NOT_READY', message: '有効で確認済みメールを持つ管理者だけを降格できます。' });
        if (target.email.toLowerCase() !== input.confirmationEmail) throw new ConflictException({ code: 'ADMIN_CONFIRMATION_MISMATCH', message: '確認用メールアドレスが一致しません。' });
        this.ensureContinuity(await this.activeAdministrators(tx, target.id));
        const pendingPublicationSchedules = await tx.publicationSchedule.count({ where: { createdBy: target.id, status: { in: ['PENDING', 'PROCESSING'] } } });
        if (pendingPublicationSchedules && input.nextRole !== 'OPERATOR') throw new ConflictException({ code: 'ADMIN_SCHEDULES_PENDING', message: 'この管理者が作成した待機中または処理中の配信予約を取消・完了するか、運営担当へ変更してください。' });
        if (input.nextRole !== 'MEMBER') {
          const access = await this.memberAccessDependencies(tx, target.id);
          if (Object.values(access).some(Boolean)) throw new ConflictException({ code: 'ADMIN_ACTIVE_MEMBER_ACCESS', message: '有効または申込中の契約、1日利用、閲覧権限があります。会員として変更するか、アクセス終了後にスタッフへ変更してください。' });
        }
        await tx.user.update({ where: { id: target.id }, data: { role: input.nextRole } });
        const revokedLocalSessions = await tx.session.deleteMany({ where: { userId: target.id } });
        await this.auth.audit(tx, req, 'ADMIN_DEMOTED', target.id, input.reason, { previousRole: 'ADMIN', nextRole: input.nextRole, localSessionsRevoked: revokedLocalSessions.count });
        return { userId: target.id, previousRole: 'ADMIN' as const, nextRole: input.nextRole as ManagedStaffRole, localSessionsRevoked: revokedLocalSessions.count, mfaEnrollmentRequired: requiresMfa(input.nextRole), win5MfaRequired: input.nextRole === 'OPERATOR' };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictException({ code: 'ADMIN_DEMOTION_CONFLICT', message: '同時に状態が変わりました。最新の状態を確認してください。' });
      throw error;
    }
  }
}
