import { beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from './secret-box';
import { resolveMailConfig } from './mail-config';

beforeAll(() => { process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64'); });

describe('resolveMailConfig', () => {
  it('uses a complete encrypted admin configuration without exposing ciphertext as the key', () => {
    const apiKey = 're_admin_secret_key';
    const webhookSecret = 'whsec_admin_secret_key';
    const value = resolveMailConfig(
      { mailApiKeyEncrypted: encryptSecret(apiKey), mailWebhookSecretEncrypted: encryptSecret(webhookSecret), mailFrom: '競馬会員メディア <notice@example.test>' },
      { RESEND_API_KEY: 're_environment_key', RESEND_WEBHOOK_SECRET: 'whsec_environment', MAIL_FROM: 'env@example.test' }
    );
    expect(value).toMatchObject({ source: 'ADMIN', apiKey, webhookSecret, from: '競馬会員メディア <notice@example.test>', apiKeyConfigured: true, webhookSecretConfigured: true, secretReadable: true, webhookSecretReadable: true, senderConfigured: true, sendingComplete: true, webhookComplete: true, complete: true });
  });

  it('never fills an incomplete admin configuration from environment values', () => {
    const value = resolveMailConfig(
      { mailApiKeyEncrypted: null, mailWebhookSecretEncrypted: null, mailFrom: 'notice@example.test' },
      { RESEND_API_KEY: 're_environment_key', RESEND_WEBHOOK_SECRET: 'whsec_environment', MAIL_FROM: 'env@example.test' }
    );
    expect(value).toMatchObject({ source: 'ADMIN', apiKey: null, from: 'notice@example.test', apiKeyConfigured: false, secretReadable: false, senderConfigured: true, complete: false });
  });

  it('falls back to the environment only when no admin mail field is selected', () => {
    const value = resolveMailConfig(
      { mailApiKeyEncrypted: null, mailWebhookSecretEncrypted: null, mailFrom: null },
      { RESEND_API_KEY: 're_environment_key', RESEND_WEBHOOK_SECRET: 'whsec_environment', MAIL_FROM: 'env@example.test' }
    );
    expect(value).toMatchObject({ source: 'ENVIRONMENT', apiKey: 're_environment_key', from: 'env@example.test', complete: true });
  });
});
