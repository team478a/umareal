import { z } from 'zod';

export const notificationStatuses = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export const notificationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  status: z.enum(notificationStatuses).optional(),
  channel: z.enum(['LINE', 'EMAIL']).optional(),
  raceId: z.string().uuid().optional()
});

const notificationDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);
const notificationOperationalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const adminNotificationRaceSchema = z.object({
  id: z.string().uuid(),
  raceDate: notificationOperationalDateSchema,
  venue: z.string(),
  number: z.number().int(),
  name: z.string(),
  startsAt: notificationDateTimeSchema
}).strict();
const adminNotificationProductSchema = z.object({
  id: z.string().uuid(),
  targetDate: notificationOperationalDateSchema,
  title: z.string()
}).strict();

export const memberNotificationItemSchema = z.object({
  id: z.string().uuid(),
  eventType: z.string().min(1),
  title: z.string().min(1),
  createdAt: notificationDateTimeSchema,
  publishedAt: notificationDateTimeSchema,
  version: z.number().int().positive(),
  visibility: z.enum(['FREE', 'PAID']),
  readAt: notificationDateTimeSchema.nullable(),
  href: z.string().startsWith('/'),
  race: adminNotificationRaceSchema.nullable(),
  win5: adminNotificationProductSchema.nullable(),
  paper: adminNotificationProductSchema.optional(),
  content: z.object({
    id: z.string().uuid(),
    kind: z.enum(['ARTICLE', 'VIDEO', 'AUDIO']),
    title: z.string(),
    category: z.string()
  }).strict().optional(),
  support: z.object({
    requestId: z.string().uuid(),
    subject: z.string()
  }).strict().optional(),
  billing: z.object({
    planCode: z.string().min(1),
    raceDate: notificationOperationalDateSchema.nullable()
  }).strict().optional()
}).strict().superRefine((value, context) => {
  const targetCount = Number(value.race !== null) + Number(value.win5 !== null) + Number(value.paper !== undefined) + Number(value.content !== undefined) + Number(value.support !== undefined) + Number(value.billing !== undefined);
  if (targetCount !== 1) context.addIssue({ code: z.ZodIssueCode.custom, message: 'A member notification must have exactly one public target.' });
  if (value.race && value.href !== `/races/${value.race.id}`) context.addIssue({ code: z.ZodIssueCode.custom, path: ['href'], message: 'Race notification href does not match its public target.' });
  if (value.win5 && value.href !== `/win5/${value.win5.id}`) context.addIssue({ code: z.ZodIssueCode.custom, path: ['href'], message: 'WIN5 notification href does not match its public target.' });
  if (value.paper && value.href !== `/papers/${value.paper.id}`) context.addIssue({ code: z.ZodIssueCode.custom, path: ['href'], message: 'Paper notification href does not match its public target.' });
  if (value.content && value.href !== `/content/${value.content.id}`) context.addIssue({ code: z.ZodIssueCode.custom, path: ['href'], message: 'Content notification href does not match its public target.' });
  if (value.support && (value.href !== '/support' || value.visibility !== 'FREE' || value.version !== 1)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Support notification metadata is invalid.' });
  if (value.billing && (value.href !== '/account' || value.visibility !== 'FREE' || value.version !== 1)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Billing notification metadata is invalid.' });
});

export const memberNotificationListResponseSchema = z.object({
  items: z.array(memberNotificationItemSchema),
  total: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(50)
}).strict();

export type MemberNotificationItem = z.infer<typeof memberNotificationItemSchema>;
export type MemberNotificationListResponse = z.infer<typeof memberNotificationListResponseSchema>;
const adminNotificationAttemptSchema = z.object({
  id: z.string().uuid(),
  attemptNumber: z.number().int().positive(),
  outcome: z.string().min(1),
  errorCode: z.string().nullable(),
  startedAt: notificationDateTimeSchema,
  finishedAt: notificationDateTimeSchema
}).strict();
const adminNotificationEventSchema = z.object({
  id: z.string().uuid(),
  eventType: z.string().min(1),
  status: z.string().min(1),
  createdAt: notificationDateTimeSchema,
  contentVersion: z.object({ id: z.string().uuid(), contentId: z.string().uuid(), version: z.number().int().positive(), kind: z.enum(['ARTICLE', 'VIDEO', 'AUDIO']), title: z.string(), category: z.string(), visibility: z.enum(['PUBLIC', 'MEMBERS', 'PAID']) }).strict().nullable().optional(),
  paperVersion: z.object({ id: z.string().uuid(), version: z.number().int().positive(), targetDate: notificationOperationalDateSchema, title: z.string(), paperId: z.string().uuid(), accessScope: z.enum(['MEMBERS', 'PAID']) }).strict().nullable().optional(),
  version: z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    visibility: z.enum(['FREE', 'PAID']),
    prediction: z.object({ race: adminNotificationRaceSchema }).strict()
  }).strict().nullable(),
  announcement: z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    race: adminNotificationRaceSchema
  }).strict().nullable(),
  freeReportVersion: z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    kind: z.enum(['PRE_RACE', 'POST_RACE_REVIEW']),
    race: adminNotificationRaceSchema
  }).strict().nullable(),
  productVersion: z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    accessScope: z.enum(['FREE', 'PAID']),
    product: adminNotificationProductSchema
  }).strict().nullable(),
  raceResultVersion: z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    race: adminNotificationRaceSchema
  }).strict().nullable(),
  win5EvaluationVersion: z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    product: adminNotificationProductSchema
  }).strict().nullable(),
  billingEvent: z.object({
    id: z.string().uuid(),
    eventType: z.string().min(1),
    subscription: z.object({ planCode: z.string().min(1) }).strict().nullable(),
    dayPass: z.object({ raceDate: notificationOperationalDateSchema }).strict().nullable(),
    billingCheckout: z.object({ planCode: z.string().min(1) }).strict().nullable()
  }).strict().nullable()
}).strict();
export const adminNotificationDeliverySchema = z.object({
  id: z.string().uuid(),
  status: z.enum(notificationStatuses),
  channel: z.enum(['LINE', 'EMAIL']),
  attemptCount: z.number().int().nonnegative(),
  manualRetryCount: z.number().int().nonnegative(),
  nextAttemptAt: notificationDateTimeSchema,
  lastErrorCode: z.string().nullable(),
  sentAt: notificationDateTimeSchema.nullable(),
  createdAt: notificationDateTimeSchema,
  updatedAt: notificationDateTimeSchema,
  user: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    email: z.string().email().nullable()
  }).strict(),
  event: adminNotificationEventSchema,
  attempts: z.array(adminNotificationAttemptSchema)
}).strict();
const adminNotificationWebhookHealthSchema = z.object({
  lastReceivedAt: notificationDateTimeSchema.nullable(),
  lastEventType: z.string().nullable(),
  lastOutcome: z.string().nullable(),
  received24h: z.number().int().nonnegative(),
  unmatched24h: z.number().int().nonnegative(),
  blockedAccounts: z.number().int().nonnegative()
}).strict();
const adminEmailWebhookEventSchema = z.object({
  id: z.string().uuid(),
  eventType: z.string().min(1),
  occurredAt: notificationDateTimeSchema,
  receivedAt: notificationDateTimeSchema,
  recipientCount: z.number().int().nonnegative(),
  matchedCount: z.number().int().nonnegative(),
  disabledCount: z.number().int().nonnegative(),
  outcome: z.string().min(1)
}).strict();
const adminBlockedEmailMemberSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email().nullable(),
  emailDeliveryDisabledAt: notificationDateTimeSchema,
  emailDeliveryDisabledReason: z.string().nullable()
}).strict();
const adminNotificationEmailWebhookHealthSchema = z.object({
  lastReceivedAt: notificationDateTimeSchema.nullable(),
  lastEventType: z.string().nullable(),
  lastOutcome: z.string().nullable(),
  received24h: z.number().int().nonnegative(),
  actionRequired24h: z.number().int().nonnegative(),
  blockedAccounts: z.number().int().nonnegative(),
  recent: z.array(adminEmailWebhookEventSchema),
  blockedMembers: z.array(adminBlockedEmailMemberSchema)
}).strict();

