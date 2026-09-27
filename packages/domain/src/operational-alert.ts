import { z } from 'zod';

const operationalAlertDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

const destinationEmail = z.string().trim().email().max(254).transform(value => value.toLowerCase());
export const operationalAlertSettingsSchema = z.object({
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  minimumSeverity: z.enum(['CRITICAL', 'WARNING']),
  destinationEmails: z.array(destinationEmail).max(10),
  reason: z.string().trim().min(1).max(500)
}).strict().superRefine((value, context) => {
  if (new Set(value.destinationEmails).size !== value.destinationEmails.length) context.addIssue({ code: 'custom', path: ['destinationEmails'], message: '同じ通知先を重複して登録できません。' });
  if (value.enabled && !value.destinationEmails.length) context.addIssue({ code: 'custom', path: ['destinationEmails'], message: '外部通知を有効にする場合は通知先が必要です。' });
});

export const adminOperationalAlertSettingsResponseSchema = z.object({
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  minimumSeverity: z.enum(['CRITICAL', 'WARNING']),
  destinationEmails: z.array(z.string().email().max(254)).max(10),
  updatedAt: operationalAlertDateTimeSchema
}).strict();

export const operationalAlertActionSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const operationalAlertListSchema = z.object({ status: z.enum(['ALL', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED']).default('ALL') }).strict();

export const adminOperationalAlertDeliverySchema = z.object({
  id: z.string().uuid(),
  recipient: z.string().min(1),
  status: z.enum(['QUEUED', 'SENDING', 'SENT', 'FAILED']),
  attemptCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().nullable(),
  sentAt: operationalAlertDateTimeSchema.nullable(),
  createdAt: operationalAlertDateTimeSchema
}).strict();

export const adminOperationalAlertSchema = z.object({
  id: z.string().uuid(),
  dedupeKey: z.string().min(1),
  code: z.string().min(1),
  severity: z.enum(['CRITICAL', 'WARNING']),
  sourceType: z.string().min(1),
  sourceId: z.string().uuid(),
  title: z.string(),
  summary: z.string(),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']),
  detectedAt: operationalAlertDateTimeSchema,
  lastObservedAt: operationalAlertDateTimeSchema,
  acknowledgedAt: operationalAlertDateTimeSchema.nullable(),
  acknowledgedBy: z.string().uuid().nullable(),
  acknowledgeReason: z.string().nullable(),
  resolvedAt: operationalAlertDateTimeSchema.nullable(),
  resolvedBy: z.string().uuid().nullable(),
  resolutionReason: z.string().nullable(),
  deliveries: z.array(adminOperationalAlertDeliverySchema)
}).strict();

export const adminOperationalAlertListResponseSchema = z.object({
  items: z.array(adminOperationalAlertSchema),
  counts: z.object({
    open: z.number().int().nonnegative(),
    acknowledged: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative()
  }).strict()
}).strict();

export type AdminOperationalAlert = z.infer<typeof adminOperationalAlertSchema>;
export type AdminOperationalAlertDelivery = z.infer<typeof adminOperationalAlertDeliverySchema>;
export type AdminOperationalAlertListResponse = z.infer<typeof adminOperationalAlertListResponseSchema>;
export type AdminOperationalAlertSettingsResponse = z.infer<typeof adminOperationalAlertSettingsResponseSchema>;
