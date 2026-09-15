import { z } from 'zod';
import { confidences, publicationVisibilities } from './predictions';

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
  amountPerPointYen: z.number().int().min(100).max(1_000_000).multipleOf(100).optional(),
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
  amountPerPointYen: z.number().int().min(100).max(1_000_000).multipleOf(100),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const win5LegUpdateSchema = z.object({
  productRevision: z.number().int().positive(),
  legNumber: z.number().int().min(1).max(5),
  raceId: z.string().uuid(),
  confidence: z.enum(confidences),
  strategyType: z.enum(win5StrategyTypes),
  comment: z.string().trim().min(1).max(2000),
  selectionEntryIds: z.array(z.string().uuid()).min(1).max(18),
  centerEntryId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500)
}).strict().superRefine((value, context) => {
  const unique = new Set(value.selectionEntryIds);
  if (unique.size !== value.selectionEntryIds.length) context.addIssue({ code: 'custom', path: ['selectionEntryIds'], message: '選択馬が重複しています。' });
  if (!unique.has(value.centerEntryId)) context.addIssue({ code: 'custom', path: ['centerEntryId'], message: '中心馬は選択馬に含めてください。' });
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
