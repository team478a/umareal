import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { TOTP, Secret } from 'otpauth';
import { fallbackEmailSchema, loginSchema, mfaCodeSchema, registrationSchema } from '@keiba/domain';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { decrypt, encrypt, hashPassword, hashToken, newToken, verifyPassword } from './security';
import { MailService } from './mail.service';

const publicUser = (user: { id: string; displayName: string; role: string }) => ({ id: user.id, displayName: user.displayName, role: user.role });
function cookie(res: Response, token: string) { res.cookie('keiba_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 8 * 3600000 }); }
const otp = (secret: string, email: string) => new TOTP({ issuer: '競馬会員メディア 開発用', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(MailService) private readonly mail: MailService) {}
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
    this.auth.ensureLocal();
    const input = registrationSchema.parse(body);
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
  @Post('email/resend') async resendVerification(@Body() body: unknown) {
    this.auth.ensureLocal();
    const { email } = z.object({ email: z.string().trim().email().max(254).transform(v => v.toLowerCase()) }).strict().parse(body);
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
    this.auth.ensureLocal();
    const input = loginSchema.parse(body);
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
  @Post('logout') async logout(@Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const identity = await this.auth.authenticate(req);
    if (identity.sessionId) await this.auth.db.$transaction(async tx => {
      await tx.session.deleteMany({ where: { id: identity.sessionId } });
      await this.auth.audit(tx, req, 'LOGOUT', identity.id, 'ログアウト');
    });
    res.clearCookie('keiba_session', { httpOnly: true, sameSite: 'lax', path: '/' });
    return { ok: true };
  }
  @Post('password/request') async requestReset(@Body() body: unknown, @Req() req: AppRequest) {
    this.auth.ensureLocal();
    const { email } = z.object({ email: z.string().email().transform(s => s.toLowerCase()) }).strict().parse(body);
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
