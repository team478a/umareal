import { describe, expect, it } from 'vitest';
import { addCalendarMonthUtc, dayPassCheckoutSchema, dayPassWindow } from './index';

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
});
