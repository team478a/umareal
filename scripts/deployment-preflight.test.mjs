import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateDeploymentEnvironment } from './deployment-preflight.mjs';

const secret = Buffer.alloc(32, 7).toString('base64');
const common = {
  NODE_ENV: 'production', LAUNCH_MODE: 'FREE_REGISTRATION', DATABASE_URL: 'postgresql://runtime:secret@db.internal/app',
  APP_BASE_URL: 'https://members.example.test', ENCRYPTION_KEY: secret, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'configured',
  MAIL_FROM: 'Umazone <notice@example.test>', NOTIFICATION_TRANSPORT: 'disabled'
};

describe('deployment environment preflight', () => {
  it('accepts the free-registration API shape while retaining manual checks', () => {
    const result = validateDeploymentEnvironment('api', { ...common, AUTH_PROVIDER: 'supabase', ADMIN_BASE_URL: common.APP_BASE_URL, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'configured', JOB_SECRET: 'x'.repeat(32), RESEND_WEBHOOK_SECRET: 'configured', CAPTCHA_TRANSPORT: 'turnstile', LINE_OAUTH_TRANSPORT: 'disabled', BILLING_TRANSPORT: 'disabled', STRIPE_LIVE_MODE: 'false', AUTH_RATE_LIMIT: '60' });
    assert.equal(result.ok, true); assert.equal(result.service, 'api'); assert.equal(result.launchMode, 'FREE_REGISTRATION'); assert.deepEqual(result.errors, []);
    assert.ok(result.manual.some(item => item.code === 'LEGAL_RELEASE'));
  });

  it('rejects development transports, owner credentials, and malformed secrets without returning values', () => {
    const result = validateDeploymentEnvironment('api', { ...common, DATABASE_ADMIN_URL: 'postgresql://owner:do-not-print@db/app', ENCRYPTION_KEY: 'invalid', AUTH_PROVIDER: 'local', ADMIN_BASE_URL: 'http://localhost:3000', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', JOB_SECRET: 'short', RESEND_WEBHOOK_SECRET: '', CAPTCHA_TRANSPORT: 'test', LINE_OAUTH_TRANSPORT: 'test', BILLING_TRANSPORT: 'test', STRIPE_LIVE_MODE: 'true', AUTH_RATE_LIMIT: '600' });
    assert.equal(result.ok, false);
    for (const code of ['FORBIDDEN_DATABASE_ADMIN_URL', 'ENCRYPTION_KEY', 'AUTH_PROVIDER', 'CAPTCHA_TRANSPORT']) assert.ok(result.errors.some(item => item.code === code));
    assert.equal(JSON.stringify(result).includes('do-not-print'), false);
  });

  it('validates worker and web service boundaries independently', () => {
    assert.equal(validateDeploymentEnvironment('worker', common).ok, true);
    assert.equal(validateDeploymentEnvironment('web', { NODE_ENV: 'production', API_BASE_URL: 'umareal-api:10000' }).ok, true);
    assert.equal(validateDeploymentEnvironment('web', { NODE_ENV: 'production', API_BASE_URL: 'https://user:secret@example.test/path' }).ok, false);
  });

  it('requires a strong access gate for cloud staging without enabling paid features', () => {
    const api = validateDeploymentEnvironment('api', { ...common, LAUNCH_MODE: 'CLOUD_STAGING', AUTH_PROVIDER: 'supabase', ADMIN_BASE_URL: common.APP_BASE_URL, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'configured', JOB_SECRET: 'x'.repeat(32), RESEND_WEBHOOK_SECRET: 'configured', CAPTCHA_TRANSPORT: 'turnstile', LINE_OAUTH_TRANSPORT: 'disabled', BILLING_TRANSPORT: 'disabled', STRIPE_LIVE_MODE: 'false', AUTH_RATE_LIMIT: '60' });
    assert.equal(api.ok, true);
    assert.ok(api.manual.some(item => item.code === 'STAGING_DRAFT_LEGAL_ONLY'));
    assert.equal(api.manual.some(item => item.code === 'LEGAL_RELEASE'), false);
    const web = validateDeploymentEnvironment('web', { NODE_ENV: 'production', LAUNCH_MODE: 'CLOUD_STAGING', API_BASE_URL: 'umareal-staging-api:10000', STAGING_ACCESS_USERNAME: 'reviewer', STAGING_ACCESS_PASSWORD: 'x'.repeat(24) });
    assert.equal(web.ok, true);
    assert.ok(web.manual.some(item => item.code === 'STAGING_ACCESS_GATE'));
    assert.equal(validateDeploymentEnvironment('web', { NODE_ENV: 'production', LAUNCH_MODE: 'CLOUD_STAGING', API_BASE_URL: 'umareal-staging-api:10000', STAGING_ACCESS_USERNAME: 'reviewer', STAGING_ACCESS_PASSWORD: 'short' }).ok, false);
  });
});
