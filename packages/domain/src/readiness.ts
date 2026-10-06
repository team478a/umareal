import { z } from 'zod';
import { adminBackupVerifiedStatusSchema } from './backup-status';

const readinessDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminReadinessCheckCodeSchema = z.enum([
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

export const adminReadinessCheckSchema = z.object({
  code: adminReadinessCheckCodeSchema,
  group: z.enum(['APPLICATION', 'CONNECTIONS', 'LEGAL_DATA', 'OPERATIONS']),
  status: z.enum(['READY', 'BLOCKED', 'MANUAL']),
  title: z.string().min(1),
  evidence: z.string().min(1),
  action: z.string().min(1),
  href: z.string().regex(/^\/(?!\/)/).optional()
}).strict();

export const adminReadinessResponseSchema = z.object({
  generatedAt: readinessDateTimeSchema,
  status: z.enum(['NOT_READY', 'MANUAL_REVIEW', 'READY_FOR_REVIEW']),
  counts: z.object({
    ready: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    manual: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  }).strict(),
  checks: z.array(adminReadinessCheckSchema),
  nextActions: z.array(adminReadinessCheckCodeSchema),
  settingsUpdatedAt: readinessDateTimeSchema,
  declaration: z.string().min(1)
}).strict();

export const adminLocalRestoreAttestationInputSchema = z.object({
  verification: adminBackupVerifiedStatusSchema,
  reason: z.string().trim().min(1).max(500)
}).strict();

export const adminLocalRestoreAttestationSchema = z.object({
  id: z.string().uuid(),
  recordedAt: readinessDateTimeSchema,
  recordedBy: z.object({ id: z.string().uuid(), displayName: z.string().min(1) }).strict(),
  reason: z.string().min(1),
  verification: adminBackupVerifiedStatusSchema
}).strict();

export const adminLocalRestoreAttestationResponseSchema = z.object({
  latest: adminLocalRestoreAttestationSchema.nullable()
}).strict();

const productionBackupEvidenceReferenceSchema = z.string().trim().min(1).max(100).regex(
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
  '証跡参照は英数字、ハイフン、アンダースコア、ピリオド、スラッシュだけで入力してください。'
);

export const adminProductionBackupAttestationInputSchema = z.object({
  provider: z.string().trim().min(2).max(100),
  encryptedAtRest: z.literal(true),
  separateFailureDomain: z.literal(true),
  automatedBackups: z.literal(true),
  retentionDays: z.number().int().min(1).max(3650),
  retentionGenerations: z.number().int().min(2).max(1000),
  rpoMinutes: z.number().int().min(1).max(10080),
  rtoMinutes: z.number().int().min(1).max(10080),
  responsibleRole: z.string().trim().min(1).max(100),
  restoreTestedAt: readinessDateTimeSchema,
  nextReviewAt: readinessDateTimeSchema,
  evidenceReference: productionBackupEvidenceReferenceSchema,
  reason: z.string().trim().min(1).max(500)
}).strict();

export const adminProductionBackupAttestationSchema = adminProductionBackupAttestationInputSchema.omit({ reason: true }).extend({
  id: z.string().uuid(),
  recordedAt: readinessDateTimeSchema,
  recordedBy: z.object({ id: z.string().uuid(), displayName: z.string().min(1) }).strict(),
  reason: z.string().min(1),
  reviewStatus: z.enum(['CURRENT', 'EXPIRED'])
}).strict();

export const adminProductionBackupAttestationResponseSchema = z.object({
  latest: adminProductionBackupAttestationSchema.nullable()
}).strict();

export type AdminReadinessCheck = z.infer<typeof adminReadinessCheckSchema>;
export type AdminReadinessResponse = z.infer<typeof adminReadinessResponseSchema>;
export type AdminLocalRestoreAttestationInput = z.infer<typeof adminLocalRestoreAttestationInputSchema>;
export type AdminLocalRestoreAttestation = z.infer<typeof adminLocalRestoreAttestationSchema>;
export type AdminLocalRestoreAttestationResponse = z.infer<typeof adminLocalRestoreAttestationResponseSchema>;
export type AdminProductionBackupAttestationInput = z.infer<typeof adminProductionBackupAttestationInputSchema>;
export type AdminProductionBackupAttestation = z.infer<typeof adminProductionBackupAttestationSchema>;
export type AdminProductionBackupAttestationResponse = z.infer<typeof adminProductionBackupAttestationResponseSchema>;
