import { describe, expect, it } from 'vitest';
import { stripePriceMatchesCheckout } from './stripe-price';

describe('Stripe Price validation', () => {
  const monthly = { active: true, currency: 'jpy', unit_amount: 2980, recurring: { interval: 'month', interval_count: 1 } };

  it('accepts an active JPY monthly price with the configured amount', () => {
    expect(stripePriceMatchesCheckout(monthly, 2980, 'SUBSCRIPTION')).toBe(true);
  });

  it.each([
    [{ ...monthly, active: false }, 2980, 'SUBSCRIPTION'],
    [{ ...monthly, currency: 'usd' }, 2980, 'SUBSCRIPTION'],
    [{ ...monthly, unit_amount: 980 }, 2980, 'SUBSCRIPTION'],
    [{ ...monthly, recurring: { interval: 'year', interval_count: 1 } }, 2980, 'SUBSCRIPTION'],
    [{ ...monthly, recurring: null }, 2980, 'SUBSCRIPTION'],
    [{ deleted: true }, 2980, 'SUBSCRIPTION']
  ] as const)('rejects a subscription Price that does not match the plan contract', (price, amount, kind) => {
    expect(stripePriceMatchesCheckout(price, amount, kind)).toBe(false);
  });

  it('accepts only a non-recurring Price for a day pass', () => {
    const oneTime = { active: true, currency: 'JPY', unit_amount: 980, recurring: null };
    expect(stripePriceMatchesCheckout(oneTime, 980, 'DAY_PASS')).toBe(true);
    expect(stripePriceMatchesCheckout({ ...oneTime, recurring: monthly.recurring }, 980, 'DAY_PASS')).toBe(false);
  });
});
