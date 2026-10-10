import { describe, expect, it } from 'vitest';
import { bankTransferCreateSchema, bankTransferReviewSchema, bankTransferSettingsSchema } from './bank-transfer';

describe('bank transfer contracts', () => {
  it('requires complete account details before bank transfer can be enabled', () => {
    const disabled = { enabled: false, bankName: '', branchName: '', accountType: '', accountNumber: '', accountHolder: '', instructions: '', requestValidityDays: 3, monthlyAccessDays: 30 };
    expect(bankTransferSettingsSchema.parse(disabled)).toEqual(disabled);
    expect(() => bankTransferSettingsSchema.parse({ ...disabled, enabled: true })).toThrow();
    expect(bankTransferSettingsSchema.parse({ ...disabled, enabled: true, bankName: 'テスト銀行', branchName: '本店', accountType: '普通', accountNumber: '1234567', accountHolder: 'ウマリアル' })).toMatchObject({ enabled: true, accountNumber: '1234567' });
  });

  it('keeps day-pass dates separate from fixed-term monthly access', () => {
    expect(bankTransferCreateSchema.parse({ planCode: 'DAY_PASS', raceDate: '2026-10-17' })).toEqual({ planCode: 'DAY_PASS', raceDate: '2026-10-17' });
    expect(bankTransferCreateSchema.parse({ planCode: 'STANDARD' })).toEqual({ planCode: 'STANDARD' });
    expect(() => bankTransferCreateSchema.parse({ planCode: 'DAY_PASS' })).toThrow();
    expect(() => bankTransferCreateSchema.parse({ planCode: 'STANDARD', raceDate: '2026-10-17' })).toThrow();
  });

  it('requires an explicit amount and timestamp for confirmation but not rejection', () => {
    const base = { revision: 2, reason: '入出金明細と照合済み' };
    expect(bankTransferReviewSchema.parse({ ...base, action: 'CONFIRM', receivedAmountYen: 2980, receivedAt: '2026-10-11T01:00:00.000Z' })).toMatchObject({ action: 'CONFIRM', receivedAmountYen: 2980 });
    expect(() => bankTransferReviewSchema.parse({ ...base, action: 'CONFIRM' })).toThrow();
    expect(bankTransferReviewSchema.parse({ ...base, action: 'REJECT' })).toMatchObject({ action: 'REJECT' });
    expect(() => bankTransferReviewSchema.parse({ ...base, action: 'REJECT', receivedAmountYen: 2980 })).toThrow();
  });
});
