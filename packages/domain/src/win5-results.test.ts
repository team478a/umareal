import { describe, expect, it } from 'vitest';
import { calculateWin5Result } from './win5-results';

const legs = (hits: number) => Array.from({ length: 5 }, (_, index) => ({ legNumber: index + 1, raceId: crypto.randomUUID(), raceResultVersionId: crypto.randomUUID(), winnerEntryId: crypto.randomUUID(), winnerNumber: index + 1, winnerHorseName: `勝馬${index + 1}`, hit: index < hits }));

describe('calculateWin5Result', () => {
  it('pays only a complete five-leg hit and stores tenths of a percent', () => {
    expect(calculateWin5Result({ combinationCount: 32, assumedPurchaseAmountYen: 3200, officialPayoutYen: 10000, legs: legs(4) })).toMatchObject({ hitLegs: 4, perfectHit: false, assumedPayoutYen: 0, recoveryRateTenthsPercent: 0 });
    expect(calculateWin5Result({ combinationCount: 32, assumedPurchaseAmountYen: 3200, officialPayoutYen: 10000, legs: legs(5) })).toMatchObject({ hitLegs: 5, perfectHit: true, assumedPayoutYen: 10000, recoveryRateTenthsPercent: 3125 });
  });
});
