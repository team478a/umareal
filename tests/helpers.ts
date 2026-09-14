import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import { PrismaClient } from '../packages/db/src';
import type { Role } from '../packages/db/src';
export const db = new PrismaClient();
export const origin = process.env.APP_BASE_URL ?? 'http://localhost:3000';
export const base = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';
export async function account(role: Role = 'MEMBER') {
  const suffix = randomBytes(7).toString('hex');
  const password = randomBytes(18).toString('base64url'); const salt = randomBytes(16).toString('hex');
  const user = await db.user.create({ data: { email: `${role.toLowerCase()}-${suffix}@example.test`, emailVerifiedAt: new Date(), displayName: `検証用 ${role}`, role, passwordHash: `${salt}:${scryptSync(password, salt, 64).toString('hex')}`, preferences: { create: {} } } });
  return { user, password };
}
// Independent RFC 6238 test generator: verifies the production TOTP library interoperates.
export function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
export class Client {
  cookie = '';
  async call(path: string, method = 'GET', body?: unknown, overrideOrigin = origin, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}/api/v1/${path}`, { method, headers: { Origin: overrideOrigin, Cookie: this.cookie, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async login(fixture: Awaited<ReturnType<typeof account>>) {
    const response = await this.call('auth/login', 'POST', { email: fixture.user.email!, password: fixture.password });
    if (response.status !== 201) throw new Error(`Login test setup failed: ${response.status} (${String(response.body?.code ?? 'UNKNOWN')})`);
    return response;
  }
  async mfa() {
    const enroll = await this.call('auth/mfa/enroll', 'POST');
    if (enroll.status !== 201 || typeof enroll.body?.secret !== 'string') throw new Error(`MFA enrollment test setup failed: ${enroll.status} (${String(enroll.body?.code ?? 'UNKNOWN')})`);
    const code = totp(enroll.body.secret);
    const verified = await this.call('auth/mfa/verify', 'POST', { code });
    if (verified.status !== 201) throw new Error(`MFA test setup failed: ${verified.status}`);
    return { code };
  }
}
