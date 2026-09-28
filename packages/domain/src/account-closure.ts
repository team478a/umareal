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

export type AccountClosureEligibilityResponse = z.infer<typeof accountClosureEligibilityResponseSchema>;
export type AccountClosureCompletionResponse = z.infer<typeof accountClosureCompletionResponseSchema>;
