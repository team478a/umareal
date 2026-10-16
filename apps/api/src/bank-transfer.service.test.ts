import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthService } from './auth.service';
import { BankTransferService } from './bank-transfer.service';

const originalTransport = process.env.BILLING_TRANSPORT;
afterEach(() => { process.env.BILLING_TRANSPORT = originalTransport; });

const account = { bankName: 'テスト銀行', branchName: '本店', accountType: '普通', accountNumber: '1234567', accountHolder: 'ウマリアル', instructions: '識別番号を入力してください。' };
const now = new Date('2026-10-11T01:00:00.000Z');
const baseRequest = {
  id: '10000000-0000-4000-8000-000000000001', userId: '10000000-0000-4000-8000-000000000002', kind: 'SUBSCRIPTION', planCode: 'STANDARD', raceDate: null,
  amountYen: 2980, referenceCode: 'UM-ABCDEF1234', bankAccountSnapshot: account, status: 'AWAITING_TRANSFER', payerName: null, reportedAt: null, receivedAt: null,
  expiresAt: new Date('2026-10-14T01:00:00.000Z'), confirmedAt: null, rejectedAt: null, reviewedById: null, reviewReason: null, entitlementId: null, dayPassId: null,
  idempotencyKey: 'create-key', requestHash: 'hash', revision: 1, createdAt: now, updatedAt: now
};

describe('BankTransferService', () => {
  it('creates only a pending request and never grants access before bank confirmation', async () => {
    process.env.BILLING_TRANSPORT = 'bank_transfer';
    const created = { ...baseRequest };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue({ bankTransferEnabled: true, bankTransferBankName: account.bankName, bankTransferBranchName: account.branchName, bankTransferAccountType: account.accountType, bankTransferAccountNumber: account.accountNumber, bankTransferAccountHolder: account.accountHolder, bankTransferInstructions: account.instructions, bankTransferRequestValidityDays: 3, bankTransferMonthlyAccessDays: 30, newPurchasesEnabled: true, founderSalesEnabled: false, standardSalesEnabled: true, dayPassSalesEnabled: true, founderPriceYen: 1980, standardPriceYen: 2980, dayPassPriceYen: 980, founderSalesLimit: 100 }), update: vi.fn() },
      bankTransferRequest: { findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue(created) },
      entitlement: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
      subscription: { count: vi.fn() }, dayPass: { count: vi.fn() }, paymentTransaction: { create: vi.fn() }
    };
    const audit = vi.fn();
    const db = { bankTransferRequest: { findUnique: vi.fn().mockResolvedValue(null) }, $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)) };
    const service = new BankTransferService({ db, audit } as unknown as AuthService);
    const result = await service.create({} as never, baseRequest.userId, { planCode: 'STANDARD' }, 'create-key', 'hash');
    expect(result.status).toBe('AWAITING_TRANSFER');
    expect(result.amountYen).toBe(2980);
    expect(tx.entitlement.create).not.toHaveBeenCalled();
    expect(tx.paymentTransaction.create).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(tx, expect.anything(), 'BANK_TRANSFER_REQUEST_CREATE', created.id, expect.any(String), expect.objectContaining({ amountYen: 2980 }), 'BankTransferRequest');
  });

  it('confirms a reported transfer once and grants finite access with an append-only payment', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const reported = { ...baseRequest, status: 'TRANSFER_REPORTED', payerName: 'コジマ アヤノ', reportedAt: new Date('2026-10-11T00:30:00.000Z'), revision: 2 };
    const entitlement = { id: '20000000-0000-4000-8000-000000000001', endsAt: new Date('2026-11-10T01:00:00.000Z') };
    const confirmed = { ...reported, status: 'CONFIRMED', receivedAt: new Date('2026-10-11T00:45:00.000Z'), confirmedAt: now, reviewedById: 'admin', reviewReason: '入出金明細と照合済み', entitlementId: entitlement.id, revision: 3 };
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      idempotencyKey: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      bankTransferRequest: { findUnique: vi.fn().mockResolvedValue(reported), update: vi.fn().mockResolvedValue(confirmed) },
      systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue({ bankTransferMonthlyAccessDays: 30 }) },
      entitlement: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue(entitlement) },
      paymentTransaction: { create: vi.fn().mockResolvedValue({ id: 'payment' }) },
      billingEvent: { create: vi.fn().mockResolvedValue({ id: 'event' }) },
      notificationEvent: { create: vi.fn().mockResolvedValue({ id: 'notification' }) }
    };
    const audit = vi.fn();
    const db = { $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)) };
    const service = new BankTransferService({ db, audit } as unknown as AuthService);
    const result = await service.review({} as never, '30000000-0000-4000-8000-000000000001', reported.id, { action: 'CONFIRM', receivedAmountYen: 2980, receivedAt: '2026-10-11T00:45:00.000Z', revision: 2, reason: '入出金明細と照合済み' }, 'review-key', 'review-hash');
    expect(result.status).toBe('CONFIRMED');
    expect(tx.entitlement.create).toHaveBeenCalledWith({ data: expect.objectContaining({ planCode: 'STANDARD', reason: 'BANK_TRANSFER_CONFIRMED' }) });
    expect(tx.paymentTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'BANK_TRANSFER', status: 'SUCCEEDED', bankTransferRequestId: reported.id }) });
    expect(tx.bankTransferRequest.update).toHaveBeenCalledWith({ where: { id: reported.id }, data: expect.objectContaining({ status: 'CONFIRMED', entitlementId: entitlement.id, revision: { increment: 1 } }) });
    vi.useRealTimers();
  });
});
