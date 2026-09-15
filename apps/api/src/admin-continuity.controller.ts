import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { canManage } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

const promotionSchema = z.object({
  confirmationEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  reason: z.string().trim().min(1).max(500)
}).strict();

@Controller('admin/continuity')
export class AdminContinuityController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async administrator(req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    if (!canManage(identity, ['ADMIN'])) throw new ForbiddenException({ code: identity.role === 'ADMIN' ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '管理者権限と二段階認証が必要です。' });
    return identity;
  }

  @Get()
  async status(@Req() req: AppRequest) {
    await this.administrator(req);
    const [admins, candidates] = await this.auth.db.$transaction([
      this.auth.db.user.findMany({
        where: { role: 'ADMIN', disabledAt: null },
        select: { id: true, displayName: true, email: true, registrationMethod: true, mfaSecret: true, externalMfaFactorId: true, externalBackupMfaFactorId: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      }),
      this.auth.db.user.findMany({
        where: { role: { not: 'ADMIN' }, disabledAt: null, email: { not: null }, emailVerifiedAt: { not: null } },
        select: { id: true, displayName: true, email: true, role: true, registrationMethod: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100
      })
    ]);
    const provider = process.env.AUTH_PROVIDER === 'supabase' ? 'SUPABASE' : 'LOCAL_DEVELOPMENT';
    const items = admins.map(admin => ({
      id: admin.id, displayName: admin.displayName, email: admin.email, registrationMethod: admin.registrationMethod, createdAt: admin.createdAt,
      primaryMfaReady: provider === 'SUPABASE' ? !!admin.externalMfaFactorId : !!admin.mfaSecret,
      backupMfaReady: provider === 'SUPABASE' ? !!admin.externalBackupMfaFactorId : false
    }));
    const primaryReady = items.filter(item => item.primaryMfaReady).length;
    const backupReady = items.filter(item => item.backupMfaReady).length;
    return {
      provider,
      counts: { administrators: items.length, primaryReady, backupReady },
      ready: provider === 'SUPABASE' && items.length >= 2 && primaryReady >= 2 && backupReady >= 2,
      administrators: items,
      candidates,
      policy: { minimumAdministrators: 2, backupFactorPerAdministrator: true, customRecoveryCodes: false }
    };
  }

  @Post('administrators/:userId/promote')
  async promote(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    await this.administrator(req);
    z.string().uuid().parse(userId);
    const input = promotionSchema.parse(body);
    try {
      return await this.auth.db.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{ id: string; email: string | null; role: Role; disabledAt: Date | null; emailVerifiedAt: Date | null }>>`
          SELECT "id", "email", "role", "disabledAt", "emailVerifiedAt"
          FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE
        `;
        const target = rows[0];
        if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: '対象アカウントが見つかりません。' });
        if (target.disabledAt || !target.email || !target.emailVerifiedAt) throw new ConflictException({ code: 'ADMIN_CANDIDATE_NOT_READY', message: '有効で確認済みのメールアカウントだけを管理者にできます。' });
        if (target.email.toLowerCase() !== input.confirmationEmail) throw new ConflictException({ code: 'ADMIN_CONFIRMATION_MISMATCH', message: '確認用メールアドレスが一致しません。' });
        if (target.role === 'ADMIN') throw new ConflictException({ code: 'ADMIN_ALREADY_ASSIGNED', message: 'このアカウントはすでに管理者です。' });
        await tx.user.update({ where: { id: target.id }, data: { role: 'ADMIN' } });
        const revokedLocalSessions = await tx.session.deleteMany({ where: { userId: target.id } });
        await this.auth.audit(tx, req, 'ADMIN_PROMOTED', target.id, input.reason, { previousRole: target.role, nextRole: 'ADMIN', localSessionsRevoked: revokedLocalSessions.count });
        return { userId: target.id, role: 'ADMIN' as const, localSessionsRevoked: revokedLocalSessions.count, mfaEnrollmentRequired: true };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') throw new ConflictException({ code: 'ADMIN_PROMOTION_CONFLICT', message: '同時に状態が変わりました。最新の状態を確認してください。' });
      throw error;
    }
  }
}
