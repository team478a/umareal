import { z } from 'zod';

export const publicationKinds = ['RACE_ANNOUNCEMENT', 'FREE_REPORT_PRE_RACE'] as const;

export const publicationScheduleSchema = z.object({
  raceId: z.string().uuid(),
  kind: z.enum(publicationKinds),
  draftRevision: z.number().int().positive().nullable(),
  scheduledAt: z.string().datetime({ offset: true }).transform(value => new Date(value)),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const publicationScheduleCancelSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const publicationScheduleDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

const publicationScheduleRecordSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(publicationKinds),
  draftRevision: z.number().int().positive().nullable(),
  scheduledAt: publicationScheduleDateTimeSchema,
  status: z.enum(['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'CANCELLED']),
  reason: z.string(),
  createdAt: publicationScheduleDateTimeSchema,
  processedAt: publicationScheduleDateTimeSchema.nullable(),
  errorCode: z.string().nullable(),
  publishedTargetId: z.string().uuid().nullable()
}).strict();

const publicationDeliveryChannelResultSchema = z.object({
  expandedAt: publicationScheduleDateTimeSchema.nullable(),
  total: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  sending: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative()
}).strict();

const publicationDeliveryResultBase = {
  eventId: z.string().uuid(),
  version: z.number().int().positive(),
  publishedAt: publicationScheduleDateTimeSchema,
  eventStatus: z.string().min(1),
  line: publicationDeliveryChannelResultSchema,
  email: publicationDeliveryChannelResultSchema
} as const;

const publicationDeliveryResultSchema = z.discriminatedUnion('contentType', [
  z.object({ ...publicationDeliveryResultBase, contentType: z.literal('RACE_ANNOUNCEMENT'), label: z.literal('対象レース告知') }).strict(),
  z.object({ ...publicationDeliveryResultBase, contentType: z.literal('FREE_REPORT_PRE_RACE'), label: z.literal('無料パドック速報') }).strict(),
  z.object({ ...publicationDeliveryResultBase, contentType: z.literal('FREE_REPORT_POST_RACE_REVIEW'), label: z.literal('レース後検証') }).strict()
]);

export const publicationScheduleListResponseSchema = z.object({
  generatedAt: publicationScheduleDateTimeSchema,
  items: z.array(z.object({
    id: z.string().uuid(),
    raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    venue: z.string(),
    number: z.number().int(),
    name: z.string(),
    startsAt: publicationScheduleDateTimeSchema,
    status: z.string().min(1),
    announcements: z.array(z.object({ version: z.number().int().positive(), publishedAt: publicationScheduleDateTimeSchema }).strict()),
    freeReportDraft: z.object({ revision: z.number().int().positive(), updatedAt: publicationScheduleDateTimeSchema }).strict().nullable(),
    freeReportVersions: z.array(z.object({ version: z.number().int().positive(), publishedAt: publicationScheduleDateTimeSchema }).strict()),
    publicationSchedules: z.array(publicationScheduleRecordSchema),
    deliveryResults: z.array(publicationDeliveryResultSchema),
    warnings: z.array(z.string())
  }).strict()),
  alerts: z.number().int().nonnegative(),
  failedDeliveries: z.number().int().nonnegative()
}).strict();

export type PublicationScheduleListResponse = z.infer<typeof publicationScheduleListResponseSchema>;
