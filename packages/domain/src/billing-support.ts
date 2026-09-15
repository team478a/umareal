import { z } from 'zod';

export const billingSupportCategories = ['REFUND', 'RECEIPT', 'PAYMENT_FAILURE', 'CANCELLATION', 'OTHER'] as const;
export const billingSupportStatuses = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const;

export const billingSupportRequestSchema = z.object({
  category: z.enum(billingSupportCategories),
  paymentTransactionId: z.string().uuid().nullable().optional(),
  message: z.string().trim().min(10).max(2000)
}).strict().superRefine((value, context) => {
  if (['REFUND', 'RECEIPT'].includes(value.category) && !value.paymentTransactionId) {
    context.addIssue({ code: 'custom', path: ['paymentTransactionId'], message: '返金または領収書の問い合わせには対象の支払いを選択してください。' });
  }
});

export const billingSupportStatusSchema = z.object({
  status: z.enum(billingSupportStatuses),
  reason: z.string().trim().min(1).max(2000)
}).strict();

export function billingSupportEventType(current: string, next: string) {
  if (!billingSupportStatuses.includes(current as (typeof billingSupportStatuses)[number]) || !billingSupportStatuses.includes(next as (typeof billingSupportStatuses)[number]) || current === next) return null;
  if (next === 'IN_PROGRESS' && current === 'OPEN') return 'IN_PROGRESS' as const;
  if (next === 'RESOLVED' && ['OPEN', 'IN_PROGRESS'].includes(current)) return 'RESOLVED' as const;
  if (next === 'OPEN' && current === 'RESOLVED') return 'REOPENED' as const;
  return null;
}
