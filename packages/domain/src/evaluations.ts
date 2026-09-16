import { z } from 'zod';

export const evaluationTypes = ['PRIMARY', 'SECONDARY', 'WATCH', 'RISK'] as const;
export const evaluationConfidences = ['S', 'A', 'B', 'C', 'SKIP'] as const;
export const predictionEvaluationStatuses = [
  'PRIMARY_WIN',
  'PRIMARY_TOP2',
  'PRIMARY_TOP3',
  'WINNER_IN_RECOMMENDED',
  'WINNER_NOT_RECOMMENDED',
  'SKIPPED',
  'EXCLUDED',
  'CANCELED',
  'REVIEW_REQUIRED'
] as const;
export const win5EvaluationStatuses = [
  'WIN5_ALL_WINNERS_RECOMMENDED',
  'WIN5_PARTIAL',
  'WIN5_MISSED',
  'REVIEW_REQUIRED'
] as const;

export const evaluatedHorseSchema = z.object({
  entryId: z.string().uuid(),
  evaluationType: z.enum(evaluationTypes),
  reason: z.string().trim().min(1).max(1000),
  displayOrder: z.number().int().min(1).max(18)
}).strict();

export const evaluatedHorsesSchema = z.array(evaluatedHorseSchema).max(18).superRefine((horses, context) => {
  const entryIds = new Set<string>();
  const displayOrders = new Set<string>();
  let primaryCount = 0;
  horses.forEach((horse, index) => {
    if (entryIds.has(horse.entryId)) context.addIssue({ code: 'custom', path: [index, 'entryId'], message: '同じ馬に複数の評価区分は設定できません。' });
    entryIds.add(horse.entryId);
    const orderKey = `${horse.evaluationType}:${horse.displayOrder}`;
    if (displayOrders.has(orderKey)) context.addIssue({ code: 'custom', path: [index, 'displayOrder'], message: '同じ評価区分内の表示順が重複しています。' });
    displayOrders.add(orderKey);
    if (horse.evaluationType === 'PRIMARY') primaryCount += 1;
  });
  if (primaryCount > 1) context.addIssue({ code: 'custom', path: [], message: '中心馬は1頭だけ設定できます。' });
});

export type EvaluatedHorse = z.infer<typeof evaluatedHorseSchema>;
export type PredictionEvaluationStatus = typeof predictionEvaluationStatuses[number];
export type Win5EvaluationStatus = typeof win5EvaluationStatuses[number];

type ResultEntry = {
  entryId: string;
  status: 'FINISHED' | 'WITHDRAWN' | 'EXCLUDED' | 'DNF' | 'CANCELED';
  finishPosition: number | null;
};

export function evaluatePrediction(input: {
  confidence: typeof evaluationConfidences[number];
  horses: readonly Pick<EvaluatedHorse, 'entryId' | 'evaluationType'>[];
  resultEntries: readonly ResultEntry[];
  raceCanceled: boolean;
}) {
  const empty = { primaryFinishedFirst: false, primaryFinishedTop2: false, primaryFinishedTop3: false, winnerInRecommended: false };
  if (input.raceCanceled) return { ...empty, status: 'CANCELED' as const };
  if (input.confidence === 'SKIP') return { ...empty, status: 'SKIPPED' as const };

  const primary = input.horses.filter(horse => horse.evaluationType === 'PRIMARY');
  if (primary.length !== 1) return { ...empty, status: 'REVIEW_REQUIRED' as const };
  const primaryResult = input.resultEntries.find(entry => entry.entryId === primary[0].entryId);
  if (!primaryResult) return { ...empty, status: 'REVIEW_REQUIRED' as const };
  if (primaryResult.status !== 'FINISHED') return { ...empty, status: 'EXCLUDED' as const };

  const winners = input.resultEntries.filter(entry => entry.status === 'FINISHED' && entry.finishPosition === 1);
  if (winners.length !== 1 || primaryResult.finishPosition === null) return { ...empty, status: 'REVIEW_REQUIRED' as const };
  const recommendedIds = new Set(input.horses.filter(horse => horse.evaluationType === 'PRIMARY' || horse.evaluationType === 'SECONDARY').map(horse => horse.entryId));
  const primaryFinishedFirst = primaryResult.finishPosition === 1;
  const primaryFinishedTop2 = primaryResult.finishPosition <= 2;
  const primaryFinishedTop3 = primaryResult.finishPosition <= 3;
  const winnerInRecommended = recommendedIds.has(winners[0].entryId);
  const status: PredictionEvaluationStatus = primaryFinishedFirst
    ? 'PRIMARY_WIN'
    : primaryResult.finishPosition === 2
      ? 'PRIMARY_TOP2'
      : primaryResult.finishPosition === 3
        ? 'PRIMARY_TOP3'
        : winnerInRecommended
          ? 'WINNER_IN_RECOMMENDED'
          : 'WINNER_NOT_RECOMMENDED';
  return { primaryFinishedFirst, primaryFinishedTop2, primaryFinishedTop3, winnerInRecommended, status };
}

