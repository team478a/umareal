import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Post, Query, Req, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { acquisitionSchema, launchCapabilities, lineOAuthStartSchema, lineRegistrationSchema, resolveLaunchMode } from '@keiba/domain';
import type { AppRequest } from './context';
import { AuthService } from './auth.service';
import { LineLoginService } from './line-login.service';
import { decrypt, encrypt, hashToken, newToken } from './security';

function sessionCookie(res: Response, token: string) { res.cookie('keiba_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 8 * 3600000 }); }

@Controller('auth/line')
export class LineLoginController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(LineLoginService) private readonly line: LineLoginService) {}

  private enabled() {
    if (!launchCapabilities(resolveLaunchMode(process.env.LAUNCH_MODE)).lineLogin) throw new ServiceUnavailableException({ code: 'LINE_LOGIN_NOT_IN_LAUNCH', message: 'LINEログインは現在の公開範囲では利用できません。' });
  }

  @Post('start')
  async start(@Body() body: unknown, @Req() req: AppRequest) {
    this.enabled();
    const { purpose, acquisition } = lineOAuthStartSchema.parse(body);
    if (purpose === 'REGISTER') await this.auth.requireNewRegistration();
    const identity = purpose === 'LINK' ? await this.auth.authenticate(req) : undefined;
    return this.line.start(purpose, identity?.id, acquisition);
  }

  @Get('callback')
  async callback(@Query() query: Record<string, unknown>, @Req() req: AppRequest, @Res() res: Response) {
    this.enabled();
    if (typeof query.error === 'string') throw new BadRequestException({ code: 'LINE_AUTHORIZATION_DECLINED', message: 'LINEでの認証がキャンセルされました。' });
    if (typeof query.state !== 'string' || typeof query.code !== 'string') throw new BadRequestException({ code: 'LINE_CALLBACK_INVALID', message: 'LINE認証の応答を確認できませんでした。' });
    let callbackActor: Awaited<ReturnType<AuthService['authenticate']>> | undefined;
    try { callbackActor = await this.auth.authenticate(req); } catch (error) { if (!(error instanceof UnauthorizedException)) throw error; }
    const { flow, identity, subjectHash } = await this.line.consume(query.state, query.code, callbackActor?.id);
    if (flow.purpose === 'REGISTER') {
      const account = await this.auth.db.lineAccount.findUnique({ where: { subject: identity.subject }, include: { user: true } });
      if (account && !account.unlinkedAt && !account.user.disabledAt) {
        req.auth = { id: account.user.id, role: account.user.role, aal: 1, user: account.user };
        const session = await this.auth.db.$transaction(async tx => { await this.auth.audit(tx, req, 'LINE_LOGIN', account.user.id, '登録済みLINEアカウントでログイン', { subjectHash }); return this.auth.session(tx, account.user.id); });
        sessionCookie(res, session); return res.redirect(303, `${process.env.APP_BASE_URL}/account?line=login`);
      }
      if (account) throw new ConflictException({ code: 'LINE_ACCOUNT_UNAVAILABLE', message: 'このLINEアカウントは再登録できません。' });
      await this.auth.requireNewRegistration();
      const token = newToken();
      await this.auth.db.lineRegistrationGrant.create({ data: { tokenHash: hashToken(token), subjectHash, subjectEncrypted: encrypt(identity.subject), expiresAt: new Date(Date.now() + 15 * 60000), acquisition: flow.acquisition ?? undefined } });
      return res.redirect(303, `${process.env.APP_BASE_URL}/register/line?token=${encodeURIComponent(token)}`);
    }
    if (flow.purpose === 'LINK') {
      const actor = callbackActor!;
      await this.auth.db.$transaction(async tx => {
        const owned = await tx.lineAccount.findUnique({ where: { subject: identity.subject } });
        if (owned && owned.userId !== actor.id) throw new ConflictException({ code: 'LINE_ACCOUNT_ALREADY_LINKED', message: 'このLINEアカウントは別の会員に連携されています。' });
        const existing = await tx.lineAccount.findUnique({ where: { userId: actor.id } });
        if (existing) await tx.lineAccount.update({ where: { userId: actor.id }, data: { subject: identity.subject, linkedAt: new Date(), unlinkedAt: null, notificationDisabledAt: null } });
        else await tx.lineAccount.create({ data: { userId: actor.id, subject: identity.subject } });
        await this.auth.audit(tx, req, 'LINE_ACCOUNT_LINK', actor.id, 'LINEアカウント連携', { subjectHash });
      });
      return res.redirect(303, `${process.env.APP_BASE_URL}/account?line=linked`);
    }
    const account = await this.auth.db.lineAccount.findUnique({ where: { subject: identity.subject }, include: { user: true } });
    if (!account || account.unlinkedAt || account.user.disabledAt) throw new UnauthorizedException({ code: 'LINE_ACCOUNT_NOT_LINKED', message: 'このLINEアカウントは会員に連携されていません。' });
    req.auth = { id: account.user.id, role: account.user.role, aal: 1, user: account.user };
    const token = await this.auth.db.$transaction(async tx => {
      await this.auth.audit(tx, req, 'LINE_LOGIN', account.user.id, 'LINEログイン', { subjectHash });
      return this.auth.session(tx, account.user.id, 1);
    });
    sessionCookie(res, token);
    return res.redirect(303, `${process.env.APP_BASE_URL}/account?line=login`);
  }

  @Post('register')
  async register(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    this.enabled();
    const input = lineRegistrationSchema.parse(body); const now = new Date();
    const result = await this.auth.db.$transaction(async tx => {
      await this.auth.requireNewRegistration(tx);
      const grant = await tx.lineRegistrationGrant.findUnique({ where: { tokenHash: hashToken(input.token) } });
      if (!grant || grant.usedAt || grant.expiresAt <= now) throw new BadRequestException({ code: 'LINE_REGISTRATION_INVALID', message: 'LINE登録の有効期限が切れています。もう一度お試しください。' });
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${grant.subjectHash}))::text`;
      const consumed = await tx.lineRegistrationGrant.updateMany({ where: { id: grant.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now, subjectEncrypted: encrypt(newToken()) } });
      if (consumed.count !== 1) throw new BadRequestException({ code: 'LINE_REGISTRATION_INVALID', message: 'LINE登録はすでに使用されています。' });
      const subject = decrypt(grant.subjectEncrypted);
      if (hashToken(subject) !== grant.subjectHash || await tx.lineAccount.findUnique({ where: { subject } })) throw new ConflictException({ code: 'LINE_ACCOUNT_ALREADY_LINKED', message: 'このLINEアカウントは登録済みです。' });
      const parsedAcquisition = acquisitionSchema.safeParse(grant.acquisition); const acquisition = parsedAcquisition.success ? parsedAcquisition.data : undefined;
      const user = await tx.user.create({ data: { email: null, displayName: input.displayName, registrationMethod: 'LINE', preferences: { create: {} }, lineAccount: { create: { subject } }, acquisition: { create: { source: acquisition?.source ?? 'direct', medium: acquisition?.medium, campaign: acquisition?.campaign, content: acquisition?.content, term: acquisition?.term, landingPath: acquisition?.landingPath ?? '/register', referralCode: acquisition?.referralCode } }, consents: { create: [
        { documentType: 'AGE_20', version: '1', source: 'line-registration' },
        { documentType: 'TERMS', version: input.termsVersion, source: 'line-registration' },
        { documentType: 'PRIVACY', version: input.privacyVersion, source: 'line-registration' }
      ] } } });
      req.auth = { id: user.id, role: user.role, aal: 1, user };
      await this.auth.audit(tx, req, 'LINE_REGISTER', user.id, 'LINE無料会員登録', { subjectHash: grant.subjectHash });
      await this.auth.journey(tx, user.id, 'LINE_GUIDANCE_VIEWED');
      return { user, session: await this.auth.session(tx, user.id) };
    });
    sessionCookie(res, result.session); return { user: { id: result.user.id, displayName: result.user.displayName, role: result.user.role } };
  }

  @Post('unlink')
  async unlink(@Req() req: AppRequest) {
    this.enabled();
    const actor = await this.auth.authenticate(req);
    return this.auth.db.$transaction(async tx => {
      const account = await tx.lineAccount.findUnique({ where: { userId: actor.id } });
      if (!account || account.unlinkedAt) return { linked: false };
      if (!actor.user.emailVerifiedAt || !actor.user.passwordHash) throw new ConflictException({ code: 'FALLBACK_AUTH_REQUIRED', message: 'LINE連携を解除する前に、確認済みメールアドレスとパスワードを設定してください。' });
      const now = new Date();
      const changed = await tx.lineAccount.updateMany({ where: { userId: actor.id, unlinkedAt: null }, data: { unlinkedAt: now, notificationDisabledAt: now } });
      if (changed.count !== 1) return { linked: false };
      await this.auth.audit(tx, req, 'LINE_ACCOUNT_UNLINK', actor.id, '会員によるLINE連携解除', { subjectHash: hashToken(account.subject) });
      return { linked: false };
    });
  }
}