export const adminNotificationListResponseSchema = z.object({
  items: z.array(adminNotificationDeliverySchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  channel: z.enum(['LINE', 'EMAIL']).nullable(),
  raceId: z.string().uuid().nullable(),
  counts: z.record(z.enum(notificationStatuses), z.number().int().nonnegative()),
  webhook: adminNotificationWebhookHealthSchema,
  emailWebhook: adminNotificationEmailWebhookHealthSchema
}).strict();

export type AdminNotificationDelivery = z.infer<typeof adminNotificationDeliverySchema>;
export type AdminNotificationListResponse = z.infer<typeof adminNotificationListResponseSchema>;

export const adminNotificationTestOptionsResponseSchema = z.object({
  channels: z.object({
    email: z.boolean(),
    line: z.boolean()
  }).strict(),
  races: z.array(z.object({
    id: z.string().uuid(),
    raceDate: notificationOperationalDateSchema,
    venue: z.string(),
    number: z.number().int(),
    name: z.string()
  }).strict()),
  products: z.array(z.object({
    id: z.string().uuid(),
    targetDate: notificationOperationalDateSchema,
    title: z.string(),
    status: z.string().min(1)
  }).strict()),
  subscriptions: z.array(z.object({
    id: z.string().uuid(),
    planCode: z.string().min(1),
    status: z.string().min(1),
    currentPeriodEndsAt: notificationDateTimeSchema,
    user: z.object({ displayName: z.string() }).strict()
  }).strict())
}).strict();

export type AdminNotificationTestOptionsResponse = z.infer<typeof adminNotificationTestOptionsResponseSchema>;

const notificationPreviewChannelSchema = z.object({
  enabled: z.boolean(),
  eligibleRecipients: z.number().int().nonnegative(),
  scheduledDeliveries: z.number().int().nonnegative()
}).strict();

export const raceAnnouncementNotificationPreviewResponseSchema = z.object({
  eventType: z.literal('RACE_ANNOUNCED'),
  contentLabel: z.literal('対象レース告知'),
  generatedAt: notificationDateTimeSchema,
  plannedAt: notificationDateTimeSchema,
  timing: z.enum(['IMMEDIATE', 'SCHEDULED']),
  version: z.number().int().positive(),
  race: adminNotificationRaceSchema,
  audience: z.object({
    uniqueMembers: z.number().int().nonnegative(),
    totalDeliveries: z.number().int().nonnegative(),
    duplicateChannelMembers: z.number().int().nonnegative(),
    line: notificationPreviewChannelSchema,
    email: notificationPreviewChannelSchema
  }).strict(),
  message: z.object({
    type: z.literal('text'),
    text: z.string()
  }).strict()
}).strict();

export type RaceAnnouncementNotificationPreviewResponse = z.infer<typeof raceAnnouncementNotificationPreviewResponseSchema>;

const freeReportNotificationPreviewBase = {
  draftRevision: z.number().int().positive(),
  generatedAt: notificationDateTimeSchema,
  plannedAt: notificationDateTimeSchema,
  timing: z.enum(['IMMEDIATE', 'SCHEDULED']),
  version: z.number().int().positive(),
  race: adminNotificationRaceSchema,
  audience: z.object({
    uniqueMembers: z.number().int().nonnegative(),
    totalDeliveries: z.number().int().nonnegative(),
    duplicateChannelMembers: z.number().int().nonnegative(),
    line: notificationPreviewChannelSchema,
    email: notificationPreviewChannelSchema
  }).strict(),
  message: z.object({
    type: z.literal('text'),
    text: z.string()
  }).strict()
} as const;

export const freeReportNotificationPreviewResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    ...freeReportNotificationPreviewBase,
    eventType: z.literal('FREE_REPORT_PUBLISHED'),
    contentLabel: z.literal('無料パドック速報'),
    kind: z.literal('PRE_RACE')
  }).strict(),
  z.object({
    ...freeReportNotificationPreviewBase,
    eventType: z.literal('FREE_REPORT_REVIEW_PUBLISHED'),
    contentLabel: z.literal('レース後検証'),
    kind: z.literal('POST_RACE_REVIEW')
  }).strict()
]);

