import { z } from 'zod';
import { confidences, publicationVisibilities } from './predictions';
import { evaluatedHorsesSchema, evaluationTypes } from './evaluations';
import { dateSchema, entryStatuses, raceStatuses } from './races';

export const win5ProductTypes = ['WIN5_PREVIEW'] as const;
export const win5StrategyTypes = ['NARROW', 'NORMAL', 'SPREAD'] as const;

const win5DateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const publicWin5VersionMetadataSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(['PUBLISHED', 'CORRECTED']),
  publishedAt: win5DateTimeSchema,
  previousVersionId: z.string().uuid().nullable()
}).strict();

export const publicWin5ProductSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(win5ProductTypes),
  targetDate: dateSchema,
  title: z.string(),
  status: z.enum(['SCHEDULED', 'PUBLISHED', 'CORRECTED']),
  scheduledPublishAt: win5DateTimeSchema,
  publishedAt: win5DateTimeSchema.nullable(),
  confidence: z.enum(confidences).nullable(),
  races: z.array(z.object({
    legNumber: z.number().int().min(1).max(5),
    race: z.object({
      id: z.string().uuid(),
      venue: z.string(),
      number: z.number().int().min(1).max(12),
      startsAt: win5DateTimeSchema,
      status: z.enum(raceStatuses)
    }).strict()
  }).strict()).max(5),
  latestVersion: publicWin5VersionMetadataSchema.nullable()
}).strict();

export const publicWin5ListResponseSchema = z.object({
  items: z.array(publicWin5ProductSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1).max(10000),
  limit: z.literal(20)
}).strict();

const publicWin5HistoryVersionSchema = publicWin5VersionMetadataSchema.extend({
  correctionReason: z.string().nullable()
}).strict();

const publicWin5ContentSnapshotSchema = z.object({
  product: z.object({
    type: z.enum(win5ProductTypes).optional(),
    targetDate: dateSchema.optional(),
    title: z.string().optional(),
    expertId: z.string().uuid().optional(),
    expertName: z.string(),
    accessScope: z.enum(publicationVisibilities).optional(),
    scheduledPublishAt: win5DateTimeSchema.optional(),
    confidence: z.enum(confidences),
    summary: z.string()
  }).strict(),
  races: z.array(z.object({
    legNumber: z.number().int().min(1).max(5),
    confidence: z.enum(confidences),
    paceView: z.string(),
    shortComment: z.string(),
    race: z.object({
      id: z.string().uuid(),
      raceDate: dateSchema,
      venue: z.string(),
      number: z.number().int().min(1).max(12),
      name: z.string(),
      startsAt: win5DateTimeSchema,
      status: z.enum(raceStatuses)
    }).strict(),
    evaluations: z.array(z.object({
      entryId: z.string().uuid(),
      horseId: z.string().uuid(),
      number: z.number().int().min(1).max(18),
      horseName: z.string(),
      status: z.enum(entryStatuses),
      evaluationType: z.enum(evaluationTypes),
      reason: z.string(),
      displayOrder: z.number().int().min(1).max(18)
    }).strict()).max(18)
  }).strict()).max(5)
}).strict();

const publicWin5FullVersionSchema = publicWin5HistoryVersionSchema.extend({
  confidence: z.enum(confidences),
  formatVersion: z.enum(['LEGACY_BETTING_V1', 'HORSE_EVALUATION_V1']),
  contentSnapshot: publicWin5ContentSnapshotSchema,
  deadlineAt: win5DateTimeSchema
}).strict();

export const publicWin5DetailResponseSchema = z.discriminatedUnion('access', [
  z.object({
    access: z.literal('METADATA'),
    product: publicWin5ProductSchema,
    version: z.null(),
    versions: z.array(publicWin5VersionMetadataSchema),
    locked: z.boolean()
  }).strict(),
  z.object({
    access: z.literal('FULL'),
    product: publicWin5ProductSchema,
    version: publicWin5FullVersionSchema,
    versions: z.array(publicWin5HistoryVersionSchema),
    locked: z.literal(false)
  }).strict()
]);

export type PublicWin5ListResponse = z.infer<typeof publicWin5ListResponseSchema>;
export type PublicWin5DetailResponse = z.infer<typeof publicWin5DetailResponseSchema>;

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
  paceView: z.string().trim().max(2000),
  shortComment: z.string().trim().max(1000),
  evaluations: evaluatedHorsesSchema,
  reason: z.string().trim().min(1).max(500)
}).strict().superRefine((value, context) => {
  if (value.evaluations.length > 0 && value.evaluations.filter(item => item.evaluationType === 'PRIMARY').length !== 1) context.addIssue({ code: 'custom', path: ['evaluations'], message: '中心馬を1頭設定してください。' });
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
