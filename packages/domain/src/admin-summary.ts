import { z } from 'zod';
import { adminAcquisitionBreakdownSchema } from './acquisition';
import { adminSettingsOperationsSchema } from './admin-settings';

const adminSummaryDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminSummaryFunnelCountsSchema = z.object({
  registered: z.number().int().nonnegative(),
  identityReady: z.number().int().nonnegative(),
  lineReady: z.number().int().nonnegative(),
  planViewed: z.number().int().nonnegative(),
  checkoutReviewed: z.number().int().nonnegative(),
  paid: z.number().int().nonnegative()
}).strict();

export const adminSummaryResponseSchema = z.object({
  members: z.number().int().nonnegative(),
  entitled: z.number().int().nonnegative(),
  races: z.number().int().nonnegative(),
  auditCount: z.number().int().nonnegative(),
  queuedNotifications: z.number().int().nonnegative(),
  racesNeedingPrediction: z.number().int().nonnegative(),
  resultsPending: z.number().int().nonnegative(),
  operations: adminSettingsOperationsSchema.nullable(),
  funnel: z.object({
    all: adminSummaryFunnelCountsSchema,
    last30Days: adminSummaryFunnelCountsSchema.extend({ cohortStartsAt: adminSummaryDateTimeSchema }).strict(),
    trackingStartsAt: adminSummaryDateTimeSchema.nullable()
  }).strict(),
  acquisition: z.object({
    last30Days: z.array(adminAcquisitionBreakdownSchema).max(20),
    cohortStartsAt: adminSummaryDateTimeSchema,
    legacyMembers: z.number().int().nonnegative()
  }).strict()
}).strict();

export type AdminSummaryResponse = z.infer<typeof adminSummaryResponseSchema>;
