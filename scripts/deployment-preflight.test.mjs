import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateDeploymentEnvironment } from './deployment-preflight.mjs';

const secret = Buffer.alloc(32, 7).toString('base64');
const common = {
  NODE_ENV: 'production', LAUNCH_MODE: 'FREE_REGISTRATION', DATABASE_URL: 'postgresql://runtime:secret@db.internal/app',
  APP_BASE_URL: 'https://members.example.test', MARKETING_BASE_URL: 'https://umareal.com', ENCRYPTION_KEY: secret, RATE_LIMIT_PROXY_SECRET: 'test-rate-limit-proxy-secret-32-characters', MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'configured',
  MAIL_FROM: 'Umazone <notice@example.test>', NOTIFICATION_TRANSPORT: 'disabled'
};

describe('deployment environment preflight', () => {
  it('accepts the free-registration API shape while retaining manual checks', () => {
    const result = validateDeploymentEnvironment('api', { ...common, AUTH_PROVIDER: 'supabase', ADMIN_BASE_URL: common.APP_BASE_URL, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'configured', JOB_SECRET: 'x'.repeat(32), RESEND_WEBHOOK_SECRET: 'configured', CAPTCHA_TRANSPORT: 'turnstile', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'disabled', STRIPE_LIVE_MODE: 'false', AUTH_RATE_LIMIT: '60' });
    assert.equal(result.ok, true); assert.equal(result.service, 'api'); assert.equal(result.launchMode, 'FREE_REGISTRATION'); assert.deepEqual(result.errors, []);
    assert.ok(result.manual.some(item => item.code === 'LEGAL_RELEASE'));
    assert.ok(result.manual.some(item => item.code === 'PROVIDER_LIVE_TESTS' && item.message.includes('LINE Login')));
  });

  it('rejects development transports, owner credentials, and malformed secrets without returning values', () => {
    const result = validateDeploymentEnvironment('api', { ...common, DATABASE_ADMIN_URL: 'postgresql://owner:do-not-print@db/app', ENCRYPTION_KEY: 'invalid', AUTH_PROVIDER: 'local', ADMIN_BASE_URL: 'http://localhost:3000', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', JOB_SECRET: 'short', RESEND_WEBHOOK_SECRET: '', CAPTCHA_TRANSPORT: 'test', LINE_OAUTH_TRANSPORT: 'test', BILLING_TRANSPORT: 'test', STRIPE_LIVE_MODE: 'true', AUTH_RATE_LIMIT: '600' });
    assert.equal(result.ok, false);
    for (const code of ['FORBIDDEN_DATABASE_ADMIN_URL', 'ENCRYPTION_KEY', 'AUTH_PROVIDER', 'CAPTCHA_TRANSPORT']) assert.ok(result.errors.some(item => item.code === code));
    assert.equal(JSON.stringify(result).includes('do-not-print'), false);
  });

  it('blocks a public API release when the marketing LP origin is missing or malformed', () => {
    const base = { ...common, AUTH_PROVIDER: 'supabase', ADMIN_BASE_URL: common.APP_BASE_URL, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'configured', JOB_SECRET: 'x'.repeat(32), RESEND_WEBHOOK_SECRET: 'configured', CAPTCHA_TRANSPORT: 'turnstile', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'disabled', STRIPE_LIVE_MODE: 'false', AUTH_RATE_LIMIT: '60' };
    const missing = { ...base };
    delete missing.MARKETING_BASE_URL;
    for (const env of [missing, { ...base, MARKETING_BASE_URL: 'https://umareal.com/register' }]) {
      const result = validateDeploymentEnvironment('api', env);
      assert.equal(result.ok, false);
      assert.ok(result.errors.some(item => item.code === 'MARKETING_BASE_URL'));
    }
  });

  it('validates worker and web service boundaries independently', () => {
    assert.equal(validateDeploymentEnvironment('worker', common).ok, true);
    assert.equal(validateDeploymentEnvironment('web', { NODE_ENV: 'production', API_BASE_URL: 'umareal-api:10000', RATE_LIMIT_PROXY_SECRET: common.RATE_LIMIT_PROXY_SECRET }).ok, true);
    assert.equal(validateDeploymentEnvironment('web', { NODE_ENV: 'production', API_BASE_URL: 'https://user:secret@example.test/path', RATE_LIMIT_PROXY_SECRET: common.RATE_LIMIT_PROXY_SECRET }).ok, false);
    assert.ok(validateDeploymentEnvironment('web', { NODE_ENV: 'production', API_BASE_URL: 'umareal-api:10000' }).errors.some(item => item.code === 'RATE_LIMIT_PROXY_SECRET'));
  });

  it('allows free-member LINE delivery without enabling billing and rejects unsafe transports', () => {
    const api = { ...common, AUTH_PROVIDER: 'supabase', ADMIN_BASE_URL: common.APP_BASE_URL, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'configured', JOB_SECRET: 'x'.repeat(32), RESEND_WEBHOOK_SECRET: 'configured', CAPTCHA_TRANSPORT: 'turnstile', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'disabled', STRIPE_LIVE_MODE: 'false', AUTH_RATE_LIMIT: '60', NOTIFICATION_TRANSPORT: 'line' };
    assert.equal(validateDeploymentEnvironment('api', api).ok, true);
    assert.equal(validateDeploymentEnvironment('worker', { ...common, NOTIFICATION_TRANSPORT: 'line' }).ok, true);
    assert.ok(validateDeploymentEnvironment('api', { ...api, BILLING_TRANSPORT: 'stripe' }).errors.some(item => item.code === 'BILLING_TRANSPORT'));
    assert.ok(validateDeploymentEnvironment('api', { ...api, STRIPE_LIVE_MODE: 'true' }).errors.some(item => item.code === 'STRIPE_LIVE_MODE'));
    for (const service of ['api', 'worker']) {
      assert.ok(validateDeploymentEnvironment(service, { ...api, NOTIFICATION_TRANSPORT: 'test' }).errors.some(item => item.code === 'NOTIFICATION_TRANSPORT'));
      for (const mode of ['CLOUD_STAGING', 'STRIPE_SANDBOX']) {
        assert.ok(validateDeploymentEnvironment(service, { ...api, LAUNCH_MODE: mode }).errors.some(item => item.code === 'NOTIFICATION_TRANSPORT'));
      }
    }
  });

  it('permits bank transfer without Stripe live mode in free-registration and full launch modes', () => {
    const base = { ...common, AUTH_PROVIDER: 'supabase', ADMIN_BASE_URL: common.APP_BASE_URL, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'configured', JOB_SECRET: 'x'.repeat(32), RESEND_WEBHOOK_SECRET: 'configured', CAPTCHA_TRANSPORT: 'turnstile', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'bank_transfer', STRIPE_LIVE_MODE: 'false', AUTH_RATE_LIMIT: '60' };
    for (const launchMode of ['FREE_REGISTRATION', 'FULL']) {
      const result = validateDeploymentEnvironment('api', { ...base, LAUNCH_MODE: launchMode, NOTIFICATION_TRANSPORT: launchMode === 'FULL' ? 'line' : 'disabled' });
      assert.equal(result.ok, true);
      assert.ok(result.manual.some(item => item.code === 'PROVIDER_LIVE_TESTS' && item.message.includes('bank-transfer')));
    }
    assert.ok(validateDeploymentEnvironment('api', { ...base, STRIPE_LIVE_MODE: 'true' }).errors.some(item => item.code === 'STRIPE_LIVE_MODE'));
  });

  it('keeps staging noindex checks and permits only no-charge billing rehearsal', () => {
    const api = validateDeploymentEnvironment('api', { ...common, LAUNCH_MODE: 'CLOUD_STAGING', AUTH_PROVIDER: 'supabase', ADMIN_BASE_URL: common.APP_BASE_URL, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'configured', JOB_SECRET: 'x'.repeat(32), RESEND_WEBHOOK_SECRET: 'configured', CAPTCHA_TRANSPORT: 'turnstile', LINE_OAUTH_TRANSPORT: 'disabled', BILLING_TRANSPORT: 'test', STRIPE_LIVE_MODE: 'false', AUTH_RATE_LIMIT: '60' });
    assert.equal(api.ok, true);
    assert.ok(api.manual.some(item => item.code === 'STAGING_DRAFT_LEGAL_ONLY'));
    assert.equal(api.manual.some(item => item.code === 'LEGAL_RELEASE'), false);
    const web = validateDeploymentEnvironment('web', { NODE_ENV: 'production', LAUNCH_MODE: 'CLOUD_STAGING', API_BASE_URL: 'umareal-staging-api:10000', RATE_LIMIT_PROXY_SECRET: common.RATE_LIMIT_PROXY_SECRET });
    assert.equal(web.ok, true);
    assert.ok(web.manual.some(item => item.code === 'STAGING_NOINDEX'));
    const unsafe = validateDeploymentEnvironment('api', { ...common, LAUNCH_MODE: 'CLOUD_STAGING', AUTH_PROVIDER: 'supabase', ADMIN_BASE_URL: common.APP_BASE_URL, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'configured', JOB_SECRET: 'x'.repeat(32), RESEND_WEBHOOK_SECRET: 'configured', CAPTCHA_TRANSPORT: 'turnstile', LINE_OAUTH_TRANSPORT: 'disabled', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'false', AUTH_RATE_LIMIT: '60' });
    assert.equal(unsafe.ok, false);
    assert.ok(unsafe.errors.some(item => item.code === 'BILLING_TRANSPORT'));
  });

  it('permits Stripe test mode only in the dedicated cloud sandbox', () => {
    const sandbox = { ...common, LAUNCH_MODE: 'STRIPE_SANDBOX', AUTH_PROVIDER: 'supabase', ADMIN_BASE_URL: common.APP_BASE_URL, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'configured', JOB_SECRET: 'x'.repeat(32), RESEND_WEBHOOK_SECRET: 'configured', CAPTCHA_TRANSPORT: 'turnstile', LINE_OAUTH_TRANSPORT: 'disabled', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'false', AUTH_RATE_LIMIT: '60' };
    const api = validateDeploymentEnvironment('api', sandbox);
    assert.equal(api.ok, true);
    assert.ok(api.manual.some(item => item.code === 'STAGING_DRAFT_LEGAL_ONLY'));
    assert.ok(api.manual.some(item => item.code === 'PROVIDER_LIVE_TESTS' && item.message.includes('Stripe test-mode')));
    const web = validateDeploymentEnvironment('web', { NODE_ENV: 'production', LAUNCH_MODE: 'STRIPE_SANDBOX', API_BASE_URL: 'umareal-staging-api:10000', RATE_LIMIT_PROXY_SECRET: common.RATE_LIMIT_PROXY_SECRET });
    assert.equal(web.ok, true);
    assert.ok(web.manual.some(item => item.code === 'STAGING_NOINDEX'));
    assert.equal(validateDeploymentEnvironment('api', { ...sandbox, STRIPE_LIVE_MODE: 'true' }).ok, false);
    assert.equal(validateDeploymentEnvironment('api', { ...sandbox, BILLING_TRANSPORT: 'test' }).ok, false);
  });
});
