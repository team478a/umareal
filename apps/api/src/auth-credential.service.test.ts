import { BadRequestException, ConflictException } from '@nestjs/common';
import { fallbackEmailSchema } from '@keiba/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthCredentialService } from './auth-credential.service';
import type { AuthService } from './auth.service';
import type { AppRequest, AuthContext } from './context';
import type { MailService } from './mail.service';
import type { SupabaseAuthService } from './supabase-auth.service';

const request = () => ({ requestId: 'request-id' }) as AppRequest;
const fallbackInput = fallbackEmailSchema.parse({ email: 'fallback@example.test', password: 'fallback-password-123' });

afterEach(() => vi.unstubAllEnvs());

describe('AuthCredentialService', () => {
  it('keeps local password recovery enumeration safe for an unknown email', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'local');
    const auth = {
      ensureLocal: vi.fn(),
      db: { user: { findUnique: vi.fn().mockResolvedValue(null) }, $transaction: vi.fn() }
    } as unknown as AuthService;
    const mail = { send: vi.fn() } as unknown as MailService;
    const service = new AuthCredentialService(auth, {} as SupabaseAuthService, mail);

    await service.requestPasswordReset('unknown@example.test', request());

    expect(auth.ensureLocal).toHaveBeenCalledOnce();
    expect(auth.db.$transaction).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('starts Supabase recovery with the existing callback and no local database lookup', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'supabase');
    vi.stubEnv('APP_BASE_URL', 'https://example.test');
    const auth = { db: { user: { findUnique: vi.fn() } } } as unknown as AuthService;
    const supabase = { recover: vi.fn() } as unknown as SupabaseAuthService;
    const service = new AuthCredentialService(auth, supabase, {} as MailService);

    await service.requestPasswordReset('member@example.test', request(), 'pkce-challenge');

    expect(supabase.recover).toHaveBeenCalledWith('member@example.test', 'pkce-challenge', 'https://example.test/api/v1/auth/callback');
    expect(auth.db.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects replacing an already configured fallback before sending mail', async () => {
    const auth = { db: { user: { findFirst: vi.fn() } } } as unknown as AuthService;
    const mail = { sendVerification: vi.fn() } as unknown as MailService;
    const service = new AuthCredentialService(auth, {} as SupabaseAuthService, mail);
    const actor = {
      id: 'user-id', role: 'MEMBER', aal: 1,
      user: { emailVerifiedAt: new Date(), passwordHash: 'configured' }
    } as unknown as AuthContext;

    await expect(service.addFallback(actor, fallbackInput, request())).rejects.toBeInstanceOf(ConflictException);

    expect(auth.db.user.findFirst).not.toHaveBeenCalled();
    expect(mail.sendVerification).not.toHaveBeenCalled();
  });

  it('consumes a local reset once, updates the password and revokes every local session', async () => {
    const reset = { id: 'reset-id', userId: 'user-id', usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    const tx = {
      passwordReset: {
        findUnique: vi.fn().mockResolvedValue(reset),
        updateMany: vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })
      },
      user: { update: vi.fn() },
      session: { deleteMany: vi.fn() }
    };
    const auth = {
      audit: vi.fn(),
      db: { $transaction: vi.fn(async callback => callback(tx)) }
    } as unknown as AuthService;
    const service = new AuthCredentialService(auth, {} as SupabaseAuthService, {} as MailService);

    await service.resetLocalPassword('x'.repeat(32), 'new-password-value-123', request());

    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-id' }, data: { passwordHash: expect.not.stringMatching('new-password-value-123') } });
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-id' } });
    expect(auth.audit).toHaveBeenCalledWith(tx, expect.anything(), 'PASSWORD_RESET', 'user-id', 'パスワード再設定・全セッション失効');
  });

  it('rejects an expired local reset before changing credentials or sessions', async () => {
    const tx = {
      passwordReset: {
        findUnique: vi.fn().mockResolvedValue({ id: 'reset-id', userId: 'user-id', usedAt: null, expiresAt: new Date(Date.now() - 1000) }),
        updateMany: vi.fn()
      },
      user: { update: vi.fn() },
      session: { deleteMany: vi.fn() }
    };
    const auth = { db: { $transaction: vi.fn(async callback => callback(tx)) } } as unknown as AuthService;
    const service = new AuthCredentialService(auth, {} as SupabaseAuthService, {} as MailService);

    await expect(service.resetLocalPassword('x'.repeat(32), 'new-password-value-123', request())).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.passwordReset.updateMany).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
  });
});
