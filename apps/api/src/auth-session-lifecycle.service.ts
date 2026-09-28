import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { ExternalAuthFlow } from './auth-session.service';
import type { AppRequest, AuthContext } from './context';
import { ReferralsService } from './referrals.service';
import { SupabaseAuthService } from './supabase-auth.service';

@Injectable()
export class AuthSessionLifecycleService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SupabaseAuthService) private readonly supabase: SupabaseAuthService,
    @Inject(ReferralsService) private readonly referrals: ReferralsService
  ) {}

  async completeExternalFlow(code: string, verifier: string, flow: ExternalAuthFlow, req: AppRequest) {
    const session = await this.supabase.exchangeCode(code, verifier);
    const user = await this.auth.db.user.findUnique({ where: { authSubject: session.user.id } });
    if (!user || user.disabledAt) throw new UnauthorizedException();
    req.auth = { id: user.id, role: user.role, aal: 1, user };
    await this.auth.db.$transaction(async tx => {
      if (!user.emailVerifiedAt && (session.user.email_confirmed_at || session.user.confirmed_at)) await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(session.user.email_confirmed_at ?? session.user.confirmed_at!) } });
      await this.auth.journey(tx, user.id, 'FIRST_LOGIN');
      if (flow === 'signup' && (session.user.email_confirmed_at || session.user.confirmed_at)) await this.referrals.qualify(tx, user.id, req);
      await this.auth.audit(tx, req, flow === 'recovery' ? 'PASSWORD_RECOVERY_VERIFIED' : 'EMAIL_VERIFIED', user.id, flow === 'recovery' ? 'Supabaseパスワード再設定本人確認' : 'Supabaseメールアドレス確認完了');
    });
    return session;
  }

  async refreshExternal(refreshToken: string) {
    const session = await this.supabase.refresh(refreshToken);
    const user = await this.auth.db.user.findUnique({ where: { authSubject: session.user.id } });
    if (!user || user.disabledAt) throw new UnauthorizedException();
    return session;
  }

  async logoutExternal(req: AppRequest, accessToken: string | null) {
    let identity: Awaited<ReturnType<AuthService['authenticate']>> | undefined;
    try { identity = await this.auth.authenticate(req); } catch { identity = undefined; }
    if (accessToken !== null) await this.supabase.logout(accessToken);
    if (identity) await this.auth.db.$transaction(async tx => this.auth.audit(tx, req, 'LOGOUT', identity!.id, 'Supabaseログアウト'));
  }

  async logoutLocal(identity: AuthContext, req: AppRequest) {
    if (!identity.sessionId) return;
    await this.auth.db.$transaction(async tx => {
      await tx.session.deleteMany({ where: { id: identity.sessionId } });
      await this.auth.audit(tx, req, 'LOGOUT', identity.id, 'ログアウト');
    });
  }
}
