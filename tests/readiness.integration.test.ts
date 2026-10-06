import { afterAll, describe, expect, it } from 'vitest';
import { adminLocalRestoreAttestationResponseSchema, adminProductionBackupAttestationResponseSchema, adminReadinessResponseSchema } from '../packages/domain/src';
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
    expect(['READY', 'MANUAL', 'BLOCKED']).toContain(readiness.checks.find(item => item.code === 'LOCAL_RESTORE_TEST')?.status);
    expect(readiness.declaration).toContain('本番公開を承認しません');
    expect(JSON.stringify(response.body)).not.toMatch(/DATABASE_URL|SUPABASE_ANON_KEY|RESEND_API_KEY|lineChannelSecretEncrypted|lineAccessTokenEncrypted|\.local|55432|password/i);

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call('admin/readiness')).status).toBe(403);
    const member = new Client(); await member.login(await account());
    expect((await member.call('admin/readiness')).status).toBe(403);
  });

  it('records a recent matching restore result as an append-only administrator attestation', async () => {
    const migrations = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const verification = {
      status: 'VERIFIED', verifiedAt: new Date().toISOString(), backupId: `keiba-physical-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`,
      format: 'postgresql-physical-directory', postgresMajor: 16, encrypted: false, sha256: 'b'.repeat(64), sizeBytes: 4096, fileCount: 20,
      migrations: migrations[0]?.count ?? 0, requiredTriggers: 12, restoredDatabaseRemoved: true,
      counts: { users: 1, races: 2, predictionVersions: 3, predictionProducts: 4, predictionProductVersions: 5, freeReportVersions: 6, audioAssets: 7, publicationSchedules: 8, memberAcquisitions: 9, acquisitionCampaigns: 10, auditLogs: 11, notificationEvents: 12, operationalAlerts: 13, operationalAlertDeliveries: 14, billingSupportRequests: 15, billingSupportEvents: 16 }
    };
    const fixture = await account('ADMIN');
    const admin = new Client(); await admin.login(fixture);
    expect((await admin.call('admin/readiness/local-restore-attestation', 'POST', { verification, reason: '公開前の復元確認' })).status).toBe(403);
    await admin.mfa();
    expect((await admin.call('admin/readiness/local-restore-attestation', 'POST', { verification, reason: '公開前の復元確認' }, 'https://evil.example')).status).toBe(403);

    const created = await admin.call('admin/readiness/local-restore-attestation', 'POST', { verification, reason: '公開前の復元確認' });
    expect(created.status).toBe(201);
    const parsed = adminLocalRestoreAttestationResponseSchema.parse(created.body);
    expect(parsed.latest).toEqual(expect.objectContaining({ recordedBy: { id: fixture.user.id, displayName: fixture.user.displayName }, reason: '公開前の復元確認' }));
    expect(parsed.latest?.verification.migrations).toBe(verification.migrations);

    const fetched = await admin.call('admin/readiness/local-restore-attestation');
    expect(fetched.status).toBe(200);
    expect(adminLocalRestoreAttestationResponseSchema.parse(fetched.body).latest?.id).toBe(parsed.latest?.id);
    expect(await db.auditLog.findUnique({ where: { id: parsed.latest!.id }, select: { action: true, targetType: true, targetId: true, reason: true } })).toEqual({ action: 'LOCAL_RESTORE_ATTESTED', targetType: 'READINESS_CHECK', targetId: 'LOCAL_RESTORE_TEST', reason: '公開前の復元確認' });

    const mismatch = await admin.call('admin/readiness/local-restore-attestation', 'POST', { verification: { ...verification, migrations: verification.migrations + 1 }, reason: '不一致の確認' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('RESTORE_MIGRATION_MISMATCH');
    const stale = await admin.call('admin/readiness/local-restore-attestation', 'POST', { verification: { ...verification, verifiedAt: new Date(Date.now() - 8 * 86400000).toISOString() }, reason: '期限切れの確認' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('RESTORE_VERIFICATION_EXPIRED');

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call('admin/readiness/local-restore-attestation')).status).toBe(403);
    expect((await operator.call('admin/readiness/local-restore-attestation', 'POST', { verification, reason: '権限なし' })).status).toBe(403);
  });

  it('records production backup controls as manual, append-only evidence', async () => {
    const fixture = await account('ADMIN');
    const admin = new Client(); await admin.login(fixture);
    const input = {
      provider: 'Managed PostgreSQL', encryptedAtRest: true, separateFailureDomain: true, automatedBackups: true,
      retentionDays: 30, retentionGenerations: 14, rpoMinutes: 60, rtoMinutes: 240, responsibleRole: '運用責任者',
      restoreTestedAt: new Date(Date.now() - 86400000).toISOString(), nextReviewAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      evidenceReference: 'ops/backup-review-integration', reason: '本番公開前の運用確認'
    };
    expect((await admin.call('admin/readiness/production-backup-attestation', 'POST', input)).status).toBe(403);
    await admin.mfa();
    expect((await admin.call('admin/readiness/production-backup-attestation', 'POST', input, 'https://evil.example')).status).toBe(403);

    const created = await admin.call('admin/readiness/production-backup-attestation', 'POST', input);
    expect(created.status).toBe(201);
    const parsed = adminProductionBackupAttestationResponseSchema.parse(created.body);
    expect(parsed.latest).toMatchObject({ provider: input.provider, recordedBy: { id: fixture.user.id, displayName: fixture.user.displayName }, reviewStatus: 'CURRENT' });
    expect(JSON.stringify(parsed)).not.toMatch(/databaseUrl|secret|token|https:/i);

    const fetched = await admin.call('admin/readiness/production-backup-attestation');
    expect(adminProductionBackupAttestationResponseSchema.parse(fetched.body).latest?.id).toBe(parsed.latest?.id);
    expect(await db.auditLog.findUnique({ where: { id: parsed.latest!.id }, select: { action: true, targetType: true, targetId: true, reason: true } })).toEqual({ action: 'PRODUCTION_BACKUP_ATTESTED', targetType: 'READINESS_CHECK', targetId: 'PRODUCTION_BACKUP', reason: input.reason });

    const readiness = adminReadinessResponseSchema.parse((await admin.call('admin/readiness')).body);
    const productionBackup = readiness.checks.find(item => item.code === 'PRODUCTION_BACKUP');
    expect(productionBackup).toMatchObject({ status: 'MANUAL' });
    expect(productionBackup?.evidence).toContain('外部基盤の自動検証ではありません');

    const futureRestore = await admin.call('admin/readiness/production-backup-attestation', 'POST', { ...input, restoreTestedAt: new Date(Date.now() + 3600000).toISOString() });
    expect(futureRestore.body.code).toBe('BACKUP_RESTORE_TEST_IN_FUTURE');
    const expired = await admin.call('admin/readiness/production-backup-attestation', 'POST', { ...input, nextReviewAt: new Date(Date.now() - 1000).toISOString() });
    expect(expired.body.code).toBe('BACKUP_REVIEW_EXPIRED');
    expect((await admin.call('admin/readiness/production-backup-attestation', 'POST', { ...input, evidenceReference: 'https://example.test/?token=secret' })).status).toBe(400);

    const operator = new Client(); await operator.login(await account('OPERATOR')); await operator.mfa();
    expect((await operator.call('admin/readiness/production-backup-attestation')).status).toBe(403);
    expect((await operator.call('admin/readiness/production-backup-attestation', 'POST', input)).status).toBe(403);
  });
});
