import { describe, expect, it } from 'vitest';
import { administratorContinuitySatisfied, administratorDemotionSchema, administratorStatusSchema, staffAccountStatusSchema, staffResponsibilityTransferSchema, staffRoleChangeSchema } from './staff';

describe('staff role changes', () => {
  it('normalizes a verified account confirmation and accepts a different managed role', () => {
    expect(staffRoleChangeSchema.parse({
      expectedRole: 'MEMBER', nextRole: 'EXPERT', confirmationEmail: ' Staff@Example.Test ', reason: '担当開始'
    })).toMatchObject({ confirmationEmail: 'staff@example.test', reason: '担当開始' });
  });

  it('rejects administrator assignment, unchanged roles and unknown fields', () => {
    expect(staffRoleChangeSchema.safeParse({ expectedRole: 'MEMBER', nextRole: 'ADMIN', confirmationEmail: 'staff@example.test', reason: '変更' }).success).toBe(false);
    expect(staffRoleChangeSchema.safeParse({ expectedRole: 'EXPERT', nextRole: 'EXPERT', confirmationEmail: 'staff@example.test', reason: '変更' }).success).toBe(false);
    expect(staffRoleChangeSchema.safeParse({ expectedRole: 'MEMBER', nextRole: 'OPERATOR', confirmationEmail: 'staff@example.test', reason: '変更', role: 'ADMIN' }).success).toBe(false);
  });

  it('requires a destination expert, expected dependency counts and a reason for transfer', () => {
    expect(staffResponsibilityTransferSchema.parse({
      nextExpertId: '11111111-1111-4111-8111-111111111111', expectedUpcomingRaceAssignments: 2, expectedActiveWin5Products: 1,
      confirmationEmail: ' Source@Example.Test ', reason: '担当交代'
    })).toMatchObject({ expectedUpcomingRaceAssignments: 2, expectedActiveWin5Products: 1, confirmationEmail: 'source@example.test' });
    expect(staffResponsibilityTransferSchema.safeParse({
      nextExpertId: '11111111-1111-4111-8111-111111111111', expectedUpcomingRaceAssignments: -1, expectedActiveWin5Products: 0,
      confirmationEmail: 'source@example.test', reason: '担当交代'
    }).success).toBe(false);
  });

  it('accepts explicit suspend and restore actions without client-owned state fields', () => {
    expect(staffAccountStatusSchema.parse({ action: 'SUSPEND', expectedRole: 'OPERATOR', confirmationEmail: ' Ops@Example.Test ', reason: '業務終了' })).toMatchObject({ confirmationEmail: 'ops@example.test' });
    expect(staffAccountStatusSchema.safeParse({ action: 'RESTORE', expectedRole: 'ADMIN', confirmationEmail: 'admin@example.test', reason: '復帰' }).success).toBe(false);
    expect(staffAccountStatusSchema.safeParse({ action: 'RESTORE', expectedRole: 'EDITOR', confirmationEmail: 'editor@example.test', reason: '復帰', disabledAt: null }).success).toBe(false);
  });

  it('preserves at least two production administrators with primary and backup MFA', () => {
    expect(administratorContinuitySatisfied({ provider: 'LOCAL_DEVELOPMENT', remaining: [{ primaryMfaReady: false, backupMfaReady: false }, { primaryMfaReady: false, backupMfaReady: false }] })).toBe(true);
    expect(administratorContinuitySatisfied({ provider: 'SUPABASE', remaining: [{ primaryMfaReady: true, backupMfaReady: true }, { primaryMfaReady: true, backupMfaReady: true }] })).toBe(true);
    expect(administratorContinuitySatisfied({ provider: 'SUPABASE', remaining: [{ primaryMfaReady: true, backupMfaReady: true }, { primaryMfaReady: true, backupMfaReady: false }, { primaryMfaReady: false, backupMfaReady: true }] })).toBe(false);
    expect(administratorContinuitySatisfied({ provider: 'LOCAL_DEVELOPMENT', remaining: [{ primaryMfaReady: true, backupMfaReady: false }] })).toBe(false);
  });

  it('validates administrator status and demotion confirmation payloads', () => {
    expect(administratorStatusSchema.parse({ action: 'SUSPEND', confirmationEmail: ' Admin@Example.Test ', reason: '離任' }).confirmationEmail).toBe('admin@example.test');
    expect(administratorDemotionSchema.parse({ nextRole: 'OPERATOR', confirmationEmail: 'admin@example.test', reason: '運営担当へ変更' }).nextRole).toBe('OPERATOR');
    expect(administratorDemotionSchema.safeParse({ nextRole: 'ADMIN', confirmationEmail: 'admin@example.test', reason: '変更' }).success).toBe(false);
  });
});
