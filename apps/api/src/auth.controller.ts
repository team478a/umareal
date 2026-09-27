import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { TOTP, Secret } from 'otpauth';
import { fallbackEmailSchema, launchCapabilities, loginSchema, mfaCodeSchema, registrationSchema, resolveLaunchMode } from '@keiba/domain';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { decrypt, encrypt, hashToken, verifyPassword } from './security';
import { SupabaseAuthService } from './supabase-auth.service';
import { RegistrationCaptchaService } from './registration-captcha.service';
import { ReferralsService } from './referrals.service';
import { AuthSessionService } from './auth-session.service';
import { AuthRegistrationService } from './auth-registration.service';
import { AuthCredentialService } from './auth-credential.service';

const publicUser = (user: { id: string; displayName: string; role: string }) => ({ id: user.id, displayName: user.displayName, role: user.role });
const otp = (secret: string, email: string) => new TOTP({ issuer: '競馬会員メディア 開発用', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });
const externalMfaEnrollSchema = z.object({ kind: z.enum(['PRIMARY', 'BACKUP']).default('PRIMARY') }).strict();
const externalMfaVerifySchema = z.object({ code: z.string().regex(/^\d{6}$/), factor: z.enum(['PRIMARY', 'BACKUP']).default('PRIMARY'), factorId: z.string().uuid().optional() }).strict();
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SupabaseAuthService) private readonly supabase: SupabaseAuthService, @Inject(RegistrationCaptchaService) private readonly captcha: RegistrationCaptchaService, @Inject(ReferralsService) private readonly referrals: ReferralsService, @Inject(AuthSessionService) private readonly sessions: AuthSessionService, @Inject(AuthRegistrationService) private readonly registration: AuthRegistrationService, @Inject(AuthCredentialService) private readonly credentials: AuthCredentialService) {}
  @Get('config') async config() {
    const mode = resolveLaunchMode(process.env.LAUNCH_MODE);
    const capabilities = launchCapabilities(mode);
    const [settings, registration, captcha] = await Promise.all([
      this.auth.db.systemSetting.findUnique({ where: { id: 'global' }, select: { emailNotificationsEnabled: true, lineLoginEnabled: true, lineNotificationsEnabled: true } }),
      this.auth.registrationAvailability(),
      this.captcha.publicConfig()
    ]);
    return {
      provider: process.env.AUTH_PROVIDER,
      localOnly: process.env.AUTH_PROVIDER === 'local',
      launchMode: mode,
      capabilities,
      registration,
      captcha,
      emailNotificationsEnabled: settings?.emailNotificationsEnabled === true,
      lineEnabled: capabilities.lineLogin && settings?.lineLoginEnabled === true,
      lineNotificationsEnabled: capabilities.lineNotifications && settings?.lineNotificationsEnabled === true
    };
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
      this.sessions.setExternalSession(res, session);
      this.sessions.clearLocalSession(res);
      return { user: publicUser(user) };
    }
    this.auth.ensureLocal();
    const user = await this.auth.db.user.findUnique({ where: { email: input.email } });
    // Equal-cost password verification even for unknown addresses.
    const stored = user?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await verifyPassword(input.password, stored);
    if (!user || !valid || user.disabledAt) throw new UnauthorizedException({ code: 'LOGIN_FAILED', message: 'メールアドレスまたはパスワードを確認してください。' });
    if (!user.emailVerifiedAt) throw new ForbiddenException({ code: 'EMAIL_NOT_VERIFIED', message: '確認メールを開いて登録を完了してください。' });
    req.auth = { id: user.id, role: user.role, aal: 1, user };
    const token = await this.auth.db.$transaction(async tx => {
      if (typeof req.cookies?.keiba_session === 'string') await tx.session.deleteMany({ where: { tokenHash: hashToken(req.cookies.keiba_session) } });
      await this.auth.audit(tx, req, 'LOGIN', user.id, 'ログイン');
      return this.auth.session(tx, user.id);
    });
    this.sessions.setLocalSession(res, token);
    return { user: publicUser(user) };
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
      const session = await this.supabase.exchangeCode(parsed.data, verifier);
      const user = await this.auth.db.user.findUnique({ where: { authSubject: session.user.id } });
      if (!user || user.disabledAt) { this.sessions.clearExternalSession(res); return res.redirect(303, `${process.env.APP_BASE_URL}/login?auth=invalid`); }
      req.auth = { id: user.id, role: user.role, aal: 1, user };
      await this.auth.db.$transaction(async tx => {
        if (!user.emailVerifiedAt && (session.user.email_confirmed_at || session.user.confirmed_at)) await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(session.user.email_confirmed_at ?? session.user.confirmed_at!) } });
        await this.auth.journey(tx, user.id, 'FIRST_LOGIN');
        if (flow === 'signup' && (session.user.email_confirmed_at || session.user.confirmed_at)) await this.referrals.qualify(tx, user.id, req);
        await this.auth.audit(tx, req, flow === 'recovery' ? 'PASSWORD_RECOVERY_VERIFIED' : 'EMAIL_VERIFIED', user.id, flow === 'recovery' ? 'Supabaseパスワード再設定本人確認' : 'Supabaseメールアドレス確認完了');
      });
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
      const session = await this.supabase.refresh(refreshToken);
      const user = await this.auth.db.user.findUnique({ where: { authSubject: session.user.id } });
      if (!user || user.disabledAt) throw new UnauthorizedException();
      this.sessions.setExternalSession(res, session); return { ok: true };
    } catch (error) { this.sessions.clearExternalSession(res); throw error; }
  }
  @Post('logout') async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const accessToken = this.sessions.readExternalAccessToken(req);
      let identity: Awaited<ReturnType<AuthService['authenticate']>> | undefined;
      try { identity = await this.auth.authenticate(req); } catch { identity = undefined; }
      if (accessToken !== null) await this.supabase.logout(accessToken);
      if (identity) await this.auth.db.$transaction(async tx => this.auth.audit(tx, req, 'LOGOUT', identity!.id, 'Supabaseログアウト'));
      this.sessions.clearExternalSession(res);
      this.sessions.clearLocalSession(res);
      return { ok: true };
    }
    const identity = await this.auth.authenticate(req);
    if (identity.sessionId) await this.auth.db.$transaction(async tx => {
      await tx.session.deleteMany({ where: { id: identity.sessionId } });
      await this.auth.audit(tx, req, 'LOGOUT', identity.id, 'ログアウト');
    });
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
      const factor = await this.supabase.enrollTotp(this.sessions.requireExternalAccessToken(req, 8192));
      await this.auth.db.$transaction(async tx => {
        await tx.user.update({ where: { id: identity.id }, data: { pendingExternalMfaFactorId: factor.id, pendingExternalMfaKind: kind, pendingExternalMfaExpiresAt: new Date(Date.now() + 15 * 60_000) } });
        await this.auth.audit(tx, req, 'MFA_ENROLL_START', identity.id, kind === 'BACKUP' ? 'Supabase予備認証アプリの登録開始' : 'Supabase二段階認証の登録開始', { factorKind: kind });
      });
      return { factorId: factor.id, kind, secret: factor.totp.secret, uri: factor.totp.uri, qrCode: factor.totp.qr_code };
    }
    this.auth.ensureLocal();
    const identity = await this.auth.authenticate(req);
    if (identity.user.mfaSecret) throw new ForbiddenException({ code: 'MFA_ALREADY_ENROLLED', message: '二段階認証は設定済みです。' });
    const secret = new Secret({ size: 20 }).base32;
    await this.auth.db.$transaction(async tx => {
      await tx.user.update({ where: { id: identity.id }, data: { pendingMfaSecret: encrypt(secret) } });
      await this.auth.audit(tx, req, 'MFA_ENROLL_START', identity.id, '二段階認証の登録開始');
    });
    return { secret, uri: otp(secret, identity.user.email ?? `user-${identity.user.id}`).toString() };
  }
  @Post('mfa/verify') async verify(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const identity = await this.auth.authenticate(req);
      const { code, factor, factorId: submittedFactorId } = externalMfaVerifySchema.parse(body);
      const pending = submittedFactorId && identity.user.pendingExternalMfaFactorId === submittedFactorId
        ? { factorId: submittedFactorId, kind: identity.user.pendingExternalMfaKind, expiresAt: identity.user.pendingExternalMfaExpiresAt }
        : null;
      if (submittedFactorId && !pending && ![identity.user.externalMfaFactorId, identity.user.externalBackupMfaFactorId].includes(submittedFactorId)) throw new BadRequestException({ code: 'MFA_FACTOR_INVALID', message: '認証要素を確認できません。' });
      if (pending && (!pending.expiresAt || pending.expiresAt <= new Date() || !['PRIMARY', 'BACKUP'].includes(pending.kind ?? ''))) throw new BadRequestException({ code: 'MFA_ENROLLMENT_EXPIRED', message: '設定時間を過ぎました。もう一度登録を開始してください。' });
      const factorId = submittedFactorId ?? (factor === 'BACKUP' ? identity.user.externalBackupMfaFactorId : identity.user.externalMfaFactorId);
      if (!factorId) throw new BadRequestException({ code: 'MFA_NOT_ENROLLED', message: '二段階認証の設定を開始してください。' });
      const resolvedFactorKind = pending?.kind === 'BACKUP' || factorId === identity.user.externalBackupMfaFactorId ? 'BACKUP' : 'PRIMARY';
      const token = this.sessions.requireExternalAccessToken(req, 8192);
      const challenge = await this.supabase.challengeFactor(token, factorId);
      const session = await this.supabase.verifyFactor(token, factorId, challenge.id, code);
      if (session.user.id !== identity.user.authSubject) throw new UnauthorizedException();
      req.auth = { ...identity, aal: 2 };
      await this.auth.db.$transaction(async tx => {
        if (pending) {
          const field = pending.kind === 'BACKUP' ? 'externalBackupMfaFactorId' : 'externalMfaFactorId';
          const changed = await tx.user.updateMany({ where: { id: identity.id, pendingExternalMfaFactorId: factorId, pendingExternalMfaExpiresAt: { gt: new Date() }, ...(pending.kind === 'BACKUP' ? { externalMfaFactorId: { not: null }, externalBackupMfaFactorId: null } : { externalMfaFactorId: null }) }, data: { [field]: factorId, pendingExternalMfaFactorId: null, pendingExternalMfaKind: null, pendingExternalMfaExpiresAt: null } });
          if (changed.count !== 1) throw new ConflictException({ code: 'MFA_ENROLLMENT_CHANGED', message: '設定状態が変わりました。最新の状態を確認してください。' });
          await this.auth.audit(tx, req, 'MFA_FACTOR_ENROLLED', identity.id, pending.kind === 'BACKUP' ? 'Supabase予備認証アプリの登録完了' : 'Supabase二段階認証の登録完了', { factorKind: pending.kind, otherSessionsRevokedByProvider: true });
        } else {
          await this.auth.audit(tx, req, 'MFA_VERIFIED', identity.id, resolvedFactorKind === 'BACKUP' ? 'Supabase予備認証アプリで二段階認証成功' : 'Supabase二段階認証成功', { factorKind: resolvedFactorKind });
        }
      });
      this.sessions.setExternalSession(res, session);
      return { verified: true };
    }
    this.auth.ensureLocal();
    const identity = await this.auth.authenticate(req);
    const { code } = mfaCodeSchema.parse(body);
    const encrypted = identity.user.mfaSecret ?? identity.user.pendingMfaSecret;
    if (!encrypted || !identity.sessionId) throw new BadRequestException('MFA_NOT_ENROLLED');
    const timestamp = Date.now();
    const delta = otp(decrypt(encrypted), identity.user.email ?? `user-${identity.user.id}`).validate({ token: code, window: 1, timestamp });
    if (delta === null) throw new UnauthorizedException({ code: 'MFA_INVALID', message: '認証コードを確認してください。' });
    const step = BigInt(Math.floor(timestamp / 30000) + delta);
    const token = await this.auth.db.$transaction(async tx => {
      const changed = await tx.user.updateMany({ where: { id: identity.id, mfaSecret: identity.user.mfaSecret, pendingMfaSecret: identity.user.pendingMfaSecret, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaSecret: encrypted, pendingMfaSecret: null, mfaLastStep: step } });
      if (changed.count !== 1) throw new UnauthorizedException({ code: 'MFA_REPLAY', message: '次の認証コードで再度お試しください。' });
      await tx.session.delete({ where: { id: identity.sessionId } });
      await this.auth.audit(tx, req, 'MFA_VERIFIED', identity.id, '二段階認証成功');
      return this.auth.session(tx, identity.id, 2);
    });
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
    const accessToken = this.sessions.requireExternalAccessToken(req, 8192);
    await this.supabase.unenrollFactor(accessToken, factorId);
    await this.supabase.logout(accessToken);
    await this.auth.db.$transaction(async tx => {
      const changed = await tx.user.updateMany({ where: { id: identity.id, externalBackupMfaFactorId: factorId }, data: { externalBackupMfaFactorId: null } });
      if (changed.count !== 1) throw new ConflictException({ code: 'MFA_BACKUP_CHANGED', message: '設定状態が変わりました。最新の状態を確認してください。' });
      const localSessions = await tx.session.deleteMany({ where: { userId: identity.id } });
      await this.auth.audit(tx, req, 'MFA_BACKUP_REVOKED', identity.id, reason, { factorKind: 'BACKUP', providerSessionsRevoked: true, localSessionsRevoked: localSessions.count });
    });
    this.sessions.clearExternalSession(res);
    this.sessions.clearLocalSession(res);
    return { revoked: true, signedOut: true };
  }
}
