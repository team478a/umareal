import { z } from 'zod';

const optionalValue = (max: number, lowerCase = false) => z.string().trim().min(1).max(max).transform(value => lowerCase ? value.toLowerCase() : value).optional();

export const acquisitionSchema = z.object({
  source: optionalValue(100, true),
  medium: optionalValue(100, true),
  campaign: optionalValue(160),
  content: optionalValue(160),
  term: optionalValue(160),
  landingPath: z.string().trim().min(1).max(500).regex(/^\/(?!\/)[^?#]*$/).optional(),
  referralCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional()
}).strict();

export type AcquisitionInput = z.infer<typeof acquisitionSchema>;

export const acquisitionCampaignCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).transform(value => value.toLowerCase()),
  source: z.string().trim().min(1).max(100).transform(value => value.toLowerCase()),
  medium: z.string().trim().min(1).max(100).transform(value => value.toLowerCase()),
  content: z.string().trim().min(1).max(160).optional(),
  landingPath: z.string().trim().min(1).max(500).regex(/^\/(?!\/)[^?#]*$/).default('/register'),
  referralCode: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const acquisitionReportQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

const acquisitionResponseDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminAcquisitionCampaignSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  source: z.string(),
  medium: z.string(),
  content: z.string().nullable(),
  landingPath: z.string(),
  referralCode: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: acquisitionResponseDateTimeSchema,
  registrationUrl: z.string().url()
}).strict();

export const adminAcquisitionBreakdownSchema = z.object({
  source: z.string(),
  medium: z.string().nullable(),
  campaign: z.string().nullable(),
  registered: z.number().int().nonnegative(),
  paid: z.number().int().nonnegative()
}).strict();

export const adminAcquisitionReportResponseSchema = z.object({
  days: z.number().int().min(1).max(365),
  since: acquisitionResponseDateTimeSchema,
  legacyMembers: z.number().int().nonnegative(),
  campaigns: z.array(adminAcquisitionCampaignSchema),
  breakdown: z.array(adminAcquisitionBreakdownSchema)
}).strict();

export type AdminAcquisitionCampaign = z.infer<typeof adminAcquisitionCampaignSchema>;
export type AdminAcquisitionBreakdown = z.infer<typeof adminAcquisitionBreakdownSchema>;
export type AdminAcquisitionReportResponse = z.infer<typeof adminAcquisitionReportResponseSchema>;

export const onboardingFunnelStageSchema = z.object({
  key: z.enum(['REGISTERED', 'IDENTITY_READY', 'FIRST_LOGIN', 'LINE_GUIDANCE_VIEWED', 'LINE_READY']),
  label: z.string(),
  value: z.number().int().nonnegative(),
  rateFromRegistered: z.number().nonnegative(),
  dropOffFromPrevious: z.number().int().nonnegative(),
  rateFromPrevious: z.number().nonnegative()
}).strict();

export const onboardingFunnelResponseSchema = z.object({
  days: z.number().int().min(1).max(365),
  since: acquisitionResponseDateTimeSchema,
  source: z.string().nullable(),
  sources: z.array(z.string()),
  stages: z.array(onboardingFunnelStageSchema).length(5),
  paid: z.number().int().nonnegative(),
  lineAvailable: z.boolean(),
  trackingStartsAt: acquisitionResponseDateTimeSchema.nullable(),
  generatedAt: acquisitionResponseDateTimeSchema
}).strict();

export type OnboardingFunnelStage = z.infer<typeof onboardingFunnelStageSchema>;
export type OnboardingFunnelResponse = z.infer<typeof onboardingFunnelResponseSchema>;
