import { BadRequestException, HttpException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable().optional(),
  email_confirmed_at: z.string().datetime().nullable().optional(),
  confirmed_at: z.string().datetime().nullable().optional(),
  identities: z.array(z.unknown()).optional()
}).passthrough();
const sessionSchema = z.object({
  access_token: z.string().min(20),
  refresh_token: z.string().min(8),
  expires_in: z.number().int().positive(),
  user: userSchema
}).passthrough();

export type SupabaseUser = z.infer<typeof userSchema>;
export type SupabaseSession = z.infer<typeof sessionSchema>;

function sessionResponse(value: unknown) {
  const parsed = sessionSchema.safeParse(value);
  if (!parsed.success) throw new ServiceUnavailableException({ code: 'AUTH_INVALID_RESPONSE', message: '認証サービスの応答を確認できません。' });
  return parsed.data;
}

function configuration() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new ServiceUnavailableException({ code: 'AUTH_UNAVAILABLE', message: '認証サービスを利用できません。' });
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ServiceUnavailableException({ code: 'AUTH_UNAVAILABLE', message: '認証サービスを利用できません。' }); }
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') throw new ServiceUnavailableException({ code: 'AUTH_UNAVAILABLE', message: '認証サービスを利用できません。' });
  return { url: parsed.toString().replace(/\/$/, ''), key };
}

@Injectable()
export class SupabaseAuthService {
  private async request(path: string, body: unknown, accessToken?: string) {
    const { url, key } = configuration();
    let response: Response;
    try {
      response = await fetch(`${url}/auth/v1/${path}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${accessToken ?? key}`, 'Content-Type': 'application/json', 'X-Client-Info': 'umareal-server/1' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000)
      });
    } catch { throw new ServiceUnavailableException({ code: 'AUTH_UNAVAILABLE', message: '認証サービスへ接続できません。' }); }
    let value: unknown = {};
    if (response.headers.get('content-type')?.includes('application/json')) {
      try { value = await response.json(); } catch { value = {}; }
    }
    if (response.ok) return value;
    if (response.status === 429) throw new HttpException({ code: 'AUTH_RATE_LIMITED', message: 'しばらく待ってから再度お試しください。' }, 429);
    if (response.status >= 500) throw new ServiceUnavailableException({ code: 'AUTH_UNAVAILABLE', message: '認証サービスを利用できません。' });
    throw new BadRequestException({ code: 'AUTH_REQUEST_REJECTED', message: '認証情報を確認してください。' });
  }

  async signUp(input: { email: string; password: string }, challenge: string, redirectTo: string) {
    const value = await this.request(`signup?redirect_to=${encodeURIComponent(redirectTo)}`, { ...input, code_challenge: challenge, code_challenge_method: 's256' });
    const session = sessionSchema.safeParse(value);
    if (session.success) return { user: session.data.user, session: session.data };
    const user = userSchema.safeParse(value);
    if (!user.success) throw new ServiceUnavailableException({ code: 'AUTH_INVALID_RESPONSE', message: '認証サービスの応答を確認できません。' });
    return { user: user.data, session: null };
  }

  async signIn(email: string, password: string) {
    try { return sessionResponse(await this.request('token?grant_type=password', { email, password })); }
    catch (error) { if (error instanceof BadRequestException) throw new UnauthorizedException({ code: 'LOGIN_FAILED', message: 'メールアドレスまたはパスワードを確認してください。' }); throw error; }
  }

  async exchangeCode(code: string, verifier: string) {
    return sessionResponse(await this.request('token?grant_type=pkce', { auth_code: code, code_verifier: verifier }));
  }

  async refresh(refreshToken: string) {
    try { return sessionResponse(await this.request('token?grant_type=refresh_token', { refresh_token: refreshToken })); }
    catch (error) { if (error instanceof BadRequestException) throw new UnauthorizedException({ code: 'SESSION_EXPIRED', message: 'もう一度ログインしてください。' }); throw error; }
  }

  async resend(email: string, challenge: string) {
    await this.request('resend', { type: 'signup', email, code_challenge: challenge, code_challenge_method: 's256' });
  }

  async recover(email: string, challenge: string, redirectTo: string) {
    await this.request(`recover?redirect_to=${encodeURIComponent(redirectTo)}`, { email, code_challenge: challenge, code_challenge_method: 's256' });
  }

  async updatePassword(accessToken: string, password: string) { await this.request('user', { password }, accessToken); }
  async logout(accessToken: string) {
    try { await this.request('logout?scope=global', {}, accessToken); } catch (error) { if (!(error instanceof UnauthorizedException) && !(error instanceof BadRequestException)) throw error; }
  }
}
