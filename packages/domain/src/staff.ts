import { z } from 'zod';

export const managedStaffRoles = ['MEMBER', 'EXPERT', 'EDITOR', 'OPERATOR'] as const;
export type ManagedStaffRole = typeof managedStaffRoles[number];

const staffResponseDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminStaffAccountSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
  email: z.string().email(),
  role: z.enum(managedStaffRoles),
  registrationMethod: z.string().min(1),
  disabledAt: staffResponseDateTimeSchema.nullable(),
  createdAt: staffResponseDateTimeSchema,
  dependencies: z.object({
    upcomingRaceAssignments: z.number().int().nonnegative(),
    activeWin5Products: z.number().int().nonnegative(),
    pendingPublicationSchedules: z.number().int().nonnegative(),
    pendingContentSchedules: z.number().int().nonnegative()
  }).strict()
}).strict();

export const adminStaffListResponseSchema = z.object({
  accounts: z.array(adminStaffAccountSchema),
  roles: z.array(z.object({
    role: z.enum(managedStaffRoles),
    mfaRequired: z.boolean(),
    win5MfaRequired: z.boolean(),
    reserved: z.boolean()
  }).strict()),
  policy: z.object({
    administratorChangesManagedSeparately: z.literal(true),
    verifiedEmailRequired: z.literal(true),
    reasonRequired: z.literal(true),
    sessionsRevoked: z.literal(true),
    expertDependenciesProtected: z.literal(true)
  }).strict()
}).strict();

export type AdminStaffAccount = z.infer<typeof adminStaffAccountSchema>;
export type AdminStaffListResponse = z.infer<typeof adminStaffListResponseSchema>;

export const staffRoleChangeResponseSchema = z.object({
  userId: z.string().uuid(),
  previousRole: z.enum(managedStaffRoles),
  nextRole: z.enum(managedStaffRoles),
  localSessionsRevoked: z.number().int().nonnegative(),
  mfaEnrollmentRequired: z.boolean(),
  win5MfaRequired: z.boolean()
}).strict();

const staffOperationalRoleSchema = z.enum(['EXPERT', 'EDITOR', 'OPERATOR']);

export const staffAccountStatusResponseSchema = z.discriminatedUnion('status', [
  z.object({
    userId: z.string().uuid(),
    role: staffOperationalRoleSchema,
    status: z.literal('ACTIVE'),
    localSessionsRevoked: z.number().int().nonnegative()
  }).strict(),
  z.object({
    userId: z.string().uuid(),
    role: staffOperationalRoleSchema,
    status: z.literal('SUSPENDED'),
    suspendedAt: staffResponseDateTimeSchema,
    localSessionsRevoked: z.number().int().nonnegative()
  }).strict()
]);

export const staffResponsibilityTransferResponseSchema = z.object({
  sourceExpertId: z.string().uuid(),
  nextExpert: z.object({
    id: z.string().uuid(),
    displayName: z.string().min(1)
  }).strict(),
  upcomingRaceAssignments: z.number().int().nonnegative(),
  activeWin5Products: z.number().int().nonnegative()
}).strict();

export type StaffRoleChangeResponse = z.infer<typeof staffRoleChangeResponseSchema>;
export type StaffAccountStatusResponse = z.infer<typeof staffAccountStatusResponseSchema>;
export type StaffResponsibilityTransferResponse = z.infer<typeof staffResponsibilityTransferResponseSchema>;

export const staffRoleChangeSchema = z.object({
  expectedRole: z.enum(managedStaffRoles),
  nextRole: z.enum(managedStaffRoles),
  confirmationEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  reason: z.string().trim().min(1).max(500)
}).strict().refine(value => value.expectedRole !== value.nextRole, {
  path: ['nextRole'],
  message: '現在と異なるロールを選択してください。'
});

export const staffResponsibilityTransferSchema = z.object({
  nextExpertId: z.string().uuid(),
  expectedUpcomingRaceAssignments: z.number().int().min(0).max(1000),
  expectedActiveWin5Products: z.number().int().min(0).max(1000),
  confirmationEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const staffAccountStatusSchema = z.object({
  action: z.enum(['SUSPEND', 'RESTORE']),
  expectedRole: z.enum(managedStaffRoles),
  confirmationEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const administratorStatusSchema = z.object({
  action: z.enum(['SUSPEND', 'RESTORE']),
  confirmationEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const administratorDemotionSchema = z.object({
  nextRole: z.enum(managedStaffRoles),
  confirmationEmail: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  reason: z.string().trim().min(1).max(500)
}).strict();

export function administratorContinuitySatisfied(input: { provider: 'SUPABASE' | 'LOCAL_DEVELOPMENT'; remaining: Array<{ primaryMfaReady: boolean; backupMfaReady: boolean }> }) {
  if (input.remaining.length < 2) return false;
  if (input.provider === 'LOCAL_DEVELOPMENT') return true;
  return input.remaining.filter(item => item.primaryMfaReady && item.backupMfaReady).length >= 2;
}
