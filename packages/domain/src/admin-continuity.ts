import { z } from 'zod';

const adminContinuityDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminContinuityAdministratorSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
  email: z.string().email().nullable(),
  registrationMethod: z.string().min(1),
  disabledAt: adminContinuityDateTimeSchema.nullable(),
  createdAt: adminContinuityDateTimeSchema,
  primaryMfaReady: z.boolean(),
  backupMfaReady: z.boolean()
}).strict();

export const adminContinuityCandidateSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['MEMBER', 'EXPERT', 'EDITOR', 'OPERATOR']),
  registrationMethod: z.string().min(1),
  createdAt: adminContinuityDateTimeSchema
}).strict();

export const adminContinuityResponseSchema = z.object({
  provider: z.enum(['SUPABASE', 'LOCAL_DEVELOPMENT']),
  counts: z.object({
    administrators: z.number().int().nonnegative(),
    suspendedAdministrators: z.number().int().nonnegative(),
    primaryReady: z.number().int().nonnegative(),
    backupReady: z.number().int().nonnegative()
  }).strict(),
  ready: z.boolean(),
  administrators: z.array(adminContinuityAdministratorSchema),
  suspendedAdministrators: z.array(adminContinuityAdministratorSchema),
  candidates: z.array(adminContinuityCandidateSchema),
  policy: z.object({
    minimumAdministrators: z.literal(2),
    backupFactorPerAdministrator: z.literal(true),
    customRecoveryCodes: z.literal(false)
  }).strict()
}).strict();

export type AdminContinuityAdministrator = z.infer<typeof adminContinuityAdministratorSchema>;
export type AdminContinuityResponse = z.infer<typeof adminContinuityResponseSchema>;
