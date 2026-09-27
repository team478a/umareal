import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { registrationSchema } from '@keiba/domain';
import type { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashPassword, hashToken } from './security';
import { MailService } from './mail.service';
import { RegistrationCaptchaService } from './registration-captcha.service';
import { ReferralsService } from './referrals.service';
import { SupabaseAuthService } from './supabase-auth.service';
import type { SupabaseSession } from './supabase-auth.service';

type RegistrationInput = z.infer<typeof registrationSchema>;
type RegistrationEffects = {
  externalChallenge?: string;
  onExternalSignUp?: () => void;
  onExternalSession?: (session: SupabaseSession) => void;
  onLocalMembershipCreated?: () => void;
};

@Injectable()
export class AuthRegistrationService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SupabaseAuthService) private readonly supabase: SupabaseAuthService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(RegistrationCaptchaService) private readonly captcha: RegistrationCaptchaService,
    @Inject(ReferralsService) private readonly referrals: ReferralsService
  ) {}

  async register(input: RegistrationInput, req: AppRequest, effects: RegistrationEffects = {}) {
    await this.auth.requireNewRegistration();
    await this.captcha.verify(input.captchaToken, req.requestId);

    if (process.env.AUTH_PROVIDER === 'supabase') {
      if (!effects.externalChallenge) throw new Error('Supabase registration requires a PKCE challenge');
      const callbackUrl = `${process.env.APP_BASE_URL}/api/v1/auth/callback`;
      const result = await this.supabase.signUp({ email: input.email, password: input.password }, effects.externalChallenge, callbackUrl);
      effects.onExternalSignUp?.();
      // Supabase deliberately returns an identity-less user for an existing email.
      // Do not create a second local membership from that enumeration-safe response.
      if (Array.isArray(result.user.identities) && result.user.identities.length === 0) {
        return { provider: 'supabase' as const, user: null, session: null };
      }
      const existing = await this.auth.db.user.findFirst({ where: { OR: [{ authSubject: result.user.id }, { email: input.email }] } });
      if (existing && existing.authSubject !== result.user.id) throw new ConflictException({ code: 'ACCOUNT_LINK_REQUIRED', message: 'このメールアドレスは既存アカウントの確認が必要です。' });
      const user = existing ?? await this.auth.db.$transaction(async tx => {
        await this.auth.requireNewRegistration(tx);
        const created = await tx.user.create({ data: {
          authSubject: result.user.id,
          email: input.email,
          emailVerifiedAt: result.user.email_confirmed_at || result.user.confirmed_at ? new Date(result.user.email_confirmed_at ?? result.user.confirmed_at!) : null,
          displayName: input.displayName,
          registrationMethod: 'EMAIL',
          preferences: { create: {} },
          acquisition: { create: {
            source: input.acquisition?.source ?? 'direct',
            medium: input.acquisition?.medium,
            campaign: input.acquisition?.campaign,
            content: input.acquisition?.content,
            term: input.acquisition?.term,
            landingPath: input.acquisition?.landingPath ?? '/register',
            referralCode: input.acquisition?.referralCode
          } },
          consents: { create: [
            { documentType: 'AGE_20', version: '1', source: 'web-registration' },
            { documentType: 'TERMS', version: input.termsVersion, source: 'web-registration' },
            { documentType: 'PRIVACY', version: input.privacyVersion, source: 'web-registration' }
          ] }
        } });
        req.auth = { id: created.id, role: created.role, aal: 1, user: created };
        await this.auth.audit(tx, req, 'REGISTER', created.id, 'Supabase会員登録と同意記録');
        await this.referrals.createPending(tx, created.id, input.memberReferralCode);
        if (created.emailVerifiedAt) await this.referrals.qualify(tx, created.id, req);
        return created;
      });
      if (result.session) {
        effects.onExternalSession?.(result.session);
        await this.auth.db.$transaction(async tx => {
          await tx.user.updateMany({ where: { id: user.id, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
          await this.auth.journey(tx, user.id, 'FIRST_LOGIN');
          await this.referrals.qualify(tx, user.id, req);
        });
      }
      return { provider: 'supabase' as const, user, session: result.session };
    }

    this.auth.ensureLocal();
    const passwordHash = await hashPassword(input.password);
    const user = await this.auth.db.$transaction(async tx => {
      await this.auth.requireNewRegistration(tx);
      const created = await tx.user.create({ data: {
        email: input.email,
        displayName: input.displayName,
        passwordHash,
        registrationMethod: 'EMAIL',
        preferences: { create: {} },
        acquisition: { create: {
          source: input.acquisition?.source ?? 'direct',
          medium: input.acquisition?.medium,
          campaign: input.acquisition?.campaign,
          content: input.acquisition?.content,
          term: input.acquisition?.term,
          landingPath: input.acquisition?.landingPath ?? '/register',
          referralCode: input.acquisition?.referralCode
        } },
        consents: { create: [
          { documentType: 'AGE_20', version: '1', source: 'web-registration' },
          { documentType: 'TERMS', version: input.termsVersion, source: 'web-registration' },
          { documentType: 'PRIVACY', version: input.privacyVersion, source: 'web-registration' }
        ] }
      } });
      req.auth = { id: created.id, role: created.role, aal: 1, user: created };
      await this.auth.audit(tx, req, 'REGISTER', created.id, '会員登録と同意記録');
      await this.referrals.createPending(tx, created.id, input.memberReferralCode);
      return created;
    });
    effects.onLocalMembershipCreated?.();
    await this.mail.sendVerification({ userId: user.id, email: input.email, purpose: 'REGISTRATION' });
    return { provider: 'local' as const, user, session: null };
  }

  async resendVerification(email: string, externalChallenge?: string) {
    if (process.env.AUTH_PROVIDER === 'supabase') {
      if (!externalChallenge) throw new Error('Supabase verification resend requires a PKCE challenge');
      await this.supabase.resend(email, externalChallenge);
      return;
    }
    this.auth.ensureLocal();
    const user = await this.auth.db.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && !user.disabledAt) await this.mail.sendVerification({ userId: user.id, email, purpose: 'REGISTRATION' });
  }

  async verifyEmail(token: string, req: AppRequest) {
    const now = new Date();
    return this.auth.db.$transaction(async tx => {
      const verification = await tx.emailVerification.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
      if (!verification || verification.usedAt || verification.expiresAt <= now || verification.user.disabledAt) throw new BadRequestException({ code: 'EMAIL_VERIFICATION_INVALID', message: '確認リンクが無効、または期限切れです。' });
      const consumed = await tx.emailVerification.updateMany({ where: { id: verification.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (consumed.count !== 1) throw new BadRequestException({ code: 'EMAIL_VERIFICATION_INVALID', message: '確認リンクはすでに使用されています。' });
      const data = verification.purpose === 'ADD_FALLBACK'
        ? { email: verification.email, emailVerifiedAt: now, passwordHash: verification.passwordHash!, emailDeliveryDisabledAt: null, emailDeliveryDisabledReason: null }
        : { emailVerifiedAt: now };
      const user = await tx.user.update({ where: { id: verification.userId }, data });
      req.auth = { id: user.id, role: user.role, aal: 1, user };
      await tx.emailVerification.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      await this.auth.audit(tx, req, verification.purpose === 'ADD_FALLBACK' ? 'FALLBACK_EMAIL_VERIFIED' : 'EMAIL_VERIFIED', user.id, 'メールアドレス確認完了');
      await this.referrals.qualify(tx, user.id, req);
      return { user, sessionToken: await this.auth.session(tx, user.id) };
    });
  }
}
