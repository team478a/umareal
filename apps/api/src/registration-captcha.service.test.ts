import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '@keiba/db';
import type { DbService } from './db.service';
import { RegistrationCaptchaService, TEST_REGISTRATION_CAPTCHA_TOKEN } from './registration-captcha.service';

function service(settings: { registrationCaptchaEnabled: boolean; turnstileSiteKey?: string | null; turnstileSecretEncrypted?: string | null }) {
  const db = { systemSetting: { findUnique: vi.fn(async () => settings) } } as unknown as DbService;
  return new RegistrationCaptchaService(db);
}

describe('RegistrationCaptchaService', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_BASE_URL', 'https://members.example.test');
    vi.stubEnv('CAPTCHA_TRANSPORT', 'test');
    vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 6).toString('base64'));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('does not require a token while registration CAPTCHA is disabled', async () => {
    await expect(service({ registrationCaptchaEnabled: false }).verify(undefined, 'request-id')).resolves.toBeUndefined();
  });

  it('accepts only the fixed local test answer without network access', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const captcha = service({ registrationCaptchaEnabled: true, turnstileSecretEncrypted: encryptSecret('secret') });
    await expect(captcha.verify(undefined, 'request-id')).rejects.toMatchObject({ response: { code: 'CAPTCHA_REQUIRED' } });
    await expect(captcha.verify('wrong', 'request-id')).rejects.toMatchObject({ response: { code: 'CAPTCHA_INVALID' } });
    await expect(captcha.verify(TEST_REGISTRATION_CAPTCHA_TOKEN, 'request-id')).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('validates the provider success, action and public hostname', async () => {
    vi.stubEnv('CAPTCHA_TRANSPORT', 'turnstile');
    const request = vi.fn(async () => new Response(JSON.stringify({ success: true, action: 'register', hostname: 'members.example.test' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', request);
    const captcha = service({ registrationCaptchaEnabled: true, turnstileSecretEncrypted: encryptSecret('provider-secret') });
    await expect(captcha.verify('provider-token', 'd4af8f4b-b90a-4f00-bfd9-47872dc9f034')).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(JSON.parse(String(options.body))).toEqual({ secret: 'provider-secret', response: 'provider-token', idempotency_key: 'd4af8f4b-b90a-4f00-bfd9-47872dc9f034' });
  });

  it('rejects a successful response for a different action or hostname', async () => {
    vi.stubEnv('CAPTCHA_TRANSPORT', 'turnstile');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, action: 'login', hostname: 'other.example.test' }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const captcha = service({ registrationCaptchaEnabled: true, turnstileSecretEncrypted: encryptSecret('provider-secret') });
    await expect(captcha.verify('provider-token', 'request-id')).rejects.toMatchObject({ response: { code: 'CAPTCHA_INVALID' } });
  });
});
