import { z } from 'zod';

const incidentDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminIncidentIssueSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['CRITICAL', 'WARNING', 'INFO']),
  title: z.string(),
  detail: z.string(),
  action: z.string(),
  href: z.string()
}).strict();

export const adminIncidentResponseSchema = z.object({
  generatedAt: incidentDateTimeSchema,
  status: z.enum(['NORMAL', 'DEGRADED', 'INCIDENT']),
  counts: z.object({
    critical: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  }).strict(),
  issues: z.array(adminIncidentIssueSchema),
  publicMessage: z.string(),
  monitoring: z.object({
    failedDeliveries: z.number().int().nonnegative(),
    delayedDeliveries: z.number().int().nonnegative(),
    stuckDeliveries: z.number().int().nonnegative(),
    unmatchedWebhooks24h: z.number().int().nonnegative(),
    emailRecipientFailures24h: z.number().int().nonnegative(),
    emailProviderFailures24h: z.number().int().nonnegative(),
    lastWebhookAt: incidentDateTimeSchema.nullable(),
    lastWebhookOutcome: z.string().nullable(),
    settingsUpdatedAt: incidentDateTimeSchema,
    newPurchasesEnabled: z.boolean()
  }).strict()
}).strict();

export type AdminIncidentResponse = z.infer<typeof adminIncidentResponseSchema>;
