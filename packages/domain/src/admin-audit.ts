import { z } from 'zod';

function isCalendarDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate, '実在する日付を指定してください。');
const filterSchema = z.string().trim().min(1).max(100).optional();

export const adminAuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  action: filterSchema,
  targetType: filterSchema,
  requestId: z.string().trim().min(1).max(200).optional()
}).strict().superRefine((value, context) => {
  if (!value.from || !value.to) return;
  const from = Date.parse(`${value.from}T00:00:00+09:00`);
  const to = Date.parse(`${value.to}T00:00:00+09:00`);
  if (from > to) context.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '終了日は開始日以降にしてください。' });
  if (to - from > 92 * 86_400_000) context.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: '期間は93日以内で指定してください。' });
});

const dateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminAuditResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    action: z.string().min(1),
    targetType: z.string().min(1),
    targetId: z.string(),
    reason: z.string(),
    actorRole: z.string().nullable(),
    actorDisplayName: z.string().nullable(),
    createdAt: dateTimeSchema,
    requestId: z.string()
  }).strict()),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(50),
  filters: z.object({
    from: dateSchema.nullable(),
    to: dateSchema.nullable(),
    action: z.string().nullable(),
    targetType: z.string().nullable(),
    requestId: z.string().nullable()
  }).strict()
}).strict();

export type AdminAuditQuery = z.infer<typeof adminAuditQuerySchema>;
export type AdminAuditResponse = z.infer<typeof adminAuditResponseSchema>;
