import { z } from 'zod';

export const win5ResultRuleVersion = 'WIN5_RESULT_V1';

export const win5ResultImportSchema = z.object({
  revision: z.number().int().min(0),
  officialPayoutYen: z.number().int().min(1).max(100_000_000),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const win5ResultConfirmSchema = z.object({
  revision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500)
}).strict();

export type Win5ResultLegCalculation = {
  legNumber: number;
  raceId: string;
  raceResultVersionId: string;
  winnerEntryId: string;
  winnerNumber: number;
  winnerHorseName: string;
  hit: boolean;
};

export function calculateWin5Result(input: {
  combinationCount: number;
  assumedPurchaseAmountYen: number;
  officialPayoutYen: number;
  legs: readonly Win5ResultLegCalculation[];
}) {
  if (input.legs.length !== 5 || input.legs.some((leg, index) => leg.legNumber !== index + 1)) throw new Error('WIN5 result requires five ordered legs');
  const hitLegs = input.legs.filter(leg => leg.hit).length;
  const perfectHit = hitLegs === 5;
  const assumedPayoutYen = perfectHit ? input.officialPayoutYen : 0;
  const recoveryRateTenthsPercent = Math.round(assumedPayoutYen / input.assumedPurchaseAmountYen * 1000);
  if (![input.combinationCount, input.assumedPurchaseAmountYen, assumedPayoutYen, recoveryRateTenthsPercent].every(Number.isSafeInteger)) throw new Error('WIN5 result exceeds the calculation limit');
  return { hitLegs, perfectHit, assumedPayoutYen, recoveryRateTenthsPercent };
}
