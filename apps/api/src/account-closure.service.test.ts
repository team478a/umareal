import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { AccountClosureService } from './account-closure.service';

const now = new Date('2027-04-01T03:00:00.000Z');
const userId = '11111111-1111-4111-8111-111111111111';
const req = { requestId: 'request-1' } as AppRequest;

describe('AccountClosureService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it('returns the existing eligibility response when no active billing blocks closure', async () => {
    const subscription = vi.fn().mockResolvedValue(null);
    const dayPass = vi.fn().mockResolvedValue(null);
    const checkout = vi.fn().mockResolvedValue(null);
    const service = new AccountClosureService({ db: {
      subscription: { findFirst: subscription },
      dayPass: { findFirst: dayPass },
      billingCheckout: { findFirst: checkout },
      auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    } } as unknown as AuthService);

    await expect(service.eligibility(userId, true)).resolves.toEqual({
      eligible: true,
      passwordRequired: true,
      blockers: [],
      retentionPolicyVersion: 'development-v1',
      retained: ['公開・評価履歴との関係', '支払・契約履歴', '同意履歴', '監査履歴'],
    });
    expect(subscription).toHaveBeenCalledWith({
      where: { userId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] }, currentPeriodEndsAt: { gt: now } },
      select: { id: true, currentPeriodEndsAt: true, cancelAtPeriodEnd: true },
    });
    expect(dayPass).toHaveBeenCalledWith({
      where: { userId, status: { in: ['PENDING', 'ACTIVE'] }, endsAt: { gt: now } },
      select: { id: true, endsAt: true },
    });
    expect(checkout).toHaveBeenCalledWith({
      where: { userId, status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: now } },
      select: { id: true, expiresAt: true },
    });
  });

  it('preserves all billing blocker messages and their order', async () => {
    const subscriptionEnd = new Date('2027-05-01T03:00:00.000Z');
    const passEnd = new Date('2027-04-06T15:00:00.000Z');
    const checkoutEnd = new Date('2027-04-01T04:00:00.000Z');
    const service = new AccountClosureService({ db: {
      subscription: { findFirst: vi.fn().mockResolvedValue({ id: 'subscription-1', currentPeriodEndsAt: subscriptionEnd, cancelAtPeriodEnd: true }) },
      dayPass: { findFirst: vi.fn().mockResolvedValue({ id: 'pass-1', endsAt: passEnd }) },
      billingCheckout: { findFirst: vi.fn().mockResolvedValue({ id: 'checkout-1', expiresAt: checkoutEnd }) },
      auditLog: { findMany: vi.fn().mockResolvedValue([]) },
    } } as unknown as AuthService);

    const result = await service.eligibility(userId, false);

    expect(result.eligible).toBe(false);
    expect(result.passwordRequired).toBe(false);
    expect(result.blockers).toEqual([
      { code: 'ACTIVE_SUBSCRIPTION', message: '解約予約済みの月額契約は利用期間終了後に退会できます。', href: '/account', endsAt: subscriptionEnd },
      { code: 'ACTIVE_DAY_PASS', message: '有効な1日利用の終了後に退会できます。', href: '/account', endsAt: passEnd },
      { code: 'PENDING_CHECKOUT', message: '進行中の決済を完了または取消し、決済画面の有効期限が切れてから退会してください。', href: '/account', endsAt: checkoutEnd },
    ]);
  });

  it('uses the latest valid approved policy for new closure eligibility', async () => {
    const approved = { version: 'privacy-2026-10', identityRetentionDays: 365, networkIdentifierRetentionDays: 90, anonymizationScope: ['EMAIL'], reRegistrationHandling: 'MANUAL_REVIEW', dataRequestHandling: 'MANUAL_LEGAL_REVIEW', legalReviewReference: 'LEGAL-42', approvedAt: now.toISOString(), approvedBy: { id: userId, displayName: '管理者' } };
    const service = new AccountClosureService({ db: {
      subscription: { findFirst: vi.fn().mockResolvedValue(null) }, dayPass: { findFirst: vi.fn().mockResolvedValue(null) }, billingCheckout: { findFirst: vi.fn().mockResolvedValue(null) },
      auditLog: { findMany: vi.fn().mockResolvedValue([{ details: { invalid: true } }, { details: approved }]) },
    } } as unknown as AuthService);
    await expect(service.eligibility(userId, false)).resolves.toMatchObject({ retentionPolicyVersion: 'privacy-2026-10' });
  });

  it('records an approved policy append-only with actor and legal reference', async () => {
    const audit = vi.fn().mockResolvedValue({});
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]), auditLog: { findFirst: vi.fn().mockResolvedValue(null) } };
    const service = new AccountClosureService({ db: { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) }, audit } as unknown as AuthService);
    const input = { version: 'privacy-2026-10', identityRetentionDays: 365, networkIdentifierRetentionDays: 90, anonymizationScope: ['EMAIL'] as Array<'EMAIL'>, reRegistrationHandling: 'MANUAL_REVIEW' as const, dataRequestHandling: 'MANUAL_LEGAL_REVIEW' as const, legalReviewReference: 'LEGAL-42', reason: '正式承認' };
    const actor = { id: userId, user: { displayName: '管理者' } };
    const result = await service.approveRetentionPolicy(input, actor, req);
    expect(result).toMatchObject({ version: input.version, approvedBy: { id: userId, displayName: '管理者' }, legalReviewReference: 'LEGAL-42' });
    expect(audit).toHaveBeenCalledWith(tx, req, 'DATA_RETENTION_POLICY_APPROVED', input.version, input.reason, result, 'DATA_RETENTION_POLICY');
  });

  it('does not retroactively count closures recorded under another policy version', async () => {
    const policy = { version: 'privacy-2026-10', identityRetentionDays: 365, networkIdentifierRetentionDays: 90, anonymizationScope: ['EMAIL'], reRegistrationHandling: 'MANUAL_REVIEW', dataRequestHandling: 'MANUAL_LEGAL_REVIEW', legalReviewReference: 'LEGAL-42', approvedAt: now.toISOString(), approvedBy: { id: userId, displayName: '管理者' } };
    const count = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    const findFirst = vi.fn().mockResolvedValue({ accessRevokedAt: new Date('2025-01-01T00:00:00Z') });
    const service = new AccountClosureService({ db: { auditLog: { findMany: vi.fn().mockResolvedValue([{ details: policy }]) }, accountClosure: { count, findFirst } } } as unknown as AuthService);
    const result = await service.retentionPolicyStatus();
    expect(result).toMatchObject({ current: { version: policy.version }, dryRun: { eligibleClosures: 1 }, unmappedClosures: 3, executionEnabled: false });
    expect(count).toHaveBeenNthCalledWith(1, { where: { retentionPolicyVersion: { notIn: [policy.version] } } });
    expect(count).toHaveBeenNthCalledWith(2, { where: { retentionPolicyVersion: policy.version, accessRevokedAt: { lte: expect.any(Date) } } });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { retentionPolicyVersion: policy.version, accessRevokedAt: { lte: expect.any(Date) } } }));
  });

  it('stops every account access path and appends the closure audit in one transaction', async () => {
    const closure = { id: 'closure-1', accessRevokedAt: now, retentionPolicyVersion: 'development-v1' };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      accountClosure: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(closure) },
      subscription: { count: vi.fn().mockResolvedValue(0) },
      dayPass: { count: vi.fn().mockResolvedValue(0) },
      billingCheckout: { count: vi.fn().mockResolvedValue(0) },
      auditLog: { findMany: vi.fn().mockResolvedValue([]) },
      notificationPreference: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      lineAccount: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      entitlement: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      emailVerification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      passwordReset: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      lineOAuthFlow: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      user: { update: vi.fn().mockResolvedValue({}) },
      session: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
    const audit = vi.fn().mockResolvedValue({});
    const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));
    const service = new AccountClosureService({ db: { $transaction: transaction }, audit } as unknown as AuthService);

    await expect(service.close(userId, 'CONTENT', req)).resolves.toEqual({ closedAt: now, alreadyClosed: false, retainedHistory: true });

    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.accountClosure.create).toHaveBeenCalledWith({ data: { userId, reasonCode: 'CONTENT', requestedAt: now, accessRevokedAt: now, retentionPolicyVersion: 'development-v1' } });
    expect(tx.notificationPreference.updateMany).toHaveBeenCalledWith({ where: { userId }, data: { predictions: false, changes: false, articles: false, billing: false } });
    expect(tx.lineAccount.updateMany).toHaveBeenCalledWith({ where: { userId }, data: { unlinkedAt: now, notificationDisabledAt: now } });
    expect(tx.entitlement.updateMany).toHaveBeenCalledWith({ where: { userId, revokedAt: null, endsAt: { gt: now } }, data: { revokedAt: now } });
    expect(audit).toHaveBeenCalledWith(tx, req, 'ACCOUNT_CLOSED', userId, '会員本人による退会', { closureId: 'closure-1', reasonCode: 'CONTENT', retentionPolicyVersion: 'development-v1' });
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: userId }, data: { disabledAt: now } });
    expect(tx.session.deleteMany).toHaveBeenCalledWith({ where: { userId } });
  });

  it('returns an existing immutable closure without repeating side effects', async () => {
    const closedAt = new Date('2027-03-01T03:00:00.000Z');
    const create = vi.fn();
    const update = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      accountClosure: { findUnique: vi.fn().mockResolvedValue({ accessRevokedAt: closedAt }), create },
      user: { update },
    };
    const audit = vi.fn();
    const service = new AccountClosureService({
      db: { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) },
      audit,
    } as unknown as AuthService);

    await expect(service.close(userId, 'OTHER', req)).resolves.toEqual({ closedAt, alreadyClosed: true, retainedHistory: true });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects active billing after locking and before any closure mutation', async () => {
    const create = vi.fn();
    const update = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      accountClosure: { findUnique: vi.fn().mockResolvedValue(null), create },
      subscription: { count: vi.fn().mockResolvedValue(1) },
      dayPass: { count: vi.fn().mockResolvedValue(0) },
      billingCheckout: { count: vi.fn().mockResolvedValue(0) },
      user: { update },
    };
    const service = new AccountClosureService({
      db: { $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) },
      audit: vi.fn(),
    } as unknown as AuthService);

    await expect(service.close(userId, 'PRICE', req)).rejects.toMatchObject({ response: { code: 'ACTIVE_BILLING_EXISTS' } });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
