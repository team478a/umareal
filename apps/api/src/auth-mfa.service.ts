import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Secret, TOTP } from 'otpauth';
import { AuthService } from './auth.service';
import { AuthSessionService } from './auth-session.service';
import type { AppRequest, AuthContext } from './context';
import { decrypt, encrypt } from './security';
import { SupabaseAuthService } from './supabase-auth.service';

export type MfaFactorKind = 'PRIMARY' | 'BACKUP';
export type ExternalMfaVerification = { code: string; factor: MfaFactorKind; factorId?: string };

const otp = (secret: string, email: string) => new TOTP({ issuer: 'ウマリアル', label: email, algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) });

@Injectable()
export class AuthMfaService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuthSessionService) private readonly sessions: AuthSessionService,
    @Inject(SupabaseAuthService) private readonly supabase: SupabaseAuthService
  ) {}

  async enrollExternal(identity: AuthContext, kind: MfaFactorKind, req: AppRequest) {
    const factor = await this.supabase.enrollTotp(this.sessions.requireExternalAccessToken(req, 8192));
    await this.auth.db.$transaction(async tx => {
      await tx.user.update({ where: { id: identity.id }, data: { pendingExternalMfaFactorId: factor.id, pendingExternalMfaKind: kind, pendingExternalMfaExpiresAt: new Date(Date.now() + 15 * 60_000) } });
      await this.auth.audit(tx, req, 'MFA_ENROLL_START', identity.id, kind === 'BACKUP' ? 'Supabase予備認証アプリの登録開始' : 'Supabase二段階認証の登録開始', { factorKind: kind });
    });
    return { factorId: factor.id, kind, secret: factor.totp.secret, uri: factor.totp.uri, qrCode: factor.totp.qr_code };
  }

  async enrollLocal(identity: AuthContext, req: AppRequest) {
    const secret = new Secret({ size: 20 }).base32;
    await this.auth.db.$transaction(async tx => {
      await tx.user.update({ where: { id: identity.id }, data: { pendingMfaSecret: encrypt(secret) } });
      await this.auth.audit(tx, req, 'MFA_ENROLL_START', identity.id, '二段階認証の登録開始');
    });
    return { secret, uri: otp(secret, identity.user.email ?? `user-${identity.user.id}`).toString() };
  }

  async verifyExternal(identity: AuthContext, input: ExternalMfaVerification, req: AppRequest) {
    const submittedFactorId = input.factorId;
    const pending = submittedFactorId && identity.user.pendingExternalMfaFactorId === submittedFactorId
      ? { factorId: submittedFactorId, kind: identity.user.pendingExternalMfaKind, expiresAt: identity.user.pendingExternalMfaExpiresAt }
      : null;
    if (submittedFactorId && !pending && ![identity.user.externalMfaFactorId, identity.user.externalBackupMfaFactorId].includes(submittedFactorId)) throw new BadRequestException({ code: 'MFA_FACTOR_INVALID', message: '認証要素を確認できません。' });
    if (pending && (!pending.expiresAt || pending.expiresAt <= new Date() || !['PRIMARY', 'BACKUP'].includes(pending.kind ?? ''))) throw new BadRequestException({ code: 'MFA_ENROLLMENT_EXPIRED', message: '設定時間を過ぎました。もう一度登録を開始してください。' });
    const factorId = submittedFactorId ?? (input.factor === 'BACKUP' ? identity.user.externalBackupMfaFactorId : identity.user.externalMfaFactorId);
    if (!factorId) throw new BadRequestException({ code: 'MFA_NOT_ENROLLED', message: '二段階認証の設定を開始してください。' });
    const resolvedFactorKind = pending?.kind === 'BACKUP' || factorId === identity.user.externalBackupMfaFactorId ? 'BACKUP' : 'PRIMARY';
    const token = this.sessions.requireExternalAccessToken(req, 8192);
    const challenge = await this.supabase.challengeFactor(token, factorId);
    const session = await this.supabase.verifyFactor(token, factorId, challenge.id, input.code);
    if (session.user.id !== identity.user.authSubject) throw new UnauthorizedException();
    req.auth = { ...identity, aal: 2 };
    await this.auth.db.$transaction(async tx => {
      if (pending) {
        const field = pending.kind === 'BACKUP' ? 'externalBackupMfaFactorId' : 'externalMfaFactorId';
        const changed = await tx.user.updateMany({ where: { id: identity.id, pendingExternalMfaFactorId: factorId, pendingExternalMfaExpiresAt: { gt: new Date() }, ...(pending.kind === 'BACKUP' ? { externalMfaFactorId: { not: null }, externalBackupMfaFactorId: null } : { externalMfaFactorId: null }) }, data: { [field]: factorId, pendingExternalMfaFactorId: null, pendingExternalMfaKind: null, pendingExternalMfaExpiresAt: null } });
        if (changed.count !== 1) throw new ConflictException({ code: 'MFA_ENROLLMENT_CHANGED', message: '設定状態が変わりました。最新の状態を確認してください。' });
        await this.auth.audit(tx, req, 'MFA_FACTOR_ENROLLED', identity.id, pending.kind === 'BACKUP' ? 'Supabase予備認証アプリの登録完了' : 'Supabase二段階認証の登録完了', { factorKind: pending.kind, otherSessionsRevokedByProvider: true });
      } else {
        await this.auth.audit(tx, req, 'MFA_VERIFIED', identity.id, resolvedFactorKind === 'BACKUP' ? 'Supabase予備認証アプリで二段階認証成功' : 'Supabase二段階認証成功', { factorKind: resolvedFactorKind });
      }
    });
    return session;
  }

  async verifyLocal(identity: AuthContext, code: string, req: AppRequest) {
    const encrypted = identity.user.mfaSecret ?? identity.user.pendingMfaSecret;
    if (!encrypted || !identity.sessionId) throw new BadRequestException('MFA_NOT_ENROLLED');
    const timestamp = Date.now();
    const delta = otp(decrypt(encrypted), identity.user.email ?? `user-${identity.user.id}`).validate({ token: code, window: 1, timestamp });
    if (delta === null) throw new UnauthorizedException({ code: 'MFA_INVALID', message: '認証コードを確認してください。' });
    const step = BigInt(Math.floor(timestamp / 30000) + delta);
    return this.auth.db.$transaction(async tx => {
      const changed = await tx.user.updateMany({ where: { id: identity.id, mfaSecret: identity.user.mfaSecret, pendingMfaSecret: identity.user.pendingMfaSecret, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaSecret: encrypted, pendingMfaSecret: null, mfaLastStep: step } });
      if (changed.count !== 1) throw new UnauthorizedException({ code: 'MFA_REPLAY', message: '次の認証コードで再度お試しください。' });
      await tx.session.delete({ where: { id: identity.sessionId } });
      await this.auth.audit(tx, req, 'MFA_VERIFIED', identity.id, '二段階認証成功');
      return this.auth.session(tx, identity.id, 2);
    });
  }

  async revokeExternalBackup(identity: AuthContext, factorId: string, reason: string, req: AppRequest) {
    const accessToken = this.sessions.requireExternalAccessToken(req, 8192);
    await this.supabase.unenrollFactor(accessToken, factorId);
    await this.supabase.logout(accessToken);
    await this.auth.db.$transaction(async tx => {
      const changed = await tx.user.updateMany({ where: { id: identity.id, externalBackupMfaFactorId: factorId }, data: { externalBackupMfaFactorId: null } });
      if (changed.count !== 1) throw new ConflictException({ code: 'MFA_BACKUP_CHANGED', message: '設定状態が変わりました。最新の状態を確認してください。' });
      const localSessions = await tx.session.deleteMany({ where: { userId: identity.id } });
      await this.auth.audit(tx, req, 'MFA_BACKUP_REVOKED', identity.id, reason, { factorKind: 'BACKUP', providerSessionsRevoked: true, localSessionsRevoked: localSessions.count });
    });
  }
}
