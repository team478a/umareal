import { z } from 'zod';

export const notificationStatuses = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export const notificationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(notificationStatuses).optional(),
  channel: z.enum(['LINE', 'EMAIL']).optional(),
  raceId: z.string().uuid().optional()
});
export const notificationRetrySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const notificationTestSendSchema = z.object({
  raceId: z.string().uuid(),
  contentType: z.enum(['RACE_ANNOUNCEMENT', 'FREE_REPORT_PRE_RACE', 'FREE_REPORT_POST_RACE_REVIEW']),
  draftRevision: z.number().int().positive().optional(),
  channel: z.enum(['LINE', 'EMAIL']),
  reason: z.string().trim().min(1).max(500)
}).strict().superRefine((value, context) => {
  if (value.contentType !== 'RACE_ANNOUNCEMENT' && !value.draftRevision) context.addIssue({ code: z.ZodIssueCode.custom, path: ['draftRevision'], message: '無料情報の下書きrevisionが必要です。' });
  if (value.contentType === 'RACE_ANNOUNCEMENT' && value.draftRevision !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['draftRevision'], message: '対象レース告知に下書きrevisionは指定できません。' });
});

export function retryDelayMs(baseDelaySeconds: number, completedAttempts: number) {
  return Math.min(baseDelaySeconds * 2 ** Math.max(0, completedAttempts - 1), 86_400) * 1000;
}

export function notificationIdempotencyKey(input: { eventType: string; targetId: string; recipientId: string; version: number; channel?: 'LINE' | 'EMAIL' }) {
  return `${input.channel ?? 'LINE'}:${input.eventType}:${input.targetId}:${input.recipientId}:v${input.version}`;
}
