import { describe, expect, it } from 'vitest';
import { addCalendarMonthUtc, billingPlansResponseSchema, billingReviewResolutionSchema, dayPassCheckoutSchema, dayPassWindow } from './index';

describe('billing periods', () => {
  it('uses an exclusive JST day-pass boundary', () => {
    const window = dayPassWindow('2027-01-02');
    expect(window.startsAt.toISOString()).toBe('2027-01-01T15:00:00.000Z');
    expect(window.endsAt.toISOString()).toBe('2027-01-02T15:00:00.000Z');
    expect(dayPassCheckoutSchema.safeParse({ raceDate: '2027-02-30' }).success).toBe(false);
  });
  it('clamps the local simulation calendar month', () => {
    expect(addCalendarMonthUtc(new Date('2027-01-31T05:00:00Z')).toISOString()).toBe('2027-02-28T05:00:00.000Z');
  });
  it('requires an explicit review action and operational reason', () => {
    expect(billingReviewResolutionSchema.parse({ action: 'REFUND', reason: '重複契約を確認したため' })).toEqual({ action: 'REFUND', reason: '重複契約を確認したため' });
    expect(billingReviewResolutionSchema.safeParse({ action: 'GRANT_ACCESS', reason: ' ' }).success).toBe(false);
    expect(billingReviewResolutionSchema.safeParse({ action: 'OTHER', reason: '確認済み' }).success).toBe(false);
  });
  it('fixes the existing public plan catalog without accepting internal fields', () => {
    const response = {
      newPurchasesEnabled: false,
      developmentTerms: true,
      billingTransport: 'disabled' as const,
      stripeMode: null,
      currency: 'JPY' as const,
      taxIncluded: true,
      plans: [
        { code: 'FOUNDER' as const, name: '創設会員' as const, priceYen: 1980, interval: 'MONTH' as const, available: false, remaining: 100 },
        { code: 'STANDARD' as const, name: '通常会員' as const, priceYen: 2980, interval: 'MONTH' as const, available: false },
        { code: 'DAY_PASS' as const, name: '1日利用' as const, priceYen: 980, interval: 'JST_DAY' as const, available: false }
      ]
    };
    expect(billingPlansResponseSchema.parse(response)).toEqual(response);
    expect(() => billingPlansResponseSchema.parse({ ...response, stripeSecretKey: 'secret' })).toThrow();
  });
});
