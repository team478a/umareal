import { z } from 'zod';

export const supportCategories = ['ACCOUNT', 'NOTIFICATION', 'CONTENT', 'TECHNICAL', 'SERVICE', 'OTHER'] as const;
export const supportStatuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const;
export const supportPriorities = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

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
