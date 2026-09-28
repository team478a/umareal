import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { loginSchema } from '@keiba/domain';
import type { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { ReferralsService } from './referrals.service';
import { hashToken, verifyPassword } from './security';
import { SupabaseAuthService } from './supabase-auth.service';

type LoginInput = z.infer<typeof loginSchema>;

@Injectable()
export class AuthLoginService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SupabaseAuthService) private readonly supabase: SupabaseAuthService,
    @Inject(ReferralsService) private readonly referrals: ReferralsService
  ) {}

  async loginExternal(input: LoginInput, req: AppRequest) {
    const session = await this.supabase.signIn(input.email, input.password);
    const user = await this.auth.db.user.findUnique({ where: { authSubject: session.user.id } });
    if (!user || user.disabledAt) throw new UnauthorizedException({ code: 'LOGIN_FAILED', message: 'メールアドレスまたはパスワードを確認してください。' });
    req.auth = { id: user.id, role: user.role, aal: 1, user };
    await this.auth.db.$transaction(async tx => {
      if (!user.emailVerifiedAt && (session.user.email_confirmed_at || session.user.confirmed_at)) await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(session.user.email_confirmed_at ?? session.user.confirmed_at!) } });
      await this.auth.journey(tx, user.id, 'FIRST_LOGIN');
      if (session.user.email_confirmed_at || session.user.confirmed_at) await this.referrals.qualify(tx, user.id, req);
      await this.auth.audit(tx, req, 'LOGIN', user.id, 'Supabaseログイン');
    });
    return { user, session };
  }

  async loginLocal(input: LoginInput, req: AppRequest) {
    const user = await this.auth.db.user.findUnique({ where: { email: input.email } });
    // Keep password verification equal-cost for unknown addresses.
    const stored = user?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await verifyPassword(input.password, stored);
    if (!user || !valid || user.disabledAt) throw new UnauthorizedException({ code: 'LOGIN_FAILED', message: 'メールアドレスまたはパスワードを確認してください。' });
    if (!user.emailVerifiedAt) throw new ForbiddenException({ code: 'EMAIL_NOT_VERIFIED', message: '確認メールを開いて登録を完了してください。' });
    req.auth = { id: user.id, role: user.role, aal: 1, user };
    const sessionToken = await this.auth.db.$transaction(async tx => {
      if (typeof req.cookies?.keiba_session === 'string') await tx.session.deleteMany({ where: { tokenHash: hashToken(req.cookies.keiba_session) } });
      await this.auth.audit(tx, req, 'LOGIN', user.id, 'ログイン');
      return this.auth.session(tx, user.id);
    });
    return { user, sessionToken };
  }
}
