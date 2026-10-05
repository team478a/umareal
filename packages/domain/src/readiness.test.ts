import { describe, expect, it } from 'vitest';
import { adminLocalRestoreAttestationInputSchema, adminLocalRestoreAttestationResponseSchema, adminProductionBackupAttestationInputSchema, adminProductionBackupAttestationResponseSchema, adminReadinessResponseSchema } from './readiness';

const verification = {
  status: 'VERIFIED' as const,
  verifiedAt: '2026-10-05T01:00:00.000Z',
  backupId: 'keiba-physical-20261005100000',
  format: 'postgresql-physical-directory' as const,
  postgresMajor: 16 as const,
  encrypted: false as const,
  sha256: 'a'.repeat(64),
  sizeBytes: 1024,
  fileCount: 10,
  migrations: 83,
  requiredTriggers: 12,
  restoredDatabaseRemoved: true as const,
  counts: { users: 1, races: 2, predictionVersions: 3, predictionProducts: 4, predictionProductVersions: 5, freeReportVersions: 6, audioAssets: 7, publicationSchedules: 8, memberAcquisitions: 9, acquisitionCampaigns: 10, auditLogs: 11, notificationEvents: 12, operationalAlerts: 13, operationalAlertDeliveries: 14, billingSupportRequests: 15, billingSupportEvents: 16 }
};

describe('admin readiness API contract', () => {
  it('normalizes server dates and rejects fields outside the public response', () => {
    const generatedAt = new Date('2026-09-26T01:02:03.000Z');
    const response = {
      generatedAt,
      status: 'NOT_READY' as const,
      counts: { ready: 0, blocked: 1, manual: 0, total: 1 },
      checks: [{
        code: 'PRODUCTION_AUTH' as const,
        group: 'APPLICATION' as const,
        status: 'BLOCKED' as const,
        title: '本番認証',
        evidence: 'Supabase設定が不足しています。',
        action: '実環境で認証を確認します。'
      }],
      nextActions: ['PRODUCTION_AUTH' as const],
      settingsUpdatedAt: '2026-09-26T00:00:00.000Z',
      declaration: 'この自動判定だけで本番公開を承認しません。'
    };
    expect(adminReadinessResponseSchema.parse(response).generatedAt).toBe(generatedAt.toISOString());
    expect(adminReadinessResponseSchema.safeParse({ ...response, databaseUrl: 'postgresql://private' }).success).toBe(false);
    expect(adminReadinessResponseSchema.safeParse({ ...response, checks: [{ ...response.checks[0], secret: 'private' }] }).success).toBe(false);
  });

  it('accepts only successful restore evidence with a reason', () => {
    expect(adminLocalRestoreAttestationInputSchema.parse({ verification, reason: ' 公開前の復元確認 ' }).reason).toBe('公開前の復元確認');
    expect(adminLocalRestoreAttestationInputSchema.safeParse({ verification: { ...verification, status: 'FAILED' }, reason: '確認' }).success).toBe(false);
    expect(adminLocalRestoreAttestationInputSchema.safeParse({ verification, reason: '' }).success).toBe(false);
    expect(adminLocalRestoreAttestationInputSchema.safeParse({ verification, reason: '確認', secret: 'private' }).success).toBe(false);
  });

  it('normalizes dates in the public attestation response', () => {
    const response = adminLocalRestoreAttestationResponseSchema.parse({ latest: { id: '10000000-0000-4000-8000-000000000001', recordedAt: new Date('2026-10-05T01:05:00.000Z'), recordedBy: { id: '10000000-0000-4000-8000-000000000002', displayName: '管理者' }, reason: '確認', verification } });
    expect(response.latest?.recordedAt).toBe('2026-10-05T01:05:00.000Z');
    expect(adminLocalRestoreAttestationResponseSchema.parse({ latest: null })).toEqual({ latest: null });
  });

  it('accepts only complete production backup evidence without secret locations', () => {
    const input = {
      provider: 'Managed PostgreSQL', encryptedAtRest: true, separateFailureDomain: true, automatedBackups: true,
      retentionDays: 30, retentionGenerations: 14, rpoMinutes: 60, rtoMinutes: 240,
      responsibleRole: '運用責任者', restoreTestedAt: '2026-10-01T01:00:00.000Z', nextReviewAt: '2026-11-01T01:00:00.000Z',
      evidenceReference: 'ops/backup-review-20261001', reason: '本番公開前の運用確認'
    } as const;
    expect(adminProductionBackupAttestationInputSchema.parse(input).provider).toBe('Managed PostgreSQL');
    expect(adminProductionBackupAttestationInputSchema.safeParse({ ...input, encryptedAtRest: false }).success).toBe(false);
    expect(adminProductionBackupAttestationInputSchema.safeParse({ ...input, evidenceReference: 'https://example.test/?token=secret' }).success).toBe(false);
    expect(adminProductionBackupAttestationInputSchema.safeParse({ ...input, databaseUrl: 'postgresql://secret' }).success).toBe(false);
    expect(adminProductionBackupAttestationResponseSchema.parse({ latest: null })).toEqual({ latest: null });
  });
});
