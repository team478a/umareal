import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '@keiba/db';
import type { DbService } from './db.service';
import { MailService } from './mail.service';

describe('MailService admin provider configuration', () => {
  beforeEach(() => {
    vi.stubEnv('MAIL_TRANSPORT', 'resend');
    vi.stubEnv('ENCRYPTION_KEY', Buffer.alloc(32, 9).toString('base64'));
    vi.stubEnv('RESEND_API_KEY', 're_environment_key');
    vi.stubEnv('MAIL_FROM', 'env@example.test');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('uses the encrypted admin key and sender for transactional mail', async () => {
    const request = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', request);
    const db = { systemSetting: { findUniqueOrThrow: vi.fn(async () => ({ mailApiKeyEncrypted: encryptSecret('re_admin_key'), mailWebhookSecretEncrypted: null, mailFrom: '競馬会員メディア <notice@example.test>' })) } } as unknown as DbService;
    const service = new MailService(db);
    await service.send({ userId: 'user-id', to: 'member@example.test', kind: 'VERIFY_EMAIL', url: 'https://example.test/verify', expiresInMinutes: 30, idempotencyKey: 'verify:user-id' });
    expect(request).toHaveBeenCalledOnce();
    const options = request.mock.calls[0]?.[1] as RequestInit;
    expect(options.headers).toMatchObject({ Authorization: 'Bearer re_admin_key', 'Idempotency-Key': 'verify:user-id' });
    expect(JSON.parse(String(options.body))).toMatchObject({ from: '競馬会員メディア <notice@example.test>', to: ['member@example.test'] });
  });

  it('rejects an incomplete admin override instead of mixing in environment credentials', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const db = { systemSetting: { findUniqueOrThrow: vi.fn(async () => ({ mailApiKeyEncrypted: null, mailWebhookSecretEncrypted: null, mailFrom: 'notice@example.test' })) } } as unknown as DbService;
    const service = new MailService(db);
    await expect(service.send({ userId: 'user-id', to: 'member@example.test', kind: 'PASSWORD_RESET', url: 'https://example.test/reset', expiresInMinutes: 30, idempotencyKey: 'reset:user-id' })).rejects.toMatchObject({ response: { code: 'MAIL_CONFIGURATION_INVALID' } });
    expect(request).not.toHaveBeenCalled();
  });
});
