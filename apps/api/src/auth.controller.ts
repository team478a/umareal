import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { fallbackEmailSchema, launchCapabilities, loginSchema, mfaCodeSchema, publicAuthConfigResponseSchema, registrationSchema, resolveLaunchMode } from '@keiba/domain';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { RegistrationCaptchaService } from './registration-captcha.service';
import { AuthSessionService } from './auth-session.service';
import { AuthRegistrationService } from './auth-registration.service';
import { AuthCredentialService } from './auth-credential.service';
import { AuthMfaService } from './auth-mfa.service';
import { AuthLoginService } from './auth-login.service';
import { AuthSessionLifecycleService } from './auth-session-lifecycle.service';

const publicUser = (user: { id: string; displayName: string; role: string }) => ({ id: user.id, displayName: user.displayName, role: user.role });
const externalMfaEnrollSchema = z.object({ kind: z.enum(['PRIMARY', 'BACKUP']).default('PRIMARY') }).strict();
const externalMfaVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/), factor: z.enum(['PRIMARY', 'BACKUP']).default('PRIMARY'), factorId: z.string().uuid().optional() }).strict();
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(RegistrationCaptchaService) private readonly captcha: RegistrationCaptchaService, @Inject(AuthSessionService) private readonly sessions: AuthSessionService, @Inject(AuthRegistrationService) private readonly registration: AuthRegistrationService, @Inject(AuthCredentialService) private readonly credentials: AuthCredentialService, @Inject(AuthMfaService) private readonly mfa: AuthMfaService, @Inject(AuthLoginService) private readonly loginService: AuthLoginService, @Inject(AuthSessionLifecycleService) private readonly sessionLifecycle: AuthSessionLifecycleService) {}
  @Get('config') async config() {
    const mode = resolveLaunchMode(process.env.LAUNCH_MODE);
    const capabilities = launchCapabilities(mode);
    const [settings, registration, captcha] = await Promise.all([
      this.auth.db.systemSetting.findUnique({ where: { id: 'global' }, select: { emailNotificationsEnabled: true, lineLoginEnabled: true, lineNotificationsEnabled: true } }),
      this.auth.registrationAvailability(),
      this.captcha.publicConfig()
    ]);
    return publicAuthConfigResponseSchema.parse({
      provider: process.env.AUTH_PROVIDER,
      localOnly: process.env.AUTH_PROVIDER === 'local',
      launchMode: mode,
      capabilities,
      registration,
      captcha,
      emailNotificationsEnabled: settings?.emailNotificationsEnabled === true,
      lineEnabled: capabilities.lineLogin && settings?.lineLoginEnabled === true,
      lineNotificationsEnabled: capabilities.lineNotifications && settings?.lineNotificationsEnabled === true
    });
  }
  @Post('register') async register(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const input = registrationSchema.parse(body);
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const flow = this.sessions.createPkce();
      const result = await this.registration.register(input, req, {
        externalChallenge: flow.challenge,
        onExternalSignUp: () => this.sessions.setExternalFlow(res, flow.verifier, 'signup'),
        onExternalSession: session => { this.sessions.setExternalSession(res, session); this.sessions.clearExternalFlow(res); }
      });
      if (!result.user) return { user: null, requiresEmailVerification: true };
      this.sessions.clearLocalSession(res);
      return { user: publicUser(result.user), requiresEmailVerification: !result.session };
    }
    const result = await this.registration.register(input, req, { onLocalMembershipCreated: () => this.sessions.clearLocalSession(res) });
    if (!result.user) throw new Error('Local registration did not create a user');
    return { user: publicUser(result.user), requiresEmailVerification: true };
  }
  @Post('email/resend') async resendVerification(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email } = z.object({ email: z.string().trim().email().max(254).transform(v => v.toLowerCase()) }).strict().parse(body);
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const flow = this.sessions.createPkce(); this.sessions.setExternalFlow(res, flow.verifier, 'signup');
      await this.registration.resendVerification(email, flow.challenge);
      return { message: '確認が必要なメールアドレスの場合、案内を送信しました。' };
    }
    await this.registration.resendVerification(email);
    return { message: '確認が必要なメールアドレスの場合、案内を送信しました。' };
  }
  @Post('email/fallback') async addFallback(@Body() body: unknown, @Req() req: AppRequest) {
    this.auth.ensureLocal(); const actor = await this.auth.authenticate(req); const input = fallbackEmailSchema.parse(body);
    await this.credentials.addFallback(actor, input, req);
    return { message: '確認メールを送信しました。' };
  }
  @Post('email/verify') async verifyEmail(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const { token } = z.object({ token: z.string().min(32).max(128) }).strict().parse(body);
    const result = await this.registration.verifyEmail(token, req);
    this.sessions.setLocalSession(res, result.sessionToken); return { user: publicUser(result.user), verified: true };
  }
  @Post('login') async login(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const input = loginSchema.parse(body);
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const result = await this.loginService.loginExternal(input, req);
      this.sessions.setExternalSession(res, result.session);
      this.sessions.clearLocalSession(res);
      return { user: publicUser(result.user) };
    }
    this.auth.ensureLocal();
    const result = await this.loginService.loginLocal(input, req);
    this.sessions.setLocalSession(res, result.sessionToken);
    return { user: publicUser(result.user) };
  }
  @Get('callback') async callback(@Query('code') codeValue: unknown, @Req() req: AppRequest, @Res() res: Response) {
    if (process.env.AUTH_PROVIDER !== 'supabase') return res.redirect(303, `${process.env.APP_BASE_URL}/login`);
    const parsed = z.string().uuid().safeParse(codeValue);
    const flowState = this.sessions.readExternalFlow(req);
    if (!parsed.success || !flowState) {
      this.sessions.clearExternalSession(res); return res.redirect(303, `${process.env.APP_BASE_URL}/login?auth=invalid`);
    }
    const { verifier, flow } = flowState;
    try {
      const session = await this.sessionLifecycle.completeExternalFlow(parsed.data, verifier, flow, req);
      this.sessions.setExternalSession(res, session);
      this.sessions.clearExternalFlow(res);
      return res.redirect(303, flow === 'recovery' ? `${process.env.APP_BASE_URL}/reset-password?ready=1` : `${process.env.APP_BASE_URL}/account?email=verified`);
    } catch { this.sessions.clearExternalSession(res); return res.redirect(303, `${process.env.APP_BASE_URL}/login?auth=invalid`); }
  }
  @Post('refresh') async refresh(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (process.env.AUTH_PROVIDER !== 'supabase') throw new UnauthorizedException();
    const refreshToken = this.sessions.readExternalRefreshToken(req);
    if (refreshToken === null) { this.sessions.clearExternalSession(res); throw new UnauthorizedException(); }
    try {
      const session = await this.sessionLifecycle.refreshExternal(refreshToken);
      this.sessions.setExternalSession(res, session); return { ok: true };
    } catch (error) { this.sessions.clearExternalSession(res); throw error; }
  }
  @Post('logout') async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const accessToken = this.sessions.readExternalAccessToken(req);
      await this.sessionLifecycle.logoutExternal(req, accessToken);
      this.sessions.clearExternalSession(res);
      this.sessions.clearLocalSession(res);
      return { ok: true };
    }
    const identity = await this.auth.authenticate(req);
    await this.sessionLifecycle.logoutLocal(identity, req);
    this.sessions.clearLocalSession(res);
    return { ok: true };
  }
  @Post('password/request') async requestReset(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const { email } = z.object({ email: z.string().email().transform(s => s.toLowerCase()) }).strict().parse(body);
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const flow = this.sessions.createPkce(); this.sessions.setExternalFlow(res, flow.verifier, 'recovery');
      await this.credentials.requestPasswordReset(email, req, flow.challenge);
      return { message: '登録されたメールアドレスの場合、再設定の案内を送信しました。' };
    }
    await this.credentials.requestPasswordReset(email, req);
    return { message: '登録されたメールアドレスの場合、再設定の案内を送信しました。' };
  }
  @Post('password/reset') async resetPassword(@Body() body: unknown, @Req() req: AppRequest) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const { password } = z.object({ token: z.unknown().optional(), password: z.string().min(12).max(128) }).strict().parse(body);
      const identity = await this.auth.authenticate(req);
      const accessToken = this.sessions.requireExternalAccessToken(req);
      await this.credentials.resetExternalPassword(identity.id, password, accessToken, req);
      return { ok: true };
    }
    this.auth.ensureLocal();
    const { token, password } = z.object({ token: z.string().min(32).max(128), password: z.string().min(12).max(128) }).strict().parse(body);
    await this.credentials.resetLocalPassword(token, password, req);
    return { ok: true };
  }
  @Post('mfa/enroll') async enroll(@Body() body: unknown, @Req() req: AppRequest) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const identity = await this.auth.authenticate(req);
      const { kind } = externalMfaEnrollSchema.parse(body ?? {});
      if (kind === 'PRIMARY' && identity.user.externalMfaFactorId) throw new ForbiddenException({ code: 'MFA_ALREADY_ENROLLED', message: '二段階認証は設定済みです。' });
      if (kind === 'BACKUP') {
        if (identity.role !== 'ADMIN' || identity.aal !== 2) throw new ForbiddenException({ code: 'MFA_REQUIRED', message: '予備認証アプリの追加には管理者権限と二段階認証が必要です。' });
        if (!identity.user.externalMfaFactorId) throw new BadRequestException({ code: 'MFA_PRIMARY_REQUIRED', message: '先に主認証アプリを設定してください。' });
        if (identity.user.externalBackupMfaFactorId) throw new ConflictException({ code: 'MFA_BACKUP_ALREADY_ENROLLED', message: '予備認証アプリは設定済みです。' });
      }
      return this.mfa.enrollExternal(identity, kind, req);
    }
    this.auth.ensureLocal();
    const identity = await this.auth.authenticate(req);
    if (identity.user.mfaSecret) throw new ForbiddenException({ code: 'MFA_ALREADY_ENROLLED', message: '二段階認証は設定済みです。' });
    return this.mfa.enrollLocal(identity, req);
  }
  @Post('mfa/verify') async verify(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const identity = await this.auth.authenticate(req);
      const input = externalMfaVerifySchema.parse(body);
      const session = await this.mfa.verifyExternal(identity, input, req);
      this.sessions.setExternalSession(res, session);
      return { verified: true };
    }
    this.auth.ensureLocal();
    const identity = await this.auth.authenticate(req);
    const { code } = mfaCodeSchema.parse(body);
    const token = await this.mfa.verifyLocal(identity, code, req);
    this.sessions.setLocalSession(res, token);
    return { ok: true };
  }
  @Post('mfa/backup/revoke') async revokeBackup(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (process.env.AUTH_PROVIDER !== 'supabase') throw new BadRequestException({ code: 'MFA_BACKUP_UNAVAILABLE', message: '予備認証アプリは本番認証で利用できます。' });
    const identity = await this.auth.authenticate(req);
    if (identity.role !== 'ADMIN' || identity.aal !== 2) throw new ForbiddenException({ code: 'MFA_REQUIRED', message: '予備認証アプリの解除には管理者権限と二段階認証が必要です。' });
    const { reason } = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(body);
    const factorId = identity.user.externalBackupMfaFactorId;
    if (!factorId) throw new BadRequestException({ code: 'MFA_BACKUP_NOT_ENROLLED', message: '予備認証アプリは設定されていません。' });
    await this.mfa.revokeExternalBackup(identity, factorId, reason, req);
    this.sessions.clearExternalSession(res);
    this.sessions.clearLocalSession(res);
    return { revoked: true, signedOut: true };
  }
}