export function evaluateWin5(legs: readonly { legNumber: number; status: PredictionEvaluationStatus; winnerInRecommended: boolean }[]) {
  if (legs.length !== 5 || legs.some((leg, index) => leg.legNumber !== index + 1)) throw new Error('WIN5 evaluation requires five ordered legs');
  const reviewRequired = legs.some(leg => ['REVIEW_REQUIRED', 'CANCELED', 'EXCLUDED', 'SKIPPED'].includes(leg.status));
  const recommendedLegs = legs.filter(leg => leg.winnerInRecommended).length;
  const status: Win5EvaluationStatus = reviewRequired
    ? 'REVIEW_REQUIRED'
    : recommendedLegs === 5
      ? 'WIN5_ALL_WINNERS_RECOMMENDED'
      : recommendedLegs === 0
        ? 'WIN5_MISSED'
        : 'WIN5_PARTIAL';
  return { status, recommendedLegs, allWinnersRecommended: status === 'WIN5_ALL_WINNERS_RECOMMENDED' };
}

const percent = (numerator: number, denominator: number) => denominator ? Math.round(numerator / denominator * 1000) / 10 : null;

export function aggregatePredictionEvaluations(items: readonly {
  status: PredictionEvaluationStatus;
  primaryFinishedFirst: boolean;
  primaryFinishedTop2: boolean;
  primaryFinishedTop3: boolean;
  upHorseSuccessful?: boolean | null;
  downHorseUnsuccessful?: boolean | null;
  riskHorseUnsuccessful?: boolean | null;
}[]) {
  const publishedRaces = items.length;
  const skipped = items.filter(item => item.status === 'SKIPPED').length;
  const eligible = items.filter(item => !['SKIPPED', 'EXCLUDED', 'CANCELED', 'REVIEW_REQUIRED'].includes(item.status));
  const up = items.filter(item => item.upHorseSuccessful !== undefined && item.upHorseSuccessful !== null);
  const down = items.filter(item => item.downHorseUnsuccessful !== undefined && item.downHorseUnsuccessful !== null);
  const risk = items.filter(item => item.riskHorseUnsuccessful !== undefined && item.riskHorseUnsuccessful !== null);
  return {
    publishedRaces,
    primaryWins: eligible.filter(item => item.primaryFinishedFirst).length,
    primaryWinRatePercent: percent(eligible.filter(item => item.primaryFinishedFirst).length, eligible.length),
    primaryTop2RatePercent: percent(eligible.filter(item => item.primaryFinishedTop2).length, eligible.length),
    primaryTop3RatePercent: percent(eligible.filter(item => item.primaryFinishedTop3).length, eligible.length),
    upHorseSuccessRatePercent: percent(up.filter(item => item.upHorseSuccessful).length, up.length),
    downHorseFailureRatePercent: percent(down.filter(item => item.downHorseUnsuccessful).length, down.length),
    riskHorseFailureRatePercent: percent(risk.filter(item => item.riskHorseUnsuccessful).length, risk.length),
    skipped,
    skipRatePercent: percent(skipped, publishedRaces)
  };
}

export function aggregateWin5Evaluations(items: readonly {
  status: Win5EvaluationStatus;
  recommendedLegs: number;
  legs: readonly { primaryFinishedFirst: boolean; primaryFinishedTop2: boolean; primaryFinishedTop3: boolean; winnerInRecommended: boolean }[];
}[]) {
  const eligible = items.filter(item => item.status !== 'REVIEW_REQUIRED');
  const legs = eligible.flatMap(item => item.legs);
  const allRecommended = eligible.filter(item => item.status === 'WIN5_ALL_WINNERS_RECOMMENDED').length;
  return {
    publications: items.length,
    targetRaces: legs.length,
    winnersRecommended: legs.filter(leg => leg.winnerInRecommended).length,
    winnersRecommendedRatePercent: percent(legs.filter(leg => leg.winnerInRecommended).length, legs.length),
    allWinnersRecommended: allRecommended,
    primaryWins: legs.filter(leg => leg.primaryFinishedFirst).length,
    primaryWinRatePercent: percent(legs.filter(leg => leg.primaryFinishedFirst).length, legs.length),
    primaryTop2RatePercent: percent(legs.filter(leg => leg.primaryFinishedTop2).length, legs.length),
    primaryTop3RatePercent: percent(legs.filter(leg => leg.primaryFinishedTop3).length, legs.length)
  };
}
