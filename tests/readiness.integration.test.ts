import { afterAll, describe, expect, it } from 'vitest';
import { adminReadinessResponseSchema } from '../packages/domain/src';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('production readiness', () => {
  it('shows only non-secret evidence to AAL2 administrators', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN'));
    expect((await admin.call('admin/readiness')).status).toBe(403);
    await admin.mfa();
    const response = await admin.call('admin/readiness');
    expect(response.status).toBe(200);
    const readiness = adminReadinessResponseSchema.parse(response.body);
    expect(readiness.status).toBe('NOT_READY');
    expect(readiness.counts).toEqual(expect.objectContaining({ total: 15 }));
    expect(readiness.counts.blocked).toBeGreaterThan(0);
    expect(readiness.checks.map(item => item.code)).toEqual([
      'PRODUCTION_AUTH',
      'ADMIN_CONTINUITY',
      'HTTPS_BASE_URL',
      'REGISTRATION_CAPTCHA',
      'LINE_MESSAGING',
      'LINE_LOGIN',
      'TRANSACTIONAL_MAIL',
      'EXTERNAL_BILLING',
      'LEGAL_DOCUMENTS',
      'DATA_RETENTION',
      'DATABASE_LEAST_PRIVILEGE',
      'LOCAL_RESTORE_TEST',
      'PRODUCTION_BACKUP',
      'EXTERNAL_MONITORING',
      'SAFE_FEATURE_FLAGS'
    ]);
    expect(readiness.checks.find(item => item.code === 'DATABASE_LEAST_PRIVILEGE')?.status).toBe('BLOCKED');
    expect(['READY', 'BLOCKED']).toContain(readiness.checks.find(item => item.code === 'LOCAL_RESTORE_TEST')?.status);
    expect(readiness.declaration).toContain('本番公開を承認しません');
    expect(JSON.stringify(response.body)).not.toMatch(/DATABASE_URL|SUPABASE_ANON_KEY|RESEND_API_KEY|lineChannelSecretEncrypted|lineAccessTokenEncrypted|\.local|55432|password/i);

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call('admin/readiness')).status).toBe(403);
    const member = new Client(); await member.login(await account());
    expect((await member.call('admin/readiness')).status).toBe(403);
  });
});
