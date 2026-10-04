import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Post, Query, Req, Res, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { acquisitionSchema, launchCapabilities, lineLoginReturnPathSchema, lineOAuthStartSchema, lineRegistrationSchema, resolveLaunchMode } from '@keiba/domain';
import type { AppRequest } from './context';
import { AuthService } from './auth.service';
import { LineLoginService } from './line-login.service';
import { decrypt, encrypt, hashToken, newToken } from './security';
import { ReferralsService } from './referrals.service';
import { AuthSessionService } from './auth-session.service';

@Controller('auth/line')
export class LineLoginController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(LineLoginService) private readonly line: LineLoginService, @Inject(ReferralsService) private readonly referrals: ReferralsService, @Inject(AuthSessionService) private readonly sessions: AuthSessionService) {}

  private enabled() {
    if (!launchCapabilities(resolveLaunchMode(process.env.LAUNCH_MODE)).lineLogin) throw new ServiceUnavailableException({ code: 'LINE_LOGIN_NOT_IN_LAUNCH', message: 'LINEログインは現在の公開範囲では利用できません。' });
  }

  @Post('start')
  async start(@Body() body: unknown, @Req() req: AppRequest) {
    this.enabled();
    const { purpose, acquisition, memberReferralCode, returnTo } = lineOAuthStartSchema.parse(body);
    if (purpose === 'REGISTER') await this.auth.requireNewRegistration();
    const identity = purpose === 'LINK' ? await this.auth.authenticate(req) : undefined;
    return this.line.start(purpose, identity?.id, acquisition, memberReferralCode, returnTo);
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
        this.sessions.setLocalSession(res, session); return res.redirect(303, `${process.env.APP_BASE_URL}/account?line=login`);
      }
      if (account) throw new ConflictException({ code: 'LINE_ACCOUNT_UNAVAILABLE', message: 'このLINEアカウントは再登録できません。' });
      if (!identity.friend) {
        const registrationUrl = new URL('/register', process.env.APP_BASE_URL);
        registrationUrl.searchParams.set('entry', 'line');
        registrationUrl.searchParams.set('line', 'friend-required');
        if (flow.memberReferralCode) registrationUrl.searchParams.set('invite', flow.memberReferralCode);
        const parsedAcquisition = acquisitionSchema.safeParse(flow.acquisition);
        if (parsedAcquisition.success) {
          const queryNames = { source: 'utm_source', medium: 'utm_medium', campaign: 'utm_campaign', content: 'utm_content', term: 'utm_term', referralCode: 'ref' } as const;
          for (const [key, queryName] of Object.entries(queryNames) as [keyof typeof queryNames, string][]) {
            const value = parsedAcquisition.data[key];
            if (value) registrationUrl.searchParams.set(queryName, value);
          }
        }
        return res.redirect(303, registrationUrl.toString());
      }
      await this.auth.requireNewRegistration();
      const token = newToken();
      await this.auth.db.lineRegistrationGrant.create({ data: { tokenHash: hashToken(token), subjectHash, subjectEncrypted: encrypt(identity.subject), expiresAt: new Date(Date.now() + 15 * 60000), acquisition: flow.acquisition ?? undefined, memberReferralCode: flow.memberReferralCode } });
      return res.redirect(303, `${process.env.APP_BASE_URL}/register/line?token=${encodeURIComponent(token)}`);
    }
    if (flow.purpose === 'LINK') {
      const actor = callbackActor!;
      const outcome = await this.auth.db.$transaction(async tx => {
        const owned = await tx.lineAccount.findUnique({ where: { subject: identity.subject } });
        if (owned && owned.userId !== actor.id) return 'ALREADY_LINKED' as const;
        const existing = await tx.lineAccount.findUnique({ where: { userId: actor.id } });
        if (existing) await tx.lineAccount.update({ where: { userId: actor.id }, data: { subject: identity.subject, linkedAt: new Date(), unlinkedAt: null, notificationDisabledAt: null } });
        else await tx.lineAccount.create({ data: { userId: actor.id, subject: identity.subject } });
        await this.auth.audit(tx, req, 'LINE_ACCOUNT_LINK', actor.id, 'LINEアカウント連携', { subjectHash });
        return 'LINKED' as const;
      });
      if (outcome === 'ALREADY_LINKED') return res.redirect(303, `${process.env.APP_BASE_URL}/account?line=already-linked`);
      return res.redirect(303, `${process.env.APP_BASE_URL}/account?line=linked`);
    }
    const account = await this.auth.db.lineAccount.findUnique({ where: { subject: identity.subject }, include: { user: true } });
    if (!account || account.unlinkedAt) {
      const returnPath = lineLoginReturnPathSchema.safeParse(flow.returnPath);
      const loginUrl = new URL('/login', process.env.APP_BASE_URL);
      loginUrl.searchParams.set('line', 'not-linked');
      if (returnPath.success) loginUrl.searchParams.set('returnTo', returnPath.data);
      return res.redirect(303, loginUrl.toString());
    }
    if (account.user.disabledAt) throw new UnauthorizedException({ code: 'LINE_ACCOUNT_UNAVAILABLE', message: 'このアカウントではログインできません。' });
    req.auth = { id: account.user.id, role: account.user.role, aal: 1, user: account.user };
    const token = await this.auth.db.$transaction(async tx => {
      await this.auth.audit(tx, req, 'LINE_LOGIN', account.user.id, 'LINEログイン', { subjectHash });
      return this.auth.session(tx, account.user.id, 1);
    });
    this.sessions.setLocalSession(res, token);
    const returnPath = lineLoginReturnPathSchema.safeParse(flow.returnPath);
    return res.redirect(303, new URL(returnPath.success ? returnPath.data : '/account?line=login', process.env.APP_BASE_URL).toString());
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
      await this.referrals.createPending(tx, user.id, grant.memberReferralCode ?? undefined);
      await this.referrals.qualify(tx, user.id, req);
      await this.auth.journey(tx, user.id, 'LINE_GUIDANCE_VIEWED');
      return { user, session: await this.auth.session(tx, user.id) };
    });
    this.sessions.setLocalSession(res, result.session); return { user: { id: result.user.id, displayName: result.user.displayName, role: result.user.role } };
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
