import { z } from 'zod';
import { billingSupportCategories, billingSupportStatuses } from './billing-support';
import { dateSchema } from './races';

export const subscriptionPlans = ['FOUNDER', 'STANDARD'] as const;
export const subscriptionCheckoutSchema = z.object({ planCode: z.enum(subscriptionPlans) }).strict();
const founderBillingPlanSchema = z.object({
  code: z.literal('FOUNDER'),
  name: z.literal('創設会員'),
  priceYen: z.number().int().nonnegative(),
  interval: z.literal('MONTH'),
  available: z.boolean(),
  remaining: z.number().int().nonnegative()
}).strict();
const standardBillingPlanSchema = z.object({
  code: z.literal('STANDARD'),
  name: z.literal('通常会員'),
  priceYen: z.number().int().nonnegative(),
  interval: z.literal('MONTH'),
  available: z.boolean()
}).strict();
const dayPassBillingPlanSchema = z.object({
  code: z.literal('DAY_PASS'),
  name: z.literal('1日利用'),
  priceYen: z.number().int().nonnegative(),
  interval: z.literal('JST_DAY'),
  available: z.boolean()
}).strict();
export const billingPlansResponseSchema = z.object({
  newPurchasesEnabled: z.boolean(),
  developmentTerms: z.literal(true),
  billingTransport: z.enum(['test', 'stripe', 'disabled']),
  stripeMode: z.enum(['TEST', 'LIVE']).nullable(),
  currency: z.literal('JPY'),
  taxIncluded: z.literal(true),
  plans: z.tuple([founderBillingPlanSchema, standardBillingPlanSchema, dayPassBillingPlanSchema])
}).strict();
export type BillingPlansResponse = z.infer<typeof billingPlansResponseSchema>;
const billingDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);
const memberSubscriptionSchema = z.object({
  id: z.string().uuid(),
  planCode: z.string(),
  status: z.string(),
  priceYen: z.number().int().nonnegative(),
  currentPeriodEndsAt: billingDateTimeSchema,
  graceEndsAt: billingDateTimeSchema.nullable(),
  cancelAtPeriodEnd: z.boolean()
}).strict();
const memberDayPassSchema = z.object({
  id: z.string().uuid(),
  raceDate: dateSchema,
  status: z.string(),
  priceYen: z.number().int().nonnegative()
}).strict();
const memberPaymentSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  kind: z.string(),
  status: z.string(),
  amountYen: z.number().int(),
  occurredAt: billingDateTimeSchema
}).strict();
const memberBillingSupportEventSchema = z.object({
  eventType: z.string(),
  occurredAt: billingDateTimeSchema
}).strict();
const memberBillingSupportRequestSchema = z.object({
  id: z.string().uuid(),
  paymentTransactionId: z.string().uuid().nullable(),
  category: z.enum(billingSupportCategories),
  message: z.string(),
  status: z.enum(billingSupportStatuses),
  createdAt: billingDateTimeSchema,
  updatedAt: billingDateTimeSchema,
  events: z.array(memberBillingSupportEventSchema)
}).strict();
export const memberBillingResponseSchema = z.object({
  subscriptions: z.array(memberSubscriptionSchema),
  dayPasses: z.array(memberDayPassSchema),
  payments: z.array(memberPaymentSchema),
  supportRequests: z.array(memberBillingSupportRequestSchema),
  customerPortalAvailable: z.boolean()
}).strict();
export type MemberBillingResponse = z.infer<typeof memberBillingResponseSchema>;
export const dayPassCheckoutSchema = z.object({ raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().superRefine((value, context) => {
  const parsed = new Date(`${value.raceDate}T00:00:00+09:00`);
  const roundTrip = new Date(parsed.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  if (!Number.isFinite(parsed.getTime()) || roundTrip !== value.raceDate) context.addIssue({ code: 'custom', path: ['raceDate'], message: '有効な開催日を指定してください。' });
});
export const billingReviewResolutionSchema = z.object({
  action: z.enum(['GRANT_ACCESS', 'REFUND']),
  reason: z.string().trim().min(1).max(500)
}).strict();
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
