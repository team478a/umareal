import { BadRequestException } from '@nestjs/common';
import { registrationSchema } from '@keiba/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from './auth.service';
import { AuthRegistrationService } from './auth-registration.service';
import type { AppRequest } from './context';
import type { MailService } from './mail.service';
import type { ReferralsService } from './referrals.service';
import type { RegistrationCaptchaService } from './registration-captcha.service';
import type { SupabaseAuthService } from './supabase-auth.service';

const input = registrationSchema.parse({
  email: 'member@example.test',
  password: 'long-enough-password',
  displayName: '会員',
  adult: true,
  terms: true,
  privacy: true,
  termsVersion: '2026-10-01-v1',
  privacyVersion: '2026-10-01-v1',
  captchaToken: 'captcha-token'
});

const request = () => ({ requestId: 'request-id' }) as AppRequest;

afterEach(() => vi.unstubAllEnvs());

describe('AuthRegistrationService', () => {
  it('keeps the Supabase existing-email response enumeration safe without creating a membership', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'supabase');
    vi.stubEnv('APP_BASE_URL', 'https://example.test');
    const auth = {
      requireNewRegistration: vi.fn(),
      db: { user: { findFirst: vi.fn() }, $transaction: vi.fn() }
    } as unknown as AuthService;
    const supabase = {
      signUp: vi.fn().mockResolvedValue({ user: { id: '00000000-0000-4000-8000-000000000001', identities: [] }, session: null })
    } as unknown as SupabaseAuthService;
    const captcha = { verify: vi.fn() } as unknown as RegistrationCaptchaService;
    const service = new AuthRegistrationService(
      auth,
      supabase,
      {} as MailService,
      captcha,
      {} as ReferralsService
    );

    const onExternalSignUp = vi.fn();
    const result = await service.register(input, request(), { externalChallenge: 'pkce-challenge', onExternalSignUp });

    expect(result).toEqual({ provider: 'supabase', user: null, session: null });
    expect(auth.requireNewRegistration).toHaveBeenCalledOnce();
    expect(captcha.verify).toHaveBeenCalledWith('captcha-token', 'request-id');
    expect(supabase.signUp).toHaveBeenCalledWith(
      { email: 'member@example.test', password: 'long-enough-password' },
      'pkce-challenge',
      'https://example.test/api/v1/auth/callback'
    );
    expect(onExternalSignUp).toHaveBeenCalledOnce();
    expect(auth.db.user.findFirst).not.toHaveBeenCalled();
    expect(auth.db.$transaction).not.toHaveBeenCalled();
  });

  it('keeps local verification resend enumeration safe', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'local');
    const auth = {
      ensureLocal: vi.fn(),
      db: { user: { findUnique: vi.fn().mockResolvedValue(null) } }
    } as unknown as AuthService;
    const mail = { sendVerification: vi.fn() } as unknown as MailService;
    const service = new AuthRegistrationService(
      auth,
      {} as SupabaseAuthService,
      mail,
      {} as RegistrationCaptchaService,
      {} as ReferralsService
    );

    await service.resendVerification('unknown@example.test');

    expect(auth.ensureLocal).toHaveBeenCalledOnce();
    expect(mail.sendVerification).not.toHaveBeenCalled();
  });

  it('applies the controller-owned local cookie effect before attempting verification mail', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'local');
    const created = { id: 'user-id', role: 'MEMBER', displayName: '会員' };
    const tx = { user: { create: vi.fn().mockResolvedValue(created) } };
    const auth = {
      ensureLocal: vi.fn(),
      requireNewRegistration: vi.fn(),
      audit: vi.fn(),
      db: { $transaction: vi.fn(async callback => callback(tx)) }
    } as unknown as AuthService;
    const captcha = { verify: vi.fn() } as unknown as RegistrationCaptchaService;
    const mail = { sendVerification: vi.fn() } as unknown as MailService;
    const referrals = { createPending: vi.fn() } as unknown as ReferralsService;
    const service = new AuthRegistrationService(auth, {} as SupabaseAuthService, mail, captcha, referrals);
    const onLocalMembershipCreated = vi.fn();

    const result = await service.register(input, request(), { onLocalMembershipCreated });

    expect(result.user).toBe(created);
    expect(onLocalMembershipCreated).toHaveBeenCalledOnce();
    expect(mail.sendVerification).toHaveBeenCalledWith({ userId: 'user-id', email: 'member@example.test', purpose: 'REGISTRATION' });
    expect(onLocalMembershipCreated.mock.invocationCallOrder[0]).toBeLessThan(mail.sendVerification.mock.invocationCallOrder[0]);
  });

  it('rejects an expired local verification before changing the user', async () => {
    const tx = {
      emailVerification: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'verification-id',
          userId: 'user-id',
          usedAt: null,
          expiresAt: new Date(Date.now() - 1000),
          user: { disabledAt: null }
        }),
        updateMany: vi.fn()
      },
      user: { update: vi.fn() }
    };
    const auth = {
      db: { $transaction: vi.fn(async callback => callback(tx)) }
    } as unknown as AuthService;
    const service = new AuthRegistrationService(
      auth,
      {} as SupabaseAuthService,
      {} as MailService,
      {} as RegistrationCaptchaService,
      {} as ReferralsService
    );

    await expect(service.verifyEmail('x'.repeat(32), request())).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.emailVerification.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});
