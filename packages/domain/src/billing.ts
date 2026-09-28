import { z } from 'zod';
import { billingSupportCategories, billingSupportStatuses } from './billing-support';
import { dateSchema } from './races';

export const subscriptionPlans = ['FOUNDER', 'STANDARD'] as const;
export const billingPlanCodes = ['FOUNDER', 'STANDARD', 'DAY_PASS'] as const;
export const billingCouponCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{3,31}$/);
export const subscriptionCheckoutSchema = z.object({ planCode: z.enum(subscriptionPlans), couponCode: billingCouponCodeSchema.optional() }).strict();
const httpsUrlSchema = z.string().url().refine(value => new URL(value).protocol === 'https:', 'HTTPS URLを指定してください。');
const stripeReceiptUrlSchema = httpsUrlSchema.refine(value => {
  const hostname = new URL(value).hostname;
  return hostname === 'stripe.com' || hostname.endsWith('.stripe.com');
}, 'Stripeの領収書URLを指定してください。');
const stripePortalUrlSchema = httpsUrlSchema.refine(value => {
  const hostname = new URL(value).hostname;
  return hostname === 'billing.stripe.com' || hostname.endsWith('.billing.stripe.com');
}, 'Stripeの請求管理URLを指定してください。');
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
const stripeCheckoutResponseSchema = z.object({
  checkoutId: z.string().uuid(),
  checkoutUrl: httpsUrlSchema,
  status: z.string().min(1)
}).strict();
const localSubscriptionCheckoutResponseSchema = z.object({
  subscriptionId: z.string().uuid(),
  paymentId: z.string().uuid(),
  status: z.string().min(1),
  currentPeriodEndsAt: billingDateTimeSchema
}).strict();
const localDayPassCheckoutResponseSchema = z.object({
  dayPassId: z.string().uuid(),
  paymentId: z.string().uuid(),
  status: z.string().min(1),
  startsAt: billingDateTimeSchema.nullable(),
  endsAt: billingDateTimeSchema,
  waitingForPublication: z.boolean()
}).strict();
export const billingSubscriptionCheckoutResponseSchema = z.union([stripeCheckoutResponseSchema, localSubscriptionCheckoutResponseSchema]);
export const billingDayPassCheckoutResponseSchema = z.union([stripeCheckoutResponseSchema, localDayPassCheckoutResponseSchema]);
export const billingReceiptResponseSchema = z.object({ paymentId: z.string().uuid(), receiptUrl: stripeReceiptUrlSchema }).strict();
export const billingPortalResponseSchema = z.object({ portalUrl: stripePortalUrlSchema }).strict();
export type BillingSubscriptionCheckoutResponse = z.infer<typeof billingSubscriptionCheckoutResponseSchema>;
export type BillingDayPassCheckoutResponse = z.infer<typeof billingDayPassCheckoutResponseSchema>;
export type BillingReceiptResponse = z.infer<typeof billingReceiptResponseSchema>;
export type BillingPortalResponse = z.infer<typeof billingPortalResponseSchema>;
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
const adminBillingUserSchema = z.object({
  email: z.string().email().nullable(),
  displayName: z.string()
}).strict();
const adminBillingSubscriptionSchema = memberSubscriptionSchema.extend({
  user: adminBillingUserSchema
}).strict();
const adminBillingDayPassSchema = memberDayPassSchema.extend({
  user: adminBillingUserSchema
}).strict();
const adminBillingPaymentSchema = memberPaymentSchema.extend({
  user: adminBillingUserSchema
}).strict();
const adminBillingCheckoutSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  planCode: z.string(),
  raceDate: dateSchema.nullable(),
  amountYen: z.number().int(),
  status: z.string(),
  createdAt: billingDateTimeSchema,
  expiresAt: billingDateTimeSchema,
  completedAt: billingDateTimeSchema.nullable(),
  user: adminBillingUserSchema
}).strict();
const adminStripeWebhookSchema = z.object({
  id: z.string().uuid(),
  providerEventId: z.string(),
  eventType: z.string(),
  livemode: z.boolean(),
  outcome: z.string(),
  receivedAt: billingDateTimeSchema
}).strict();
const adminBillingSupportRequestSchema = z.object({
  id: z.string().uuid(),
  category: z.enum(billingSupportCategories),
  message: z.string(),
  status: z.enum(billingSupportStatuses),
  createdAt: billingDateTimeSchema,
  updatedAt: billingDateTimeSchema,
  paymentTransaction: z.object({
    id: z.string().uuid(),
    kind: z.string(),
    status: z.string(),
    amountYen: z.number().int(),
    occurredAt: billingDateTimeSchema
  }).strict().nullable(),
  user: adminBillingUserSchema,
  events: z.array(z.object({
    id: z.string().uuid(),
    eventType: z.string(),
    actorRole: z.string(),
    reason: z.string(),
    occurredAt: billingDateTimeSchema
  }).strict())
}).strict();
const adminPendingDayPassReviewSchema = z.object({
  id: z.string().uuid(),
  raceDate: dateSchema,
  status: z.string(),
  priceYen: z.number().int().nonnegative(),
  provider: z.string(),
  endsAt: billingDateTimeSchema,
  user: adminBillingUserSchema
}).strict();
const adminReviewCheckoutSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  planCode: z.string(),
  raceDate: dateSchema.nullable(),
  amountYen: z.number().int(),
  status: z.string(),
  completedAt: billingDateTimeSchema.nullable(),
  user: adminBillingUserSchema,
  payments: z.array(z.object({
    id: z.string().uuid(),
    status: z.string(),
    occurredAt: billingDateTimeSchema
  }).strict())
}).strict();
export const adminBillingResponseSchema = z.object({
  billingTransport: z.enum(['test', 'stripe', 'disabled']),
  subscriptions: z.array(adminBillingSubscriptionSchema),
  dayPasses: z.array(adminBillingDayPassSchema),
  payments: z.array(adminBillingPaymentSchema),
  checkouts: z.array(adminBillingCheckoutSchema),
  stripeWebhooks: z.array(adminStripeWebhookSchema),
  supportRequests: z.array(adminBillingSupportRequestSchema),
  pendingDayPassReviews: z.array(adminPendingDayPassReviewSchema),
  reviewCheckouts: z.array(adminReviewCheckoutSchema)
}).strict();
export type AdminBillingResponse = z.infer<typeof adminBillingResponseSchema>;
const validDayPassDate = (value: { raceDate: string }, context: z.RefinementCtx) => {
  const parsed = new Date(`${value.raceDate}T00:00:00+09:00`);
  const roundTrip = new Date(parsed.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  if (!Number.isFinite(parsed.getTime()) || roundTrip !== value.raceDate) context.addIssue({ code: 'custom', path: ['raceDate'], message: '有効な開催日を指定してください。' });
};
export const dayPassCheckoutSchema = z.object({ raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().superRefine(validDayPassDate);
export const dayPassCheckoutWithCouponSchema = z.object({ raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), couponCode: billingCouponCodeSchema.optional() }).strict().superRefine(validDayPassDate);
export const billingReviewResolutionSchema = z.object({
  action: z.enum(['GRANT_ACCESS', 'REFUND']),
  reason: z.string().trim().min(1).max(500)
}).strict();
export const billingSettingsSchema = z.object({
  founderSalesEnabled: z.boolean(), standardSalesEnabled: z.boolean(), dayPassSalesEnabled: z.boolean(), founderPriceYen: z.number().int().min(0).max(1_000_000),
  standardPriceYen: z.number().int().min(0).max(1_000_000), dayPassPriceYen: z.number().int().min(0).max(1_000_000),
  founderSalesLimit: z.number().int().min(1).max(100_000), billingGraceDays: z.number().int().min(0).max(30)
}).strict();

export const billingCouponDiscountTypes = ['PERCENT', 'FIXED_YEN'] as const;
export const billingCouponDurations = ['ONCE', 'FOREVER'] as const;
export const billingCouponCreateSchema = z.object({
  code: billingCouponCodeSchema,
  name: z.string().trim().min(1).max(100),
  discountType: z.enum(billingCouponDiscountTypes),
  discountValue: z.number().int().min(1).max(1_000_000),
  duration: z.enum(billingCouponDurations),
  applicablePlanCodes: z.array(z.enum(billingPlanCodes)).min(1).max(3).transform(values => [...new Set(values)]),
  startsAt: billingDateTimeSchema,
  endsAt: billingDateTimeSchema,
  maxRedemptions: z.number().int().positive().max(1_000_000).nullable(),
  reason: z.string().trim().min(1).max(500)
}).strict().superRefine((value, context) => {
  if (new Date(value.endsAt) <= new Date(value.startsAt)) context.addIssue({ code: 'custom', path: ['endsAt'], message: '終了日時は開始日時より後にしてください。' });
  if (value.discountType === 'PERCENT' && value.discountValue > 100) context.addIssue({ code: 'custom', path: ['discountValue'], message: '定率割引は100%以下にしてください。' });
});
export const billingCouponDeactivateSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const billingCouponPreviewSchema = z.object({ planCode: z.enum(billingPlanCodes), couponCode: billingCouponCodeSchema }).strict();
export const billingCouponPreviewResponseSchema = z.object({
  code: billingCouponCodeSchema,
  name: z.string(),
  planCode: z.enum(billingPlanCodes),
  baseAmountYen: z.number().int().nonnegative(),
  discountAmountYen: z.number().int().positive(),
  amountYen: z.number().int().positive(),
  duration: z.enum(billingCouponDurations),
  endsAt: billingDateTimeSchema
}).strict();
export type BillingCouponPreviewResponse = z.infer<typeof billingCouponPreviewResponseSchema>;
export const adminBillingCouponSchema = z.object({
  id: z.string().uuid(), code: billingCouponCodeSchema, name: z.string(),
  discountType: z.enum(billingCouponDiscountTypes), discountValue: z.number().int().positive(), duration: z.enum(billingCouponDurations),
  applicablePlanCodes: z.array(z.enum(billingPlanCodes)), startsAt: billingDateTimeSchema, endsAt: billingDateTimeSchema,
  maxRedemptions: z.number().int().positive().nullable(), active: z.boolean(), reservedCount: z.number().int().nonnegative(), redeemedCount: z.number().int().nonnegative(),
  createdAt: billingDateTimeSchema, deactivatedAt: billingDateTimeSchema.nullable(), deactivationReason: z.string().nullable()
}).strict();
export const adminBillingCouponsResponseSchema = z.object({ items: z.array(adminBillingCouponSchema) }).strict();
export type AdminBillingCouponsResponse = z.infer<typeof adminBillingCouponsResponseSchema>;

export function addCalendarMonthUtc(input: Date) {
  const next = new Date(input);
  const day = next.getUTCDate();
  next.setUTCDate(1); next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}
