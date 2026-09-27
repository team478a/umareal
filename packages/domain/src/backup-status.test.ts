import { describe, expect, it } from 'vitest';
import { adminBackupStatusResponseSchema } from './backup-status';

const verified = {
  status: 'VERIFIED' as const,
  verifiedAt: new Date('2026-09-27T01:02:03.000Z'),
  backupId: 'keiba-physical-20260927010203',
  format: 'postgresql-physical-directory' as const,
  postgresMajor: 16 as const,
  encrypted: false as const,
  sha256: 'a'.repeat(64),
  sizeBytes: 1024,
  fileCount: 10,
  migrations: 70,
  requiredTriggers: 5,
  restoredDatabaseRemoved: true as const,
  counts: {
    users: 1,
    races: 2,
    predictionVersions: 3,
    freeReportVersions: 4,
    audioAssets: 5,
    publicationSchedules: 6,
    memberAcquisitions: 7,
    acquisitionCampaigns: 8,
    auditLogs: 9,
    notificationEvents: 10,
    operationalAlerts: 11,
    operationalAlertDeliveries: 12,
    billingSupportRequests: 13,
    billingSupportEvents: 14
  }
};

describe('administrator backup status API contract', () => {
  it('preserves every existing status shape and normalizes timestamps', () => {
    const parsed = adminBackupStatusResponseSchema.parse(verified);
    expect(parsed.status).toBe('VERIFIED');
    if (parsed.status === 'VERIFIED') expect(parsed.verifiedAt).toBe(verified.verifiedAt.toISOString());

    expect(adminBackupStatusResponseSchema.parse({
      status: 'FAILED',
      attemptedAt: '2026-09-27T01:02:03.000Z',
      errorCode: 'BACKUP_VERIFY_FAILED',
      backupId: null,
      restoredDatabaseRemoved: false
    }).status).toBe('FAILED');
    expect(adminBackupStatusResponseSchema.parse({ status: 'NOT_RUN', localOnly: true }).status).toBe('NOT_RUN');
    expect(adminBackupStatusResponseSchema.parse({ status: 'INVALID', localOnly: true }).status).toBe('INVALID');
  });

  it('rejects database credentials, absolute paths and log content', () => {
    expect(adminBackupStatusResponseSchema.safeParse({ ...verified, databaseUrl: 'postgresql://secret' }).success).toBe(false);
    expect(adminBackupStatusResponseSchema.safeParse({ ...verified, absolutePath: 'C:\\private\\backup' }).success).toBe(false);
    expect(adminBackupStatusResponseSchema.safeParse({
      ...verified,
      counts: { ...verified.counts, log: 'internal output' }
    }).success).toBe(false);
  });
});
