import { describe, expect, it } from 'vitest';
import { addCalendarMonthUtc, billingReviewResolutionSchema, dayPassCheckoutSchema, dayPassWindow } from './index';

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
});
