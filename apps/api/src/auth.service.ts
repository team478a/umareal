import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Prisma } from '@keiba/db';
import type { AppRequest, AuthContext } from './context';
import { DbService } from './db.service';
import { hashToken, newToken } from './security';

@Injectable()
export class AuthService {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(@Inject(DbService) readonly db: DbService) {}
  ensureLocal() {
    if (process.env.AUTH_PROVIDER !== 'local' || process.env.NODE_ENV === 'production') throw new ForbiddenException({ code: 'LOCAL_AUTH_DISABLED', message: 'この認証方法は利用できません。' });
  }
  async authenticate(req: AppRequest): Promise<AuthContext> {
    if (req.auth) return req.auth;
    const token: unknown = req.cookies?.keiba_session;
    if (typeof token === 'string' && token.length <= 128) {
      const session = await this.db.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
      if (session && session.expiresAt > new Date() && !session.user.disabledAt) return req.auth = { id: session.userId, role: session.user.role, aal: session.aal === 2 ? 2 : 1, user: session.user, sessionId: session.id };
    }
    if (process.env.AUTH_PROVIDER === 'local') { this.ensureLocal(); throw new UnauthorizedException(); }
    if (process.env.AUTH_PROVIDER !== 'supabase') throw new UnauthorizedException();
    const bearerToken = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!bearerToken || !process.env.SUPABASE_URL) throw new UnauthorizedException();
    const issuer = `${process.env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
    this.jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    try {
      const { payload } = await jwtVerify(bearerToken, this.jwks, { issuer, audience: 'authenticated', algorithms: ['RS256', 'ES256'] });
      if (!payload.sub) throw new UnauthorizedException();
      const user = await this.db.user.findUnique({ where: { authSubject: payload.sub } });
      if (!user || user.disabledAt) throw new UnauthorizedException();
      return req.auth = { id: user.id, role: user.role, aal: payload.aal === 'aal2' ? 2 : 1, user };
    } catch { throw new UnauthorizedException(); }
  }
  async session(tx: Prisma.TransactionClient, userId: string, aal = 1) {
    const token = newToken();
    await tx.session.create({ data: { tokenHash: hashToken(token), userId, aal, expiresAt: new Date(Date.now() + 8 * 3600000) } });
    return token;
  }
  audit(tx: Prisma.TransactionClient, req: AppRequest, action: string, targetId: string, reason: string, details: Prisma.InputJsonValue = {}) {
    return tx.auditLog.create({ data: { actorId: req.auth?.id, actorRole: req.auth?.role, action, targetType: 'USER', targetId, reason, details, requestId: req.requestId } });
  }
}
