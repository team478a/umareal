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
const notificationTestBase = {
  channel: z.enum(['LINE', 'EMAIL']),
  reason: z.string().trim().min(1).max(500)
} as const;

export const notificationTestSendSchema = z.discriminatedUnion('contentType', [
  z.object({ ...notificationTestBase, contentType: z.literal('RACE_ANNOUNCEMENT'), raceId: z.string().uuid() }).strict(),
  z.object({ ...notificationTestBase, contentType: z.literal('FREE_REPORT_PRE_RACE'), raceId: z.string().uuid(), draftRevision: z.number().int().positive() }).strict(),
  z.object({ ...notificationTestBase, contentType: z.literal('FREE_REPORT_POST_RACE_REVIEW'), raceId: z.string().uuid(), draftRevision: z.number().int().positive() }).strict(),
  z.object({ ...notificationTestBase, contentType: z.literal('RACE_PREDICTION'), raceId: z.string().uuid() }).strict(),
  z.object({ ...notificationTestBase, contentType: z.literal('WIN5_PREDICTION'), productId: z.string().uuid() }).strict(),
  ...(['BILLING_PAYMENT_SUCCEEDED', 'BILLING_PAYMENT_FAILED', 'BILLING_PAYMENT_RECOVERED', 'BILLING_CANCELLATION_SCHEDULED', 'BILLING_SUBSCRIPTION_ENDED'] as const)
    .map(contentType => z.object({ ...notificationTestBase, contentType: z.literal(contentType), subscriptionId: z.string().uuid() }).strict())
]);

export function retryDelayMs(baseDelaySeconds: number, completedAttempts: number) {
  return Math.min(baseDelaySeconds * 2 ** Math.max(0, completedAttempts - 1), 86_400) * 1000;
}

export function notificationIdempotencyKey(input: { eventType: string; targetId: string; recipientId: string; version: number; channel?: 'LINE' | 'EMAIL' }) {
  return `${input.channel ?? 'LINE'}:${input.eventType}:${input.targetId}:${input.recipientId}:v${input.version}`;
}
