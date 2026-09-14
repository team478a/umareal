import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TOTP, Secret } from 'otpauth';
import { fallbackEmailSchema, loginSchema, mfaCodeSchema, registrationSchema } from '@keiba/domain';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { decrypt, encrypt, hashPassword, hashToken, newToken, verifyPassword } from './security';
import { MailService } from './mail.service';
import { SupabaseAuthService } from './supabase-auth.service';
import type { SupabaseSession } from './supabase-auth.service';

const publicUser = (user: { id: string; displayName: string; role: string }) => ({ id: user.id, displayName: user.displayName, role: user.role });
function cookie(res: Response, token: string) { res.cookie('keiba_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 8 * 3600000 }); }
const externalCookieOptions = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/' });
function externalCookies(res: Response, session: SupabaseSession) {
  res.cookie('keiba_access_token', session.access_token, { ...externalCookieOptions(), maxAge: session.expires_in * 1000 });
  res.cookie('keiba_refresh_token', session.refresh_token, { ...externalCookieOptions(), maxAge: 30 * 86400 * 1000 });
}
function clearExternalCookies(res: Response) {
  for (const name of ['keiba_access_token', 'keiba_refresh_token', 'keiba_pkce_verifier', 'keiba_auth_flow']) res.clearCookie(name, externalCookieOptions());
}
function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
function externalFlowCookies(res: Response, verifier: string, flow: 'signup' | 'recovery') {
  res.cookie('keiba_pkce_verifier', verifier, { ...externalCookieOptions(), maxAge: 24 * 3600000 });
  res.cookie('keiba_auth_flow', flow, { ...externalCookieOptions(), maxAge: 24 * 3600000 });
}
const otp = (secret: string, email: string) => new TOTP({ issuer: '競馬会員メディア 開発用', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SupabaseAuthService) private readonly supabase: SupabaseAuthService, @Inject(MailService) private readonly mail: MailService) {}
  private async sendVerification(userId: string, email: string, purpose: 'REGISTRATION' | 'ADD_FALLBACK', passwordHash?: string) {
    const token = newToken(), expiresInMinutes = 30;
    const verification = await this.auth.db.$transaction(async tx => {
      await tx.emailVerification.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: new Date() } });
      return tx.emailVerification.create({ data: { userId, tokenHash: hashToken(token), purpose, email, passwordHash, expiresAt: new Date(Date.now() + expiresInMinutes * 60000) } });
    });
    await this.mail.send({ userId, to: email, kind: purpose === 'REGISTRATION' ? 'VERIFY_EMAIL' : 'ADD_FALLBACK', url: `${process.env.APP_BASE_URL}/verify-email?token=${token}`, expiresInMinutes, idempotencyKey: verification.id });
  }
  @Get('config') async config() { const settings = await this.auth.db.systemSetting.findUnique({ where: { id: 'global' }, select: { lineLoginEnabled: true } }); return { provider: process.env.AUTH_PROVIDER, localOnly: process.env.AUTH_PROVIDER === 'local', lineEnabled: settings?.lineLoginEnabled === true }; }
  @Post('register') async register(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const input = registrationSchema.parse(body);
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const flow = pkce();
      const callbackUrl = `${process.env.APP_BASE_URL}/api/v1/auth/callback`;
      const result = await this.supabase.signUp({ email: input.email, password: input.password }, flow.challenge, callbackUrl);
      externalFlowCookies(res, flow.verifier, 'signup');
      // Supabase deliberately returns an identity-less user for an existing email.
      // Do not create a second local membership from that enumeration-safe response.
      if (Array.isArray(result.user.identities) && result.user.identities.length === 0) return { user: null, requiresEmailVerification: true };
      const existing = await this.auth.db.user.findFirst({ where: { OR: [{ authSubject: result.user.id }, { email: input.email }] } });
      if (existing && existing.authSubject !== result.user.id) throw new ConflictException({ code: 'ACCOUNT_LINK_REQUIRED', message: 'このメールアドレスは既存アカウントの確認が必要です。' });
      const user = existing ?? await this.auth.db.$transaction(async tx => {
        const created = await tx.user.create({ data: { authSubject: result.user.id, email: input.email, emailVerifiedAt: result.user.email_confirmed_at || result.user.confirmed_at ? new Date(result.user.email_confirmed_at ?? result.user.confirmed_at!) : null, displayName: input.displayName, registrationMethod: 'EMAIL',
          preferences: { create: {} }, acquisition: { create: { source: input.acquisition?.source ?? 'direct', medium: input.acquisition?.medium, campaign: input.acquisition?.campaign, content: input.acquisition?.content, term: input.acquisition?.term, landingPath: input.acquisition?.landingPath ?? '/register', referralCode: input.acquisition?.referralCode } }, consents: { create: [
            { documentType: 'AGE_20', version: '1', source: 'web-registration' },
            { documentType: 'TERMS', version: input.termsVersion, source: 'web-registration' },
            { documentType: 'PRIVACY', version: input.privacyVersion, source: 'web-registration' }
          ] } } });
        req.auth = { id: created.id, role: created.role, aal: 1, user: created };
        await this.auth.audit(tx, req, 'REGISTER', created.id, 'Supabase会員登録と同意記録');
        return created;
      });
      if (result.session) {
        externalCookies(res, result.session);
        res.clearCookie('keiba_pkce_verifier', externalCookieOptions()); res.clearCookie('keiba_auth_flow', externalCookieOptions());
        await this.auth.db.user.updateMany({ where: { id: user.id, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
      }
      res.clearCookie('keiba_session', { httpOnly: true, sameSite: 'lax', path: '/' });
      return { user: publicUser(user), requiresEmailVerification: !result.session };
    }
    this.auth.ensureLocal();
    const passwordHash = await hashPassword(input.password);
    const user = await this.auth.db.$transaction(async tx => {
      const user = await tx.user.create({ data: { email: input.email, displayName: input.displayName, passwordHash, registrationMethod: 'EMAIL',
        preferences: { create: {} }, acquisition: { create: { source: input.acquisition?.source ?? 'direct', medium: input.acquisition?.medium, campaign: input.acquisition?.campaign, content: input.acquisition?.content, term: input.acquisition?.term, landingPath: input.acquisition?.landingPath ?? '/register', referralCode: input.acquisition?.referralCode } }, consents: { create: [
          { documentType: 'AGE_20', version: '1', source: 'web-registration' },
          { documentType: 'TERMS', version: input.termsVersion, source: 'web-registration' },
          { documentType: 'PRIVACY', version: input.privacyVersion, source: 'web-registration' }
        ] } } });
      req.auth = { id: user.id, role: user.role, aal: 1, user };
      await this.auth.audit(tx, req, 'REGISTER', user.id, '会員登録と同意記録');
      return user;
    });
    res.clearCookie('keiba_session', { httpOnly: true, sameSite: 'lax', path: '/' });
    await this.sendVerification(user.id, input.email, 'REGISTRATION');
    return { user: publicUser(user), requiresEmailVerification: true };
  }
  @Post('email/resend') async resendVerification(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email } = z.object({ email: z.string().trim().email().max(254).transform(v => v.toLowerCase()) }).strict().parse(body);
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const flow = pkce(); externalFlowCookies(res, flow.verifier, 'signup');
      await this.supabase.resend(email, flow.challenge);
      return { message: '確認が必要なメールアドレスの場合、案内を送信しました。' };
    }
    this.auth.ensureLocal();
    const user = await this.auth.db.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && !user.disabledAt) await this.sendVerification(user.id, email, 'REGISTRATION');
    return { message: '確認が必要なメールアドレスの場合、案内を送信しました。' };
  }
  @Post('email/fallback') async addFallback(@Body() body: unknown, @Req() req: AppRequest) {
    this.auth.ensureLocal(); const actor = await this.auth.authenticate(req); const input = fallbackEmailSchema.parse(body);
    if (actor.user.emailVerifiedAt && actor.user.passwordHash) throw new ConflictException({ code: 'FALLBACK_ALREADY_CONFIGURED', message: '確認済みメールアドレスは設定済みです。' });
    if (await this.auth.db.user.findFirst({ where: { email: input.email, id: { not: actor.id } } })) throw new ConflictException({ code: 'EMAIL_ALREADY_USED', message: 'このメールアドレスは使用できません。' });
    const passwordHash = await hashPassword(input.password); await this.sendVerification(actor.id, input.email, 'ADD_FALLBACK', passwordHash);
    await this.auth.db.$transaction(async tx => this.auth.audit(tx, req, 'FALLBACK_EMAIL_REQUEST', actor.id, '予備メールアドレス確認を開始'));
    return { message: '確認メールを送信しました。' };
  }
  @Post('email/verify') async verifyEmail(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const { token } = z.object({ token: z.string().min(32).max(128) }).strict().parse(body); const now = new Date();
    const result = await this.auth.db.$transaction(async tx => {
      const verification = await tx.emailVerification.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
      if (!verification || verification.usedAt || verification.expiresAt <= now || verification.user.disabledAt) throw new BadRequestException({ code: 'EMAIL_VERIFICATION_INVALID', message: '確認リンクが無効、または期限切れです。' });
      const consumed = await tx.emailVerification.updateMany({ where: { id: verification.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (consumed.count !== 1) throw new BadRequestException({ code: 'EMAIL_VERIFICATION_INVALID', message: '確認リンクはすでに使用されています。' });
      const data = verification.purpose === 'ADD_FALLBACK' ? { email: verification.email, emailVerifiedAt: now, passwordHash: verification.passwordHash! } : { emailVerifiedAt: now };
      const user = await tx.user.update({ where: { id: verification.userId }, data }); req.auth = { id: user.id, role: user.role, aal: 1, user };
      await tx.emailVerification.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      await this.auth.audit(tx, req, verification.purpose === 'ADD_FALLBACK' ? 'FALLBACK_EMAIL_VERIFIED' : 'EMAIL_VERIFIED', user.id, 'メールアドレス確認完了');
      return { user, sessionToken: await this.auth.session(tx, user.id) };
    });
    cookie(res, result.sessionToken); return { user: publicUser(result.user), verified: true };
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
        await this.auth.audit(tx, req, 'LOGIN', user.id, 'Supabaseログイン');
      });
      externalCookies(res, session);
      res.clearCookie('keiba_session', { httpOnly: true, sameSite: 'lax', path: '/' });
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
    cookie(res, token);
    return { user: publicUser(user) };
  }
  @Get('callback') async callback(@Query('code') codeValue: unknown, @Req() req: AppRequest, @Res() res: Response) {
    if (process.env.AUTH_PROVIDER !== 'supabase') return res.redirect(303, `${process.env.APP_BASE_URL}/login`);
    const parsed = z.string().uuid().safeParse(codeValue);
    const verifier: unknown = req.cookies?.keiba_pkce_verifier;
    const flow: unknown = req.cookies?.keiba_auth_flow;
    if (!parsed.success || typeof verifier !== 'string' || verifier.length < 43 || !['signup', 'recovery'].includes(String(flow))) {
      clearExternalCookies(res); return res.redirect(303, `${process.env.APP_BASE_URL}/login?auth=invalid`);
    }
    try {
      const session = await this.supabase.exchangeCode(parsed.data, verifier);
      const user = await this.auth.db.user.findUnique({ where: { authSubject: session.user.id } });
      if (!user || user.disabledAt) { clearExternalCookies(res); return res.redirect(303, `${process.env.APP_BASE_URL}/login?auth=invalid`); }
      req.auth = { id: user.id, role: user.role, aal: 1, user };
      await this.auth.db.$transaction(async tx => {
        if (!user.emailVerifiedAt && (session.user.email_confirmed_at || session.user.confirmed_at)) await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(session.user.email_confirmed_at ?? session.user.confirmed_at!) } });
        await this.auth.audit(tx, req, flow === 'recovery' ? 'PASSWORD_RECOVERY_VERIFIED' : 'EMAIL_VERIFIED', user.id, flow === 'recovery' ? 'Supabaseパスワード再設定本人確認' : 'Supabaseメールアドレス確認完了');
      });
      externalCookies(res, session);
      res.clearCookie('keiba_pkce_verifier', externalCookieOptions()); res.clearCookie('keiba_auth_flow', externalCookieOptions());
      return res.redirect(303, flow === 'recovery' ? `${process.env.APP_BASE_URL}/reset-password?ready=1` : `${process.env.APP_BASE_URL}/account?email=verified`);
    } catch { clearExternalCookies(res); return res.redirect(303, `${process.env.APP_BASE_URL}/login?auth=invalid`); }
  }
  @Post('refresh') async refresh(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (process.env.AUTH_PROVIDER !== 'supabase') throw new UnauthorizedException();
    const refreshToken: unknown = req.cookies?.keiba_refresh_token;
    if (typeof refreshToken !== 'string' || refreshToken.length > 4096) { clearExternalCookies(res); throw new UnauthorizedException(); }
    try {
      const session = await this.supabase.refresh(refreshToken);
      const user = await this.auth.db.user.findUnique({ where: { authSubject: session.user.id } });
      if (!user || user.disabledAt) throw new UnauthorizedException();
      externalCookies(res, session); return { ok: true };
    } catch (error) { clearExternalCookies(res); throw error; }
  }
  @Post('logout') async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const accessToken: unknown = req.cookies?.keiba_access_token;
      let identity: Awaited<ReturnType<AuthService['authenticate']>> | undefined;
      try { identity = await this.auth.authenticate(req); } catch { identity = undefined; }
      if (typeof accessToken === 'string') await this.supabase.logout(accessToken);
      if (identity) await this.auth.db.$transaction(async tx => this.auth.audit(tx, req, 'LOGOUT', identity!.id, 'Supabaseログアウト'));
      clearExternalCookies(res);
      res.clearCookie('keiba_session', { httpOnly: true, sameSite: 'lax', path: '/' });
      return { ok: true };
    }
    const identity = await this.auth.authenticate(req);
    if (identity.sessionId) await this.auth.db.$transaction(async tx => {
      await tx.session.deleteMany({ where: { id: identity.sessionId } });
      await this.auth.audit(tx, req, 'LOGOUT', identity.id, 'ログアウト');
    });
    res.clearCookie('keiba_session', { httpOnly: true, sameSite: 'lax', path: '/' });
    return { ok: true };
  }
  @Post('password/request') async requestReset(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const { email } = z.object({ email: z.string().email().transform(s => s.toLowerCase()) }).strict().parse(body);
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const flow = pkce(); externalFlowCookies(res, flow.verifier, 'recovery');
      await this.supabase.recover(email, flow.challenge, `${process.env.APP_BASE_URL}/api/v1/auth/callback`);
      return { message: '登録されたメールアドレスの場合、再設定の案内を送信しました。' };
    }
    this.auth.ensureLocal();
    const user = await this.auth.db.user.findUnique({ where: { email } });
    if (user && user.emailVerifiedAt && user.passwordHash && !user.disabledAt) {
      const token = newToken();
      await this.auth.db.$transaction(async tx => {
        await tx.passwordReset.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 15 * 60000) } });
        await this.auth.audit(tx, req, 'PASSWORD_RESET_REQUEST', user.id, '再設定リンク発行');
      });
      await this.mail.send({ userId: user.id, to: email, kind: 'PASSWORD_RESET', url: `${process.env.APP_BASE_URL}/reset-password?token=${token}`, expiresInMinutes: 15, idempotencyKey: `reset-${hashToken(token)}` });
    }
    return { message: '登録されたメールアドレスの場合、再設定の案内を送信しました。' };
  }
  @Post('password/reset') async resetPassword(@Body() body: unknown, @Req() req: AppRequest) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      const { password } = z.object({ token: z.unknown().optional(), password: z.string().min(12).max(128) }).strict().parse(body);
      const identity = await this.auth.authenticate(req);
      const accessToken: unknown = req.cookies?.keiba_access_token;
      if (typeof accessToken !== 'string') throw new UnauthorizedException();
      await this.supabase.updatePassword(accessToken, password);
      await this.auth.db.$transaction(async tx => this.auth.audit(tx, req, 'PASSWORD_RESET', identity.id, 'Supabaseパスワード再設定'));
      return { ok: true };
    }
    this.auth.ensureLocal();
    const { token, password } = z.object({ token: z.string().min(32).max(128), password: z.string().min(12).max(128) }).strict().parse(body);
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
    return { ok: true };
  }
  @Post('mfa/enroll') async enroll(@Req() req: AppRequest) {
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
    cookie(res, token);
    return { ok: true };
  }
}
