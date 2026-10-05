import { z } from 'zod';

const backupStatusDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminBackupVerifiedStatusSchema = z.object({
  status: z.literal('VERIFIED'),
  verifiedAt: backupStatusDateTimeSchema,
  backupId: z.string().regex(/^keiba-physical-\d{14}$/),
  format: z.literal('postgresql-physical-directory'),
  postgresMajor: z.literal(16),
  encrypted: z.literal(false),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive(),
  fileCount: z.number().int().positive(),
  migrations: z.number().int().nonnegative(),
  requiredTriggers: z.number().int().nonnegative(),
  restoredDatabaseRemoved: z.literal(true),
  counts: z.object({
    users: z.number().int().nonnegative(),
    races: z.number().int().nonnegative(),
    predictionVersions: z.number().int().nonnegative(),
    predictionProducts: z.number().int().nonnegative(),
    predictionProductVersions: z.number().int().nonnegative(),
    freeReportVersions: z.number().int().nonnegative(),
    audioAssets: z.number().int().nonnegative(),
    publicationSchedules: z.number().int().nonnegative(),
    memberAcquisitions: z.number().int().nonnegative(),
    acquisitionCampaigns: z.number().int().nonnegative(),
    auditLogs: z.number().int().nonnegative(),
    notificationEvents: z.number().int().nonnegative(),
    operationalAlerts: z.number().int().nonnegative(),
    operationalAlertDeliveries: z.number().int().nonnegative(),
    billingSupportRequests: z.number().int().nonnegative(),
    billingSupportEvents: z.number().int().nonnegative()
  }).strict()
}).strict();

export const adminBackupFailedStatusSchema = z.object({
  status: z.literal('FAILED'),
  attemptedAt: backupStatusDateTimeSchema,
  errorCode: z.literal('BACKUP_VERIFY_FAILED'),
  backupId: z.string().regex(/^keiba-physical-\d{14}$/).nullable(),
  restoredDatabaseRemoved: z.boolean()
}).strict();

const adminBackupUnavailableStatusSchema = z.object({
  status: z.enum(['NOT_RUN', 'INVALID']),
  localOnly: z.literal(true)
}).strict();

export const adminBackupStatusResponseSchema = z.union([
  adminBackupVerifiedStatusSchema,
  adminBackupFailedStatusSchema,
  adminBackupUnavailableStatusSchema
]);

export type AdminBackupStatusResponse = z.infer<typeof adminBackupStatusResponseSchema>;
