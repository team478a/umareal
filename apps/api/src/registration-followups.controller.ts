import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { canManage, requiresMfa } from '@keiba/domain';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { MailService } from './mail.service';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(['ALL', 'RECENT', 'OVERDUE']).default('ALL')
}).strict();
const resendSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const OVERDUE_MS = 30 * 60000;
const RESEND_COOLDOWN_MS = 5 * 60000;

@Controller('admin/registration-followups')
export class RegistrationFollowupsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(MailService) private readonly mail: MailService) {}

  @Get() async list(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req);
    const input = querySchema.parse(query); const now = new Date(); const overdueBefore = new Date(now.getTime() - OVERDUE_MS);
    const base = { role: 'MEMBER' as const, registrationMethod: 'EMAIL', email: { not: null }, emailVerifiedAt: null, disabledAt: null };
    const statusWhere = input.status === 'OVERDUE' ? { createdAt: { lte: overdueBefore } } : input.status === 'RECENT' ? { createdAt: { gt: overdueBefore } } : {};
    const where = { ...base, ...statusWhere };
    const [users, total, pending, overdue] = await this.auth.db.$transaction([
      this.auth.db.user.findMany({ where, select: { id: true, displayName: true, email: true, createdAt: true, emailVerifications: { where: { purpose: 'REGISTRATION' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { createdAt: true, expiresAt: true, usedAt: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (input.page - 1) * input.limit, take: input.limit }),
      this.auth.db.user.count({ where }),
      this.auth.db.user.count({ where: base }),
      this.auth.db.user.count({ where: { ...base, createdAt: { lte: overdueBefore } } })
    ]);
    const direct = process.env.AUTH_PROVIDER === 'local';
    return {
      items: users.map(user => {
        const verification = user.emailVerifications[0] ?? null;
        const availableAt = verification ? new Date(verification.createdAt.getTime() + RESEND_COOLDOWN_MS) : now;
        return { id: user.id, displayName: user.displayName, email: user.email, createdAt: user.createdAt, status: user.createdAt <= overdueBefore ? 'OVERDUE' : 'RECENT', lastVerification: verification, canResend: direct && availableAt <= now, resendAvailableAt: direct ? availableAt : null };
      }),
      total, page: input.page, limit: input.limit, status: input.status,
      counts: { pending, recent: pending - overdue, overdue },
      resendMode: direct ? 'ADMIN_DIRECT' : 'MEMBER_SELF_SERVICE', selfServicePath: '/verify-email', generatedAt: now
    };
  }

  @Post(':userId/resend') async resend(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    await this.staff(req); z.string().uuid().parse(userId); const input = resendSchema.parse(body);
    if (process.env.AUTH_PROVIDER !== 'local') throw new ConflictException({ code: 'MEMBER_SELF_SERVICE_REQUIRED', message: 'Supabase認証では、会員本人のブラウザーから確認メールを再送してください。', selfServicePath: '/verify-email' });
    const result = await this.mail.resendRegistrationForAdmin(userId, RESEND_COOLDOWN_MS);
    await this.auth.db.$transaction(async tx => this.auth.audit(tx, req, 'ADMIN_EMAIL_VERIFICATION_RESEND', userId, input.reason, { provider: 'local', expiresAt: result.expiresAt.toISOString() }));
    return { message: '確認メールを再送しました。', sentAt: result.sentAt, expiresAt: result.expiresAt };
  }

  private async staff(req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    if (!canManage(identity, ['ADMIN'])) throw new ForbiddenException({ code: requiresMfa(identity.role) && identity.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'この操作には管理者権限と二段階認証が必要です。' });
    return identity;
  }
}
