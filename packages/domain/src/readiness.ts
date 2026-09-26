import { z } from 'zod';

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

export type AdminReadinessCheck = z.infer<typeof adminReadinessCheckSchema>;
export type AdminReadinessResponse = z.infer<typeof adminReadinessResponseSchema>;
