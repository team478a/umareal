import { z } from 'zod';

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

export const operationalAlertActionSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const operationalAlertListSchema = z.object({ status: z.enum(['ALL', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED']).default('ALL') }).strict();
