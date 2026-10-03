import { BadGatewayException, BadRequestException, Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify } from 'jose';
import type { AcquisitionInput, LineLoginReturnPath, LineOAuthPurpose } from '@keiba/domain';
import { AuthService } from './auth.service';
import { decrypt, encrypt, hashToken, newToken } from './security';

const AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';
const FRIENDSHIP_STATUS_URL = 'https://api.line.me/friendship/v1/status';
const ISSUER = 'https://access.line.me';
type Credentials = { channelId: string; channelSecret: string; callbackUrl: string };
export type LineIdentity = { subject: string; friend: boolean | null };

export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier).digest('base64url');
}
export function buildLineAuthorizationUrl(input: { channelId: string; callbackUrl: string; state: string; nonce: string; verifier: string }) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({ response_type: 'code', client_id: input.channelId, redirect_uri: input.callbackUrl, state: input.state, scope: 'openid profile', nonce: input.nonce, code_challenge: pkceChallenge(input.verifier), code_challenge_method: 'S256', bot_prompt: 'aggressive' }).toString();
  return url.toString();
}

export async function exchangeLineCode(input: Credentials & { code: string; verifier: string; nonce: string; checkFriendship?: boolean }, fetcher: typeof fetch = fetch): Promise<LineIdentity> {
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.callbackUrl, client_id: input.channelId, client_secret: input.channelSecret, code_verifier: input.verifier })
    });
  } catch { throw new BadGatewayException({ code: 'LINE_TOKEN_CONNECTION_FAILED', message: 'LINE認証に接続できませんでした。もう一度お試しください。' }); }
  if (!response.ok) throw new BadGatewayException({ code: 'LINE_TOKEN_EXCHANGE_FAILED', message: 'LINE認証を完了できませんでした。もう一度お試しください。' });
  const body = await response.json() as { id_token?: unknown; access_token?: unknown };
  if (typeof body.id_token !== 'string') throw new BadGatewayException({ code: 'LINE_ID_TOKEN_MISSING', message: 'LINE認証を完了できませんでした。もう一度お試しください。' });
  let subject: string;
  try {
    const { payload } = await jwtVerify(body.id_token, new TextEncoder().encode(input.channelSecret), { issuer: ISSUER, audience: input.channelId, algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.nonce !== input.nonce) throw new Error('Invalid claims');
    subject = payload.sub;
  } catch { throw new BadRequestException({ code: 'LINE_ID_TOKEN_INVALID', message: 'LINE認証情報を確認できませんでした。もう一度お試しください。' }); }
  if (!input.checkFriendship) return { subject, friend: null };
  if (typeof body.access_token !== 'string' || !body.access_token) throw new BadGatewayException({ code: 'LINE_ACCESS_TOKEN_MISSING', message: 'LINE友だち追加を確認できませんでした。もう一度お試しください。' });
  let friendshipResponse: Response;
  try {
    friendshipResponse = await fetcher(FRIENDSHIP_STATUS_URL, { method: 'GET', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${body.access_token}` } });
  } catch { throw new BadGatewayException({ code: 'LINE_FRIENDSHIP_CONNECTION_FAILED', message: 'LINE友だち追加を確認できませんでした。もう一度お試しください。' }); }
  if (!friendshipResponse.ok) throw new BadGatewayException({ code: 'LINE_FRIENDSHIP_CHECK_FAILED', message: 'LINE友だち追加を確認できませんでした。もう一度お試しください。' });
  const friendship = await friendshipResponse.json() as { friendFlag?: unknown };
  if (typeof friendship.friendFlag !== 'boolean') throw new BadGatewayException({ code: 'LINE_FRIENDSHIP_RESPONSE_INVALID', message: 'LINE友だち追加を確認できませんでした。もう一度お試しください。' });
  return { subject, friend: friendship.friendFlag };
}

@Injectable()
export class LineLoginService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async credentials(): Promise<Credentials> {
    const value = await this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
    if (!value.lineLoginEnabled || !value.lineLoginChannelId || !value.lineLoginChannelSecretEncrypted || !value.lineLoginCallbackUrl) throw new ServiceUnavailableException({ code: 'LINE_LOGIN_DISABLED', message: 'LINEログインは現在利用できません。' });
    try { return { channelId: value.lineLoginChannelId, channelSecret: decrypt(value.lineLoginChannelSecretEncrypted), callbackUrl: value.lineLoginCallbackUrl }; }
    catch { throw new ServiceUnavailableException({ code: 'LINE_LOGIN_CONFIGURATION_INVALID', message: 'LINEログインの設定を確認してください。' }); }
  }

  async start(purpose: LineOAuthPurpose, userId?: string, acquisition?: AcquisitionInput, memberReferralCode?: string, returnTo?: LineLoginReturnPath) {
    const credentials = await this.credentials();
    const state = randomBytes(32).toString('hex'), nonce = newToken(), verifier = newToken();
    const expiresAt = new Date(Date.now() + 10 * 60000);
    await this.auth.db.lineOAuthFlow.create({ data: { stateHash: hashToken(state), nonceHash: hashToken(nonce), nonceEncrypted: encrypt(nonce), codeVerifierEncrypted: encrypt(verifier), purpose, userId: purpose === 'LINK' ? userId : null, expiresAt, acquisition: purpose === 'REGISTER' ? acquisition : undefined, memberReferralCode: purpose === 'REGISTER' ? memberReferralCode : undefined, returnPath: purpose === 'LOGIN' ? returnTo : undefined } });
    return { authorizationUrl: buildLineAuthorizationUrl({ channelId: credentials.channelId, callbackUrl: credentials.callbackUrl, state, nonce, verifier }), expiresAt };
  }

  async consume(state: string, code: string, linkUserId?: string) {
    if (!state || state.length > 128 || !code || code.length > 2048) throw new BadRequestException({ code: 'LINE_CALLBACK_INVALID', message: 'LINE認証の応答を確認できませんでした。' });
    const stateHash = hashToken(state), now = new Date();
    const flow = await this.auth.db.$transaction(async tx => {
      const current = await tx.lineOAuthFlow.findUnique({ where: { stateHash } });
      if (!current || current.usedAt || current.expiresAt <= now) throw new BadRequestException({ code: 'LINE_FLOW_INVALID', message: 'LINE認証の有効期限が切れています。もう一度お試しください。' });
      if (current.purpose === 'LINK' && current.userId !== linkUserId) throw new UnauthorizedException({ code: 'LINE_LINK_SESSION_MISMATCH', message: '連携を開始したアカウントでログインしてください。' });
      const consumed = await tx.lineOAuthFlow.updateMany({ where: { id: current.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now, nonceEncrypted: encrypt(newToken()), codeVerifierEncrypted: encrypt(newToken()) } });
      if (consumed.count !== 1) throw new BadRequestException({ code: 'LINE_FLOW_INVALID', message: 'LINE認証はすでに使用されています。' });
      return current;
    });
    const credentials = await this.credentials();
    const verifier = decrypt(flow.codeVerifierEncrypted);
    const nonce = decrypt(flow.nonceEncrypted);
    if (hashToken(nonce) !== flow.nonceHash) throw new ServiceUnavailableException({ code: 'LINE_FLOW_CORRUPT', message: 'LINE認証を完了できませんでした。もう一度お試しください。' });
    let identity: LineIdentity;
    if ((process.env.LINE_OAUTH_TRANSPORT ?? 'test') === 'test') {
      if (process.env.NODE_ENV === 'production' || !code.startsWith('test.')) throw new BadRequestException({ code: 'LINE_TEST_TRANSPORT_REJECTED', message: 'LINE認証を完了できませんでした。' });
      identity = { subject: code.slice(5), friend: true };
      if (!identity.subject || identity.subject.length > 255) throw new BadRequestException({ code: 'LINE_SUBJECT_INVALID', message: 'LINE認証情報を確認できませんでした。' });
    } else identity = await exchangeLineCode({ ...credentials, code, verifier, nonce, checkFriendship: flow.purpose === 'REGISTER' });
    return { flow, identity, subjectHash: hashToken(identity.subject) };
  }

}
