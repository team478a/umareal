import { z } from 'zod';

const accountClosureDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const accountClosureBlockerSchema = z.object({
  code: z.enum(['ACTIVE_SUBSCRIPTION', 'ACTIVE_DAY_PASS', 'PENDING_CHECKOUT']),
  message: z.string().min(1),
  href: z.string().startsWith('/'),
  endsAt: accountClosureDateTimeSchema
}).strict();

export const accountClosureEligibilityResponseSchema = z.object({
  eligible: z.boolean(),
  passwordRequired: z.boolean(),
  blockers: z.array(accountClosureBlockerSchema),
  retentionPolicyVersion: z.string().min(1),
  retained: z.array(z.string().min(1))
}).strict();

export const accountClosureCompletionResponseSchema = z.object({
  closedAt: accountClosureDateTimeSchema,
  alreadyClosed: z.boolean(),
  retainedHistory: z.literal(true)
}).strict();

export const retentionPolicyVersionSchema = z.string().trim().min(3).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i);
export const retentionAnonymizationScopeSchema = z.enum(['EMAIL', 'DISPLAY_NAME', 'AUTH_IDENTITY', 'LINE_IDENTITY', 'ACQUISITION_METADATA', 'NETWORK_IDENTIFIERS']);
export const retentionReRegistrationSchema = z.enum(['NEW_ACCOUNT', 'MANUAL_REVIEW']);
export const retentionDataRequestHandlingSchema = z.enum(['MANUAL_SUPPORT', 'MANUAL_LEGAL_REVIEW']);

export const adminRetentionPolicyInputSchema = z.object({
  version: retentionPolicyVersionSchema,
  identityRetentionDays: z.number().int().min(0).max(3650),
  networkIdentifierRetentionDays: z.number().int().min(0).max(3650),
  anonymizationScope: z.array(retentionAnonymizationScopeSchema).min(1).max(6).refine(value => new Set(value).size === value.length, '匿名化対象が重複しています。'),
  reRegistrationHandling: retentionReRegistrationSchema,
  dataRequestHandling: retentionDataRequestHandlingSchema,
  legalReviewReference: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const adminRetentionPolicySchema = adminRetentionPolicyInputSchema.omit({ reason: true }).extend({
  approvedAt: accountClosureDateTimeSchema,
  approvedBy: z.object({ id: z.string().uuid(), displayName: z.string().min(1) }).strict()
}).strict();

export const adminRetentionPolicyResponseSchema = z.object({
  current: adminRetentionPolicySchema.nullable(),
  dryRun: z.object({ eligibleClosures: z.number().int().nonnegative(), cutoffAt: accountClosureDateTimeSchema, oldestClosureAt: accountClosureDateTimeSchema.nullable() }).strict().nullable(),
  unmappedClosures: z.number().int().nonnegative(),
  executionEnabled: z.literal(false)
}).strict();

export const adminRetentionPreviewResponseSchema = z.object({
  generatedAt: accountClosureDateTimeSchema,
  items: z.array(z.object({
    closureId: z.string().uuid(),
    policyVersion: z.string().min(1),
    status: z.enum(['ELIGIBLE', 'NOT_DUE', 'POLICY_UNMAPPED']),
    accessRevokedAt: accountClosureDateTimeSchema,
    eligibleAt: accountClosureDateTimeSchema.nullable(),
    daysRemaining: z.number().int().nonnegative().nullable(),
    anonymizationScope: z.array(retentionAnonymizationScopeSchema),
    preservedRecords: z.array(z.string().min(1)),
    externalActionsRequired: z.array(z.enum(['SUPABASE_AUTH_REVIEW', 'LINE_PROVIDER_REVIEW'])),
    user: z.object({
      id: z.string().uuid(),
      displayName: z.string().min(1),
      email: z.string().email().nullable(),
      registrationMethod: z.string().min(1)
    }).strict()
  }).strict()),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(50),
  automaticExecution: z.literal(false)
}).strict();

export const adminAccountClosuresResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    reasonCode: z.enum(['SERVICE_NO_LONGER_NEEDED', 'PRICE', 'CONTENT', 'OTHER']),
    requestedAt: accountClosureDateTimeSchema,
    accessRevokedAt: accountClosureDateTimeSchema,
    retentionPolicyVersion: z.string().min(1),
    status: z.enum(['CLOSED', 'REVIEW_REQUIRED']),
    user: z.object({
      id: z.string().uuid(),
      displayName: z.string().min(1),
      email: z.string().email().nullable(),
      registrationMethod: z.string().min(1),
      disabledAt: accountClosureDateTimeSchema.nullable()
    }).strict()
  }).strict()),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(50)
}).strict();

export type AccountClosureEligibilityResponse = z.infer<typeof accountClosureEligibilityResponseSchema>;
export type AccountClosureCompletionResponse = z.infer<typeof accountClosureCompletionResponseSchema>;
export type AdminAccountClosuresResponse = z.infer<typeof adminAccountClosuresResponseSchema>;
export type AdminRetentionPolicyInput = z.infer<typeof adminRetentionPolicyInputSchema>;
export type AdminRetentionPolicy = z.infer<typeof adminRetentionPolicySchema>;
export type AdminRetentionPolicyResponse = z.infer<typeof adminRetentionPolicyResponseSchema>;
export type AdminRetentionPreviewResponse = z.infer<typeof adminRetentionPreviewResponseSchema>;
