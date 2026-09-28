import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthSessionLifecycleService } from './auth-session-lifecycle.service';
import type { AuthService } from './auth.service';
import type { AppRequest, AuthContext } from './context';
import type { ReferralsService } from './referrals.service';
import type { SupabaseAuthService } from './supabase-auth.service';

const request = () => ({ requestId: 'request-id', cookies: {} }) as AppRequest;
const member = (values: Record<string, unknown> = {}) => ({
  id: 'user-id', authSubject: '00000000-0000-4000-8000-000000000001', email: 'member@example.test',
  displayName: '会員', role: 'MEMBER', disabledAt: null, emailVerifiedAt: null, ...values
});
const providerSession = (values: Record<string, unknown> = {}) => ({
  access_token: 'a'.repeat(20), refresh_token: 'refresh-token', expires_in: 3600,
  user: { id: '00000000-0000-4000-8000-000000000001', email_confirmed_at: '2026-09-28T00:00:00.000Z', ...values }
});

describe('AuthSessionLifecycleService', () => {
  it('completes a signup callback with email synchronization, referral qualification and audit', async () => {
    const user = member();
    const session = providerSession();
    const tx = { user: { update: vi.fn() } };
    const auth = {
      journey: vi.fn(), audit: vi.fn(),
      db: { user: { findUnique: vi.fn().mockResolvedValue(user) }, $transaction: vi.fn(async callback => callback(tx)) }
    } as unknown as AuthService;
    const supabase = { exchangeCode: vi.fn().mockResolvedValue(session) } as unknown as SupabaseAuthService;
    const referrals = { qualify: vi.fn() } as unknown as ReferralsService;
    const service = new AuthSessionLifecycleService(auth, supabase, referrals);
    const req = request();

    await expect(service.completeExternalFlow('callback-code', 'pkce-verifier', 'signup', req)).resolves.toBe(session);

    expect(req.auth).toMatchObject({ id: 'user-id', role: 'MEMBER', aal: 1 });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user-id' }, data: { emailVerifiedAt: new Date('2026-09-28T00:00:00.000Z') } });
    expect(auth.journey).toHaveBeenCalledWith(tx, 'user-id', 'FIRST_LOGIN');
    expect(referrals.qualify).toHaveBeenCalledWith(tx, 'user-id', req);
    expect(auth.audit).toHaveBeenCalledWith(tx, req, 'EMAIL_VERIFIED', 'user-id', 'Supabaseメールアドレス確認完了');
  });

  it('keeps password recovery separate from referral qualification', async () => {
    const session = providerSession();
    const tx = { user: { update: vi.fn() } };
    const auth = {
      journey: vi.fn(), audit: vi.fn(),
      db: { user: { findUnique: vi.fn().mockResolvedValue(member()) }, $transaction: vi.fn(async callback => callback(tx)) }
    } as unknown as AuthService;
    const referrals = { qualify: vi.fn() } as unknown as ReferralsService;
    const service = new AuthSessionLifecycleService(auth, { exchangeCode: vi.fn().mockResolvedValue(session) } as unknown as SupabaseAuthService, referrals);

    await service.completeExternalFlow('callback-code', 'pkce-verifier', 'recovery', request());

    expect(referrals.qualify).not.toHaveBeenCalled();
    expect(auth.audit).toHaveBeenCalledWith(tx, expect.anything(), 'PASSWORD_RECOVERY_VERIFIED', 'user-id', 'Supabaseパスワード再設定本人確認');
  });

  it('rejects refresh when the provider subject no longer has an active membership', async () => {
    const supabase = { refresh: vi.fn().mockResolvedValue(providerSession()) } as unknown as SupabaseAuthService;
    const auth = { db: { user: { findUnique: vi.fn().mockResolvedValue(member({ disabledAt: new Date() })) } } } as unknown as AuthService;
    const service = new AuthSessionLifecycleService(auth, supabase, {} as ReferralsService);

    await expect(service.refreshExternal('refresh-token')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logs out at the provider without creating an audit for an unauthenticated request', async () => {
    const auth = { authenticate: vi.fn().mockRejectedValue(new UnauthorizedException()), db: { $transaction: vi.fn() } } as unknown as AuthService;
    const supabase = { logout: vi.fn() } as unknown as SupabaseAuthService;
    const service = new AuthSessionLifecycleService(auth, supabase, {} as ReferralsService);

    await service.logoutExternal(request(), 'access-token');

    expect(supabase.logout).toHaveBeenCalledWith('access-token');
    expect(auth.db.$transaction).not.toHaveBeenCalled();
  });

  it('deletes the current local session and records the existing logout audit', async () => {
    const tx = { session: { deleteMany: vi.fn() } };
    const auth = { audit: vi.fn(), db: { $transaction: vi.fn(async callback => callback(tx)) } } as unknown as AuthService;
    const service = new AuthSessionLifecycleService(auth, {} as SupabaseAuthService, {} as ReferralsService);
    const identity = { id: 'user-id', role: 'MEMBER', aal: 1, user: member(), sessionId: 'session-id' } as unknown as AuthContext;
    const req = request();

    await service.logoutLocal(identity, req);

    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { id: 'session-id' } });
    expect(auth.audit).toHaveBeenCalledWith(tx, req, 'LOGOUT', 'user-id', 'ログアウト');
  });
});
