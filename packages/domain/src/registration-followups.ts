import { z } from 'zod';

const registrationFollowupDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

const registrationFollowupVerificationSchema = z.object({
  createdAt: registrationFollowupDateTimeSchema,
  expiresAt: registrationFollowupDateTimeSchema,
  usedAt: registrationFollowupDateTimeSchema.nullable()
}).strict();

export const adminRegistrationFollowupItemSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  email: z.string().email(),
  createdAt: registrationFollowupDateTimeSchema,
  status: z.enum(['RECENT', 'OVERDUE']),
  lastVerification: registrationFollowupVerificationSchema.nullable(),
  canResend: z.boolean(),
  resendAvailableAt: registrationFollowupDateTimeSchema.nullable()
}).strict();

export const adminRegistrationFollowupsResponseSchema = z.object({
  items: z.array(adminRegistrationFollowupItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1).max(10000),
  limit: z.number().int().min(1).max(50),
  status: z.enum(['ALL', 'RECENT', 'OVERDUE']),
  counts: z.object({
    pending: z.number().int().nonnegative(),
    recent: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative()
  }).strict(),
  resendMode: z.enum(['ADMIN_DIRECT', 'MEMBER_SELF_SERVICE']),
  selfServicePath: z.literal('/verify-email'),
  generatedAt: registrationFollowupDateTimeSchema
}).strict();

export type AdminRegistrationFollowupItem = z.infer<typeof adminRegistrationFollowupItemSchema>;
export type AdminRegistrationFollowupsResponse = z.infer<typeof adminRegistrationFollowupsResponseSchema>;
