import { describe, expect, it } from 'vitest';
import { accountClosureCompletionResponseSchema, accountClosureEligibilityResponseSchema, adminAccountClosuresResponseSchema, adminAccountRestoreInputSchema, adminAccountRestoreResponseSchema, adminRetentionPolicyInputSchema, adminRetentionPolicyResponseSchema, adminRetentionPreviewResponseSchema } from './account-closure';

const response = {
  eligible: false,
  passwordRequired: true,
  blockers: [{
    code: 'ACTIVE_SUBSCRIPTION' as const,
    message: '有効な月額契約を先に解約予約してください。',
    href: '/account',
    endsAt: new Date('2026-10-31T15:00:00.000Z')
  }],
  retentionPolicyVersion: 'development-v1',
  retained: ['支払・契約履歴', '同意履歴']
};

describe('account closure eligibility response contract', () => {
  it('preserves the existing public response and normalizes blocker timestamps', () => {
    const parsed = accountClosureEligibilityResponseSchema.parse(response);
    expect(parsed.blockers[0].endsAt).toBe('2026-10-31T15:00:00.000Z');
  });

  it('rejects billing identifiers and private authentication data', () => {
    expect(accountClosureEligibilityResponseSchema.safeParse({ ...response, userId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(accountClosureEligibilityResponseSchema.safeParse({
      ...response,
      blockers: [{ ...response.blockers[0], subscriptionId: 'internal-subscription' }]
    }).success).toBe(false);
    expect(accountClosureEligibilityResponseSchema.safeParse({ ...response, passwordHash: 'secret' }).success).toBe(false);
  });
});

describe('administrator retention policy contract', () => {
  const input = {
    version: 'privacy-2026-10', identityRetentionDays: 365, networkIdentifierRetentionDays: 90,
    anonymizationScope: ['EMAIL', 'DISPLAY_NAME', 'AUTH_IDENTITY', 'LINE_IDENTITY'],
    reRegistrationHandling: 'MANUAL_REVIEW', dataRequestHandling: 'MANUAL_LEGAL_REVIEW', legalReviewReference: 'LEGAL-42', reason: '正式方針の承認'
  };

  it('accepts an explicit complete policy and rejects duplicate or unknown scope', () => {
    expect(adminRetentionPolicyInputSchema.parse(input)).toEqual(input);
    expect(adminRetentionPolicyInputSchema.safeParse({ ...input, anonymizationScope: ['EMAIL', 'EMAIL'] }).success).toBe(false);
    expect(adminRetentionPolicyInputSchema.safeParse({ ...input, anonymizationScope: ['EMAIL', 'PASSWORD_HASH'] }).success).toBe(false);
  });

  it('keeps execution disabled in the administration response', () => {
    const response = adminRetentionPolicyResponseSchema.parse({ current: { version: input.version, identityRetentionDays: input.identityRetentionDays, networkIdentifierRetentionDays: input.networkIdentifierRetentionDays, anonymizationScope: input.anonymizationScope, reRegistrationHandling: input.reRegistrationHandling, dataRequestHandling: input.dataRequestHandling, legalReviewReference: input.legalReviewReference, approvedAt: new Date('2026-10-05T12:00:00Z'), approvedBy: { id: '11111111-1111-4111-8111-111111111111', displayName: '管理者' } }, dryRun: { eligibleClosures: 2, cutoffAt: new Date('2025-10-05T12:00:00Z'), oldestClosureAt: null }, unmappedClosures: 1, executionEnabled: false });
    expect(response.executionEnabled).toBe(false);
    expect(response.current?.approvedAt).toBe('2026-10-05T12:00:00.000Z');
  });
});

describe('administrator retention preview contract', () => {
  it('returns only the fields needed for a read-only impact review', () => {
    const parsed = adminRetentionPreviewResponseSchema.parse({ generatedAt: new Date('2026-10-06T00:00:00Z'), items: [{ closureId: '11111111-1111-4111-8111-111111111111', policyVersion: 'privacy-2026-10', status: 'ELIGIBLE', accessRevokedAt: new Date('2025-10-01T00:00:00Z'), eligibleAt: new Date('2026-10-01T00:00:00Z'), daysRemaining: 0, anonymizationScope: ['EMAIL'], preservedRecords: ['監査履歴'], externalActionsRequired: ['SUPABASE_AUTH_REVIEW'], user: { id: '22222222-2222-4222-8222-222222222222', displayName: '退会会員', email: 'closed@example.test', registrationMethod: 'EMAIL' } }], total: 1, page: 1, limit: 20, automaticExecution: false });
    expect(parsed.automaticExecution).toBe(false);
    expect(parsed.items[0].status).toBe('ELIGIBLE');
    expect(JSON.stringify(parsed)).not.toMatch(/passwordHash|authSubject|lineSubject/);
  });
});

describe('account closure completion response contract', () => {
  const completed = {
    closedAt: new Date('2026-09-29T00:00:00.000Z'),
    alreadyClosed: false,
    retainedHistory: true as const
  };

  it('preserves the existing public response and normalizes the closure timestamp', () => {
    expect(accountClosureCompletionResponseSchema.parse(completed)).toEqual({
      closedAt: '2026-09-29T00:00:00.000Z',
      alreadyClosed: false,
      retainedHistory: true
    });
  });

  it('rejects closure, user and audit identifiers', () => {
    expect(accountClosureCompletionResponseSchema.safeParse({ ...completed, closureId: 'internal-closure' }).success).toBe(false);
    expect(accountClosureCompletionResponseSchema.safeParse({ ...completed, userId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(accountClosureCompletionResponseSchema.safeParse({ ...completed, auditLogId: 'internal-audit' }).success).toBe(false);
  });
});

describe('administrator account closures response contract', () => {
  const list = {
    items: [{
      id: '11111111-1111-4111-8111-111111111111',
      reasonCode: 'PRICE' as const,
      requestedAt: new Date('2026-09-29T01:00:00.000Z'),
      accessRevokedAt: new Date('2026-09-29T01:00:01.000Z'),
      retentionPolicyVersion: 'development-v1',
      status: 'CLOSED' as const,
      user: {
        id: '22222222-2222-4222-8222-222222222222',
        displayName: '退会済み会員',
        email: 'closed@example.test',
        registrationMethod: 'EMAIL',
        disabledAt: new Date('2026-09-29T01:00:01.000Z')
      }
    }],
    total: 1,
    page: 1,
    limit: 20
  };

  it('preserves the existing paginated administration response', () => {
    const parsed = adminAccountClosuresResponseSchema.parse(list);
    expect(parsed.items[0].requestedAt).toBe('2026-09-29T01:00:00.000Z');
    expect(parsed.items[0].user.disabledAt).toBe('2026-09-29T01:00:01.000Z');
  });

  it('rejects authentication, audit and unselected database fields', () => {
    expect(adminAccountClosuresResponseSchema.safeParse({
      ...list,
      items: [{ ...list.items[0], userId: list.items[0].user.id }]
    }).success).toBe(false);
    expect(adminAccountClosuresResponseSchema.safeParse({
      ...list,
      items: [{ ...list.items[0], user: { ...list.items[0].user, passwordHash: 'secret' } }]
    }).success).toBe(false);
    expect(adminAccountClosuresResponseSchema.safeParse({ ...list, auditLog: [] }).success).toBe(false);
  });
});

describe('administrator closed-account restoration contract', () => {
  it('requires a fresh timestamp, exact display-name confirmation and a meaningful reason', () => {
    const input = { expectedDisabledAt: '2026-10-07T00:00:00.000Z', confirmation: '退会済み会員', reason: '本人確認後に元の会員だけを復旧するため' };
    expect(adminAccountRestoreInputSchema.parse(input)).toEqual(input);
    expect(adminAccountRestoreInputSchema.safeParse({ ...input, reason: '短い' }).success).toBe(false);
    expect(adminAccountRestoreInputSchema.safeParse({ ...input, referralCode: 'SHOULD_NOT_CHANGE' }).success).toBe(false);
  });

  it('makes the preserved boundaries explicit in the response', () => {
    const parsed = adminAccountRestoreResponseSchema.parse({
      closureId: '11111111-1111-4111-8111-111111111111', restoredAt: new Date('2026-10-07T01:00:00.000Z'), lineLoginRestored: true,
      notificationsRemainDisabled: true, entitlementsRestored: false, referralChanged: false
    });
    expect(parsed).toMatchObject({ notificationsRemainDisabled: true, entitlementsRestored: false, referralChanged: false });
  });
});
