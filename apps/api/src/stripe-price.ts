export type StripePriceShape = {
  deleted?: boolean | void;
  active?: boolean;
  currency?: string;
  unit_amount?: number | null;
  recurring?: { interval?: string; interval_count?: number } | null;
};

export function stripePriceMatchesCheckout(price: StripePriceShape, amountYen: number, kind: 'SUBSCRIPTION' | 'DAY_PASS') {
  if (price.deleted === true || !price.active || price.currency?.toLowerCase() !== 'jpy' || price.unit_amount !== amountYen) return false;
  if (kind === 'DAY_PASS') return !price.recurring;
  return price.recurring?.interval === 'month' && price.recurring.interval_count === 1;
}
