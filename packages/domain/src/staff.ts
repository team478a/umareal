import { z } from 'zod';

export const managedStaffRoles = ['MEMBER', 'EXPERT', 'EDITOR', 'OPERATOR'] as const;
export type ManagedStaffRole = typeof managedStaffRoles[number];

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
