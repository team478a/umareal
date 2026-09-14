import { z } from 'zod';

export const subscriptionPlans = ['FOUNDER', 'STANDARD'] as const;
export const subscriptionCheckoutSchema = z.object({ planCode: z.enum(subscriptionPlans) }).strict();
export const dayPassCheckoutSchema = z.object({ raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().superRefine((value, context) => {
  const parsed = new Date(`${value.raceDate}T00:00:00+09:00`);
  const roundTrip = new Date(parsed.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  if (!Number.isFinite(parsed.getTime()) || roundTrip !== value.raceDate) context.addIssue({ code: 'custom', path: ['raceDate'], message: '有効な開催日を指定してください。' });
});
export const billingSettingsSchema = z.object({
  founderSalesEnabled: z.boolean(), founderPriceYen: z.number().int().min(0).max(1_000_000),
  standardPriceYen: z.number().int().min(0).max(1_000_000), dayPassPriceYen: z.number().int().min(0).max(1_000_000),
  founderSalesLimit: z.number().int().min(1).max(100_000), billingGraceDays: z.number().int().min(0).max(30)
}).strict();

export function addCalendarMonthUtc(input: Date) {
  const next = new Date(input);
  const day = next.getUTCDate();
  next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}
