import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Secret, TOTP } from 'otpauth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthMfaService } from './auth-mfa.service';
import type { AuthService } from './auth.service';
import type { AuthSessionService } from './auth-session.service';
import type { AppRequest, AuthContext } from './context';
import { decrypt, encrypt } from './security';
import type { SupabaseAuthService } from './supabase-auth.service';

const request = () => ({ requestId: 'request-id', cookies: {} }) as AppRequest;
const identity = (user: Record<string, unknown> = {}, values: Partial<AuthContext> = {}) => ({
  id: 'user-id', role: 'MEMBER', aal: 1,
  user: { id: 'user-id', email: 'member@example.test', ...user },
  ...values
}) as AuthContext;
const totp = (secret: string) => new TOTP({ issuer: '競馬会員メディア 開発用', label: 'member@example.test', algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('AuthMfaService', () => {
  it('stores a local enrollment secret encrypted and records the existing audit action', async () => {
    vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    const tx = { user: { update: vi.fn() } };
    const auth = { audit: vi.fn(), db: { $transaction: vi.fn(async callback => callback(tx)) } } as unknown as AuthService;
    const service = new AuthMfaService(auth, {} as AuthSessionService, {} as SupabaseAuthService);

    const result = await service.enrollLocal(identity(), request());

    const stored = tx.user.update.mock.calls[0][0].data.pendingMfaSecret as string;
    expect(stored).not.toContain(result.secret);
    expect(decrypt(stored)).toBe(result.secret);
    expect(result.uri).toContain('otpauth://totp/');
    expect(auth.audit).toHaveBeenCalledWith(tx, expect.anything(), 'MFA_ENROLL_START', 'user-id', '二段階認証の登録開始');
  });

  it('rejects a reused local TOTP step before rotating the session', async () => {
    vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 8).toString('base64'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:00:05Z'));
    const secret = 'JBSWY3DPEHPK3PXP';
    const encrypted = encrypt(secret);
    const tx = { user: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, session: { delete: vi.fn() } };
    const auth = { audit: vi.fn(), session: vi.fn(), db: { $transaction: vi.fn(async callback => callback(tx)) } } as unknown as AuthService;
    const service = new AuthMfaService(auth, {} as AuthSessionService, {} as SupabaseAuthService);

    await expect(service.verifyLocal(identity({ mfaSecret: encrypted, pendingMfaSecret: null }, { sessionId: 'session-id' }), totp(secret).generate(), request())).rejects.toBeInstanceOf(UnauthorizedException);

    expect(tx.session.delete).not.toHaveBeenCalled();
    expect(auth.session).not.toHaveBeenCalled();
  });

  it('rejects an unowned Supabase factor before reading provider credentials', async () => {
    const sessions = { requireExternalAccessToken: vi.fn() } as unknown as AuthSessionService;
    const supabase = { challengeFactor: vi.fn(), verifyFactor: vi.fn() } as unknown as SupabaseAuthService;
    const service = new AuthMfaService({} as AuthService, sessions, supabase);
    const actor = identity({ externalMfaFactorId: 'primary-factor', externalBackupMfaFactorId: null, pendingExternalMfaFactorId: null });

    await expect(service.verifyExternal(actor, { factor: 'PRIMARY', factorId: 'other-factor', code: '123456' }, request())).rejects.toBeInstanceOf(BadRequestException);

    expect(sessions.requireExternalAccessToken).not.toHaveBeenCalled();
    expect(supabase.challengeFactor).not.toHaveBeenCalled();
  });

  it('confirms a pending Supabase factor and records the same enrollment audit', async () => {
    const tx = { user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    const auth = { audit: vi.fn(), db: { $transaction: vi.fn(async callback => callback(tx)) } } as unknown as AuthService;
    const sessions = { requireExternalAccessToken: vi.fn().mockReturnValue('access-token') } as unknown as AuthSessionService;
    const providerSession = { access_token: 'a'.repeat(20), refresh_token: 'refresh-token', expires_in: 3600, user: { id: 'auth-subject', email: 'member@example.test' } };
    const supabase = {
      challengeFactor: vi.fn().mockResolvedValue({ id: 'challenge-id' }),
      verifyFactor: vi.fn().mockResolvedValue(providerSession)
    } as unknown as SupabaseAuthService;
    const service = new AuthMfaService(auth, sessions, supabase);
    const actor = identity({ authSubject: 'auth-subject', externalMfaFactorId: null, externalBackupMfaFactorId: null, pendingExternalMfaFactorId: 'pending-factor', pendingExternalMfaKind: 'PRIMARY', pendingExternalMfaExpiresAt: new Date(Date.now() + 60_000) });
    const req = request();

    await expect(service.verifyExternal(actor, { factor: 'PRIMARY', factorId: 'pending-factor', code: '123456' }, req)).resolves.toBe(providerSession);

    expect(req.auth?.aal).toBe(2);
    expect(tx.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'user-id', pendingExternalMfaFactorId: 'pending-factor' }), data: expect.objectContaining({ externalMfaFactorId: 'pending-factor', pendingExternalMfaFactorId: null }) }));
    expect(auth.audit).toHaveBeenCalledWith(tx, req, 'MFA_FACTOR_ENROLLED', 'user-id', 'Supabase二段階認証の登録完了', { factorKind: 'PRIMARY', otherSessionsRevokedByProvider: true });
  });

  it('removes a backup factor, revokes provider and local sessions, and audits the counts', async () => {
    const tx = {
      user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      session: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) }
    };
    const auth = { audit: vi.fn(), db: { $transaction: vi.fn(async callback => callback(tx)) } } as unknown as AuthService;
    const sessions = { requireExternalAccessToken: vi.fn().mockReturnValue('access-token') } as unknown as AuthSessionService;
    const supabase = { unenrollFactor: vi.fn(), logout: vi.fn() } as unknown as SupabaseAuthService;
    const service = new AuthMfaService(auth, sessions, supabase);
    const req = request();

    await service.revokeExternalBackup(identity(), 'backup-factor', '端末交換', req);

    expect(supabase.unenrollFactor).toHaveBeenCalledWith('access-token', 'backup-factor');
    expect(supabase.logout).toHaveBeenCalledWith('access-token');
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-id' } });
    expect(auth.audit).toHaveBeenCalledWith(tx, req, 'MFA_BACKUP_REVOKED', 'user-id', '端末交換', { factorKind: 'BACKUP', providerSessionsRevoked: true, localSessionsRevoked: 2 });
  });
});
