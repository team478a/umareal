import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { loginSchema } from '@keiba/domain';
import { describe, expect, it, vi } from 'vitest';
import { AuthLoginService } from './auth-login.service';
import type { AuthService } from './auth.service';
import type { AppRequest } from './context';
import type { ReferralsService } from './referrals.service';
import { hashPassword, hashToken } from './security';
import type { SupabaseAuthService } from './supabase-auth.service';

const input = loginSchema.parse({ email: 'member@example.test', password: 'member-password-123' });
const request = (cookies: Record<string, string> = {}) => ({ requestId: 'request-id', cookies }) as AppRequest;
const user = (values: Record<string, unknown> = {}) => ({
  id: 'user-id', email: input.email, displayName: '会員', role: 'MEMBER', disabledAt: null,
  emailVerifiedAt: new Date('2026-09-01T00:00:00Z'), passwordHash: null, ...values
});

describe('AuthLoginService', () => {
  it('rotates an existing local session and preserves the login audit boundary', async () => {
    const passwordHash = await hashPassword(input.password);
    const member = user({ passwordHash });
    const tx = { session: { deleteMany: vi.fn() } };
    const auth = {
      audit: vi.fn(), session: vi.fn().mockResolvedValue('new-session-token'),
      db: { user: { findUnique: vi.fn().mockResolvedValue(member) }, $transaction: vi.fn(async callback => callback(tx)) }
    } as unknown as AuthService;
    const service = new AuthLoginService(auth, {} as SupabaseAuthService, {} as ReferralsService);
    const req = request({ keiba_session: 'old-session-token' });

    await expect(service.loginLocal(input, req)).resolves.toEqual({ user: member, sessionToken: 'new-session-token' });

    expect(req.auth).toMatchObject({ id: 'user-id', role: 'MEMBER', aal: 1 });
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { tokenHash: hashToken('old-session-token') } });
    expect(auth.audit).toHaveBeenCalledWith(tx, req, 'LOGIN', 'user-id', 'ログイン');
    expect(auth.session).toHaveBeenCalledWith(tx, 'user-id');
  });

  it('rejects an unverified local membership before creating a session', async () => {
    const passwordHash = await hashPassword(input.password);
    const auth = {
      db: { user: { findUnique: vi.fn().mockResolvedValue(user({ passwordHash, emailVerifiedAt: null })) }, $transaction: vi.fn() }
    } as unknown as AuthService;
    const service = new AuthLoginService(auth, {} as SupabaseAuthService, {} as ReferralsService);

    await expect(service.loginLocal(input, request())).rejects.toBeInstanceOf(ForbiddenException);
    expect(auth.db.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a disabled Supabase membership without starting local login effects', async () => {
    const providerSession = { user: { id: '00000000-0000-4000-8000-000000000001' } };
    const supabase = { signIn: vi.fn().mockResolvedValue(providerSession) } as unknown as SupabaseAuthService;
    const auth = {
      db: { user: { findUnique: vi.fn().mockResolvedValue(user({ disabledAt: new Date() })) }, $transaction: vi.fn() }
    } as unknown as AuthService;
    const service = new AuthLoginService(auth, supabase, {} as ReferralsService);

    await expect(service.loginExternal(input, request())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.db.$transaction).not.toHaveBeenCalled();
  });

  it('synchronizes confirmed Supabase email, qualifies referrals and audits the login', async () => {
    const confirmedAt = '2026-09-28T00:00:00.000Z';
    const providerSession = { user: { id: '00000000-0000-4000-8000-000000000001', email_confirmed_at: confirmedAt } };
    const member = user({ emailVerifiedAt: null, authSubject: providerSession.user.id });
    const tx = { user: { update: vi.fn() } };
    const auth = {
      journey: vi.fn(), audit: vi.fn(),
      db: { user: { findUnique: vi.fn().mockResolvedValue(member) }, $transaction: vi.fn(async callback => callback(tx)) }
    } as unknown as AuthService;
    const supabase = { signIn: vi.fn().mockResolvedValue(providerSession) } as unknown as SupabaseAuthService;
    const referrals = { qualify: vi.fn() } as unknown as ReferralsService;
    const service = new AuthLoginService(auth, supabase, referrals);
    const req = request();

    await expect(service.loginExternal(input, req)).resolves.toEqual({ user: member, session: providerSession });

    expect(req.auth).toMatchObject({ id: 'user-id', role: 'MEMBER', aal: 1 });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-id' }, data: { emailVerifiedAt: new Date(confirmedAt) } });
    expect(auth.journey).toHaveBeenCalledWith(tx, 'user-id', 'FIRST_LOGIN');
    expect(referrals.qualify).toHaveBeenCalledWith(tx, 'user-id', req);
    expect(auth.audit).toHaveBeenCalledWith(tx, req, 'LOGIN', 'user-id', 'Supabaseログイン');
  });
});
