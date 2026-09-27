import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { fallbackEmailSchema } from '@keiba/domain';
import type { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest, AuthContext } from './context';
import { MailService } from './mail.service';
import { hashPassword, hashToken, newToken } from './security';
import { SupabaseAuthService } from './supabase-auth.service';

type FallbackEmailInput = z.infer<typeof fallbackEmailSchema>;

@Injectable()
export class AuthCredentialService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SupabaseAuthService) private readonly supabase: SupabaseAuthService,
    @Inject(MailService) private readonly mail: MailService
  ) {}

  async addFallback(actor: AuthContext, input: FallbackEmailInput, req: AppRequest) {
    if (actor.user.emailVerifiedAt && actor.user.passwordHash) throw new ConflictException({ code: 'FALLBACK_ALREADY_CONFIGURED', message: '確認済みメールアドレスは設定済みです。' });
    if (await this.auth.db.user.findFirst({ where: { email: input.email, id: { not: actor.id } } })) throw new ConflictException({ code: 'EMAIL_ALREADY_USED', message: 'このメールアドレスは使用できません。' });
    const passwordHash = await hashPassword(input.password);
    await this.mail.sendVerification({ userId: actor.id, email: input.email, purpose: 'ADD_FALLBACK', passwordHash });
    await this.auth.db.$transaction(async tx => this.auth.audit(tx, req, 'FALLBACK_EMAIL_REQUEST', actor.id, '予備メールアドレス確認を開始'));
  }

  async requestPasswordReset(email: string, req: AppRequest, externalChallenge?: string) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      if (!externalChallenge) throw new Error('Supabase password recovery requires a PKCE challenge');
      await this.supabase.recover(email, externalChallenge, `${process.env.APP_BASE_URL}/api/v1/auth/callback`);
      return;
    }

    this.auth.ensureLocal();
    const user = await this.auth.db.user.findUnique({ where: { email } });
    if (!user || !user.emailVerifiedAt || !user.passwordHash || user.disabledAt) return;
    const token = newToken();
    await this.auth.db.$transaction(async tx => {
      await tx.passwordReset.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 15 * 60000) } });
      await this.auth.audit(tx, req, 'PASSWORD_RESET_REQUEST', user.id, '再設定リンク発行');
    });
    await this.mail.send({ userId: user.id, to: email, kind: 'PASSWORD_RESET', url: `${process.env.APP_BASE_URL}/reset-password?token=${token}`, expiresInMinutes: 15, idempotencyKey: `reset-${hashToken(token)}` });
  }

  async resetExternalPassword(actorId: string, password: string, accessToken: string, req: AppRequest) {
    await this.supabase.updatePassword(accessToken, password);
    await this.auth.db.$transaction(async tx => this.auth.audit(tx, req, 'PASSWORD_RESET', actorId, 'Supabaseパスワード再設定'));
  }

  async resetLocalPassword(token: string, password: string, req: AppRequest) {
    const passwordHash = await hashPassword(password);
    await this.auth.db.$transaction(async tx => {
      const reset = await tx.passwordReset.findUnique({ where: { tokenHash: hashToken(token) } });
      if (!reset || reset.usedAt || reset.expiresAt <= new Date()) throw new BadRequestException({ code: 'RESET_INVALID', message: '再設定リンクが無効、または期限切れです。' });
      const consumed = await tx.passwordReset.updateMany({ where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (consumed.count !== 1) throw new BadRequestException('RESET_INVALID');
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: reset.userId } });
      await tx.passwordReset.updateMany({ where: { userId: reset.userId, usedAt: null }, data: { usedAt: new Date() } });
      await this.auth.audit(tx, req, 'PASSWORD_RESET', reset.userId, 'パスワード再設定・全セッション失効');
    });
  }
}
