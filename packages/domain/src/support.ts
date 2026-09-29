import { z } from 'zod';

export const supportCategories = ['ACCOUNT', 'NOTIFICATION', 'CONTENT', 'TECHNICAL', 'SERVICE', 'OTHER'] as const;
export const supportStatuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const;
export const supportPriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

const supportDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const memberSupportItemSchema = z.object({
  id: z.string().uuid(),
  category: z.enum(supportCategories),
  subject: z.string(),
  message: z.string(),
  status: z.enum(supportStatuses),
  createdAt: supportDateTimeSchema,
  updatedAt: supportDateTimeSchema,
  events: z.array(z.object({
    id: z.string().uuid(),
    eventType: z.string().min(1),
    actorRole: z.string().min(1),
    publicMessage: z.string(),
    occurredAt: supportDateTimeSchema
  }).strict())
}).strict();

export const memberSupportHistoryResponseSchema = z.object({
  items: z.array(memberSupportItemSchema)
}).strict();

export type MemberSupportItem = z.infer<typeof memberSupportItemSchema>;
export type MemberSupportHistoryResponse = z.infer<typeof memberSupportHistoryResponseSchema>;

export const adminSupportAssigneeSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  role: z.enum(['ADMIN', 'OPERATOR'])
}).strict();

export const adminSupportItemSchema = z.object({
  id: z.string().uuid(),
  category: z.enum(supportCategories),
  subject: z.string(),
  message: z.string(),
  status: z.enum(supportStatuses),
  priority: z.enum(supportPriorities),
  assignedToId: z.string().uuid().nullable(),
  dueAt: supportDateTimeSchema.nullable(),
  createdAt: supportDateTimeSchema,
  updatedAt: supportDateTimeSchema,
  user: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    email: z.string().email().nullable()
  }).strict(),
  assignee: adminSupportAssigneeSchema.extend({ disabledAt: supportDateTimeSchema.nullable() }).strict().nullable(),
  events: z.array(z.object({
    id: z.string().uuid(),
    eventType: z.string().min(1),
    actorRole: z.string().min(1),
    reason: z.string(),
    publicMessage: z.string().nullable(),
    occurredAt: supportDateTimeSchema,
    actor: z.object({ displayName: z.string() }).strict()
  }).strict())
}).strict();

export const adminSupportListResponseSchema = z.object({
  items: z.array(adminSupportItemSchema),
  assignees: z.array(adminSupportAssigneeSchema),
  now: supportDateTimeSchema
}).strict();

export type AdminSupportItem = z.infer<typeof adminSupportItemSchema>;
export type AdminSupportAssignee = z.infer<typeof adminSupportAssigneeSchema>;
export type AdminSupportListResponse = z.infer<typeof adminSupportListResponseSchema>;

export const memberSupportCreateResponseSchema = z.object({
  id: z.string().uuid(),
  category: z.enum(supportCategories),
  subject: z.string(),
  status: z.enum(supportStatuses),
  createdAt: supportDateTimeSchema
}).strict();

export const memberSupportMessageResponseSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  status: z.enum(supportStatuses),
  reopened: z.boolean(),
  occurredAt: supportDateTimeSchema
}).strict();

export const adminSupportTriageResponseSchema = z.object({
  id: z.string().uuid(),
  priority: z.enum(supportPriorities),
  assignedToId: z.string().uuid().nullable(),
  dueAt: supportDateTimeSchema.nullable(),
  updatedAt: supportDateTimeSchema,
  assignee: adminSupportAssigneeSchema.nullable()
}).strict();

export const adminSupportStatusResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(supportStatuses),
  updatedAt: supportDateTimeSchema
}).strict();

export type MemberSupportCreateResponse = z.infer<typeof memberSupportCreateResponseSchema>;
export type MemberSupportMessageResponse = z.infer<typeof memberSupportMessageResponseSchema>;
export type AdminSupportTriageResponse = z.infer<typeof adminSupportTriageResponseSchema>;
export type AdminSupportStatusResponse = z.infer<typeof adminSupportStatusResponseSchema>;

export const supportRequestSchema = z.object({
  category: z.enum(supportCategories),
  subject: z.string().trim().min(5).max(120),
  message: z.string().trim().min(10).max(4000)
}).strict();

export const supportMessageSchema = z.object({
  message: z.string().trim().min(2).max(2000)
}).strict();

export const supportTriageSchema = z.object({
  priority: z.enum(supportPriorities),
  assignedToId: z.string().uuid().nullable(),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(1).max(2000)
}).strict();

export const supportStatusSchema = z.object({
  status: z.enum(supportStatuses),
  reason: z.string().trim().min(1).max(2000),
  publicReply: z.string().trim().max(2000).nullable().optional()
}).strict().superRefine((value, context) => {
  if (value.status === 'RESOLVED' && !value.publicReply) {
    context.addIssue({ code: 'custom', path: ['publicReply'], message: '解決済みにする場合は会員への回答を入力してください。' });
  }
  if (value.status !== 'RESOLVED' && value.publicReply) {
    context.addIssue({ code: 'custom', path: ['publicReply'], message: '会員への回答は解決時に入力してください。' });
  }
});

export function supportEventType(current: string, next: string) {
  if (!supportStatuses.includes(current as (typeof supportStatuses)[number]) || !supportStatuses.includes(next as (typeof supportStatuses)[number]) || current === next) return null;
  if (current === 'OPEN' && next === 'IN_PROGRESS') return 'IN_PROGRESS' as const;
  if (['OPEN', 'IN_PROGRESS'].includes(current) && next === 'RESOLVED') return 'RESOLVED' as const;
  if (current === 'RESOLVED' && next === 'OPEN') return 'REOPENED' as const;
  return null;
}
