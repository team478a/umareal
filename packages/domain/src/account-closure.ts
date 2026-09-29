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
