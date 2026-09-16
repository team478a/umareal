import { z } from 'zod';
import { confidences, publicationVisibilities } from './predictions';
import { evaluatedHorsesSchema } from './evaluations';

export const win5ProductTypes = ['WIN5_PREVIEW'] as const;
export const win5StrategyTypes = ['NARROW', 'NORMAL', 'SPREAD'] as const;

const jstDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00+09:00`);
  return Number.isFinite(parsed.getTime()) && new Date(parsed.getTime() + 9 * 3600000).toISOString().slice(0, 10) === value;
}, '有効な開催日を入力してください。');

export const win5ProductCreateSchema = z.object({
  type: z.enum(win5ProductTypes).default('WIN5_PREVIEW'),
  targetDate: jstDateSchema,
  title: z.string().trim().min(1).max(120),
  expertId: z.string().uuid(),
  scheduledPublishAt: z.string().datetime({ offset: true }),
  accessScope: z.enum(publicationVisibilities),
  confidence: z.enum(confidences),
  summary: z.string().trim().max(5000).default(''),
  showFreeConfidence: z.boolean().default(false),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const win5ProductUpdateSchema = z.object({
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(120),
  expertId: z.string().uuid(),
  scheduledPublishAt: z.string().datetime({ offset: true }),
  accessScope: z.enum(publicationVisibilities),
  confidence: z.enum(confidences),
  summary: z.string().trim().max(5000),
  showFreeConfidence: z.boolean(),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const win5LegUpdateSchema = z.object({
  productRevision: z.number().int().positive(),
  legNumber: z.number().int().min(1).max(5),
  raceId: z.string().uuid(),
  confidence: z.enum(confidences),
  paceView: z.string().trim().min(1).max(2000),
  shortComment: z.string().trim().min(1).max(1000),
  evaluations: evaluatedHorsesSchema.refine(value => value.length > 0, '評価馬を1頭以上設定してください。'),
  reason: z.string().trim().min(1).max(500)
}).strict().superRefine((value, context) => {
  if (value.evaluations.filter(item => item.evaluationType === 'PRIMARY').length !== 1) context.addIssue({ code: 'custom', path: ['evaluations'], message: '中心馬を1頭設定してください。' });
});

export const win5PreviewSchema = z.object({
  productRevision: z.number().int().positive(),
  correctionReason: z.string().trim().max(500).default('')
}).strict();

export function win5CombinationCount(selectionCounts: readonly number[]) {
  if (selectionCounts.length !== 5 || selectionCounts.some(value => !Number.isInteger(value) || value < 1)) throw new Error('WIN5 requires five positive selection counts');
  const count = selectionCounts.reduce((total, value) => total * value, 1);
  if (!Number.isSafeInteger(count) || count > 2_000_000_000) throw new Error('WIN5 combination count exceeds the storage limit');
  return count;
}

export function win5AssumedPurchaseAmount(combinationCount: number, amountPerPointYen: number) {
  const total = combinationCount * amountPerPointYen;
  if (!Number.isSafeInteger(total) || total > 2_000_000_000) throw new Error('WIN5 assumed purchase amount exceeds the storage limit');
  return total;
}
