import { describe, expect, it } from 'vitest';
import { adminContinuityResponseSchema } from './admin-continuity';

describe('administrator continuity response contract', () => {
  const response = {
    provider: 'SUPABASE' as const,
    counts: { administrators: 2, suspendedAdministrators: 1, primaryReady: 2, backupReady: 2 },
    ready: true,
    administrators: [{
      id: '11111111-1111-4111-8111-111111111111',
      displayName: '管理者',
      email: 'admin@example.test',
      registrationMethod: 'EMAIL',
      disabledAt: null,
      createdAt: new Date('2026-09-29T00:00:00.000Z'),
      primaryMfaReady: true,
      backupMfaReady: true
    }],
    suspendedAdministrators: [{
      id: '22222222-2222-4222-8222-222222222222',
      displayName: '停止中管理者',
      email: 'suspended@example.test',
      registrationMethod: 'EMAIL',
      disabledAt: new Date('2026-09-29T01:00:00.000Z'),
      createdAt: new Date('2026-09-28T00:00:00.000Z'),
      primaryMfaReady: true,
      backupMfaReady: false
    }],
    candidates: [{
      id: '33333333-3333-4333-8333-333333333333',
      displayName: '候補者',
      email: 'candidate@example.test',
      role: 'OPERATOR' as const,
      registrationMethod: 'LINE',
      createdAt: new Date('2026-09-29T02:00:00.000Z')
    }],
    policy: { minimumAdministrators: 2 as const, backupFactorPerAdministrator: true as const, customRecoveryCodes: false as const }
  };

  it('preserves the existing continuity status response', () => {
    const parsed = adminContinuityResponseSchema.parse(response);
    expect(parsed.administrators[0].createdAt).toBe('2026-09-29T00:00:00.000Z');
    expect(parsed.suspendedAdministrators[0].disabledAt).toBe('2026-09-29T01:00:00.000Z');
    expect(parsed.candidates[0].createdAt).toBe('2026-09-29T02:00:00.000Z');
  });

  it('rejects authentication secrets, provider identifiers and audit details', () => {
    for (const privateField of ['passwordHash', 'authSubject', 'mfaSecret', 'externalMfaFactorId', 'externalBackupMfaFactorId']) {
      expect(adminContinuityResponseSchema.safeParse({
        ...response,
        administrators: [{ ...response.administrators[0], [privateField]: 'private' }]
      }).success).toBe(false);
    }
    expect(adminContinuityResponseSchema.safeParse({ ...response, auditLogs: [] }).success).toBe(false);
  });

  it('only accepts non-administrator promotion candidates', () => {
    expect(adminContinuityResponseSchema.safeParse({
      ...response,
      candidates: [{ ...response.candidates[0], role: 'ADMIN' }]
    }).success).toBe(false);
  });
});
