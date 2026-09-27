import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import type { AppRequest } from './context';
import type { SupabaseSession } from './supabase-auth.service';

export type ExternalAuthFlow = 'signup' | 'recovery';

const localCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/'
});

const localClearCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  path: '/'
});

const externalCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/'
});

@Injectable()
export class AuthSessionService {
  createPkce() {
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  setLocalSession(res: Response, token: string) {
    res.cookie('keiba_session', token, { ...localCookieOptions(), maxAge: 8 * 3600000 });
  }

  clearLocalSession(res: Response) {
    res.clearCookie('keiba_session', localClearCookieOptions());
  }

  setExternalSession(res: Response, session: SupabaseSession) {
    res.cookie('keiba_access_token', session.access_token, { ...externalCookieOptions(), maxAge: session.expires_in * 1000 });
    res.cookie('keiba_refresh_token', session.refresh_token, { ...externalCookieOptions(), maxAge: 30 * 86400 * 1000 });
  }

  setExternalFlow(res: Response, verifier: string, flow: ExternalAuthFlow) {
    res.cookie('keiba_pkce_verifier', verifier, { ...externalCookieOptions(), maxAge: 24 * 3600000 });
    res.cookie('keiba_auth_flow', flow, { ...externalCookieOptions(), maxAge: 24 * 3600000 });
  }

  readExternalFlow(req: AppRequest): { verifier: string; flow: ExternalAuthFlow } | null {
    const verifier: unknown = req.cookies?.keiba_pkce_verifier;
    const flow: unknown = req.cookies?.keiba_auth_flow;
    if (typeof verifier !== 'string' || verifier.length < 43 || (flow !== 'signup' && flow !== 'recovery')) return null;
    return { verifier, flow };
  }

  clearExternalFlow(res: Response) {
    res.clearCookie('keiba_pkce_verifier', externalCookieOptions());
    res.clearCookie('keiba_auth_flow', externalCookieOptions());
  }

  clearExternalSession(res: Response) {
    for (const name of ['keiba_access_token', 'keiba_refresh_token', 'keiba_pkce_verifier', 'keiba_auth_flow']) {
      res.clearCookie(name, externalCookieOptions());
    }
  }

  readExternalAccessToken(req: AppRequest) {
    const value: unknown = req.cookies?.keiba_access_token;
    return typeof value === 'string' ? value : null;
  }

  requireExternalAccessToken(req: AppRequest, maximumLength?: number) {
    const value = this.readExternalAccessToken(req);
    if (value === null || (maximumLength !== undefined && value.length > maximumLength)) throw new UnauthorizedException();
    return value;
  }

  readExternalRefreshToken(req: AppRequest) {
    const value: unknown = req.cookies?.keiba_refresh_token;
    return typeof value === 'string' && value.length <= 4096 ? value : null;
  }
}
