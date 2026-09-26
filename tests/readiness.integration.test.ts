import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('production readiness', () => {
  it('shows only non-secret evidence to AAL2 administrators', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN'));
    expect((await admin.call('admin/readiness')).status).toBe(403);
    await admin.mfa();
    const response = await admin.call('admin/readiness');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('NOT_READY');
    expect(response.body.counts).toEqual(expect.objectContaining({ total: 15 }));
    expect(response.body.counts.blocked).toBeGreaterThan(0);
    expect(response.body.checks.map((item: { code: string }) => item.code)).toEqual([
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
    expect(response.body.checks.find((item: { code: string }) => item.code === 'DATABASE_LEAST_PRIVILEGE')?.status).toBe('BLOCKED');
    expect(['READY', 'BLOCKED']).toContain(response.body.checks.find((item: { code: string }) => item.code === 'LOCAL_RESTORE_TEST')?.status);
    expect(response.body.declaration).toContain('本番公開を承認しません');
    expect(JSON.stringify(response.body)).not.toMatch(/DATABASE_URL|SUPABASE_ANON_KEY|RESEND_API_KEY|lineChannelSecretEncrypted|lineAccessTokenEncrypted|\.local|55432|password/i);

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call('admin/readiness')).status).toBe(403);
    const member = new Client(); await member.login(await account());
    expect((await member.call('admin/readiness')).status).toBe(403);
  });
});