export type FreeReportNotificationPreviewResponse = z.infer<typeof freeReportNotificationPreviewResponseSchema>;
export const notificationRetrySchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const notificationTestBase = {
  channel: z.enum(['LINE', 'EMAIL']),
  reason: z.string().trim().min(1).max(500)
} as const;

export const notificationTestSendSchema = z.discriminatedUnion('contentType', [
  z.object({ ...notificationTestBase, contentType: z.literal('CONNECTION_CHECK') }).strict(),
  z.object({ ...notificationTestBase, contentType: z.literal('RACE_ANNOUNCEMENT'), raceId: z.string().uuid() }).strict(),
  z.object({ ...notificationTestBase, contentType: z.literal('FREE_REPORT_PRE_RACE'), raceId: z.string().uuid(), draftRevision: z.number().int().positive() }).strict(),
  z.object({ ...notificationTestBase, contentType: z.literal('FREE_REPORT_POST_RACE_REVIEW'), raceId: z.string().uuid(), draftRevision: z.number().int().positive() }).strict(),
  z.object({ ...notificationTestBase, contentType: z.literal('RACE_PREDICTION'), raceId: z.string().uuid() }).strict(),
  z.object({ ...notificationTestBase, contentType: z.literal('WIN5_PREDICTION'), productId: z.string().uuid() }).strict(),
  ...(['BILLING_PAYMENT_SUCCEEDED', 'BILLING_PAYMENT_FAILED', 'BILLING_PAYMENT_RECOVERED', 'BILLING_CANCELLATION_SCHEDULED', 'BILLING_SUBSCRIPTION_ENDED'] as const)
    .map(contentType => z.object({ ...notificationTestBase, contentType: z.literal(contentType), subscriptionId: z.string().uuid() }).strict())
]);

export type NotificationTestSendRequest = z.infer<typeof notificationTestSendSchema>;

export const notificationTestSendResponseSchema = z.object({
  status: z.enum(['SIMULATED', 'SENT']),
  channel: z.enum(['LINE', 'EMAIL']),
  transport: z.enum(['TEST_ONLY', 'LINE', 'RESEND']),
  contentLabel: z.string().min(1),
  version: z.number().int().positive(),
  sentAt: notificationDateTimeSchema
}).strict();

export type NotificationTestSendResponse = z.infer<typeof notificationTestSendResponseSchema>;

export function retryDelayMs(baseDelaySeconds: number, completedAttempts: number) {
  return Math.min(baseDelaySeconds * 2 ** Math.max(0, completedAttempts - 1), 86_400) * 1000;
}

export function notificationIdempotencyKey(input: { eventType: string; targetId: string; recipientId: string; version: number; channel?: 'LINE' | 'EMAIL' }) {
  return `${input.channel ?? 'LINE'}:${input.eventType}:${input.targetId}:${input.recipientId}:v${input.version}`;
}
