import { beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from './secret-box';
import { resolveMailConfig } from './mail-config';

beforeAll(() => { process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64'); });

describe('resolveMailConfig', () => {
  it('uses a complete encrypted admin configuration without exposing ciphertext as the key', () => {
    const apiKey = 're_admin_secret_key';
    const value = resolveMailConfig(
      { mailApiKeyEncrypted: encryptSecret(apiKey), mailFrom: '競馬会員メディア <notice@example.test>' },
      { RESEND_API_KEY: 're_environment_key', MAIL_FROM: 'env@example.test' }
    );
    expect(value).toMatchObject({ source: 'ADMIN', apiKey, from: '競馬会員メディア <notice@example.test>', apiKeyConfigured: true, secretReadable: true, senderConfigured: true, complete: true });
  });

  it('never fills an incomplete admin configuration from environment values', () => {
    const value = resolveMailConfig(
      { mailApiKeyEncrypted: null, mailFrom: 'notice@example.test' },
      { RESEND_API_KEY: 're_environment_key', MAIL_FROM: 'env@example.test' }
    );
    expect(value).toMatchObject({ source: 'ADMIN', apiKey: null, from: 'notice@example.test', apiKeyConfigured: false, secretReadable: false, senderConfigured: true, complete: false });
  });

  it('falls back to the environment only when no admin mail field is selected', () => {
    const value = resolveMailConfig(
      { mailApiKeyEncrypted: null, mailFrom: null },
      { RESEND_API_KEY: 're_environment_key', MAIL_FROM: 'env@example.test' }
    );
    expect(value).toMatchObject({ source: 'ENVIRONMENT', apiKey: 're_environment_key', from: 'env@example.test', complete: true });
  });
});
