import { z } from 'zod';
import { evaluationConfidences } from './evaluations';
import { assessmentSchema } from './assessments';
import { entryStatuses, raceStatuses } from './races';

export const publicationVisibilities = ['FREE', 'PAID'] as const;
export const predictionModes = ['DETAILED', 'QUICK_PICK'] as const;
export const confidences = ['S', 'A', 'B', 'C'] as const;
export const stances = ['BET', 'NORMAL', 'SMALL', 'SKIP'] as const;
export const finalMarks = ['HONMEI', 'TAIKO', 'TANANA', 'RENKA', 'ANA', 'DANGER'] as const;
export const betTypes = ['WIN', 'PLACE', 'QUINELLA', 'EXACTA', 'WIDE', 'TRIO', 'TRIFECTA'] as const;

const predictionDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

const markSchema = z.object({ entryId: z.string().uuid(), mark: z.enum(finalMarks), reason: z.string().trim().min(1).max(1000) }).strict();
const marksSchema = z.array(markSchema).max(18).superRefine((marks, context) => {
  const entries = new Set<string>();
  marks.forEach((mark, index) => {
    if (entries.has(mark.entryId)) context.addIssue({ code: 'custom', path: [index, 'entryId'], message: '同じ馬に複数の最終評価は設定できません。' });
    entries.add(mark.entryId);
  });
});

export const predictionDraftSchema = z.object({
  mode: z.enum(predictionModes).default('DETAILED'),
  visibility: z.enum(publicationVisibilities).nullable(),
  confidence: z.enum(evaluationConfidences).nullable(),
  summary: z.string().trim().max(5000),
  marks: marksSchema
}).strict();
export type PredictionDraft = z.infer<typeof predictionDraftSchema>;
export const emptyPredictionDraft: PredictionDraft = { mode: 'DETAILED', visibility: null, confidence: null, summary: '', marks: [] };

export const publishablePredictionSchema = predictionDraftSchema.superRefine((value, context) => {
  if (!value.visibility) context.addIssue({ code: 'custom', path: ['visibility'], message: '公開範囲を選択してください。' });
  if (!value.confidence) context.addIssue({ code: 'custom', path: ['confidence'], message: '信頼度または見送りを選択してください。' });
  if (!value.summary) context.addIssue({ code: 'custom', path: ['summary'], message: '最終見解を入力してください。' });
  if (value.mode === 'QUICK_PICK') {
    if (value.confidence === 'SKIP') context.addIssue({ code: 'custom', path: ['confidence'], message: '速報入力では見送りを選択できません。' });
    if (!value.marks.length) context.addIssue({ code: 'custom', path: ['marks'], message: '速報の注目馬を1頭以上選択してください。' });
    if (value.marks.some(mark => mark.mark !== 'TAIKO')) context.addIssue({ code: 'custom', path: ['marks'], message: '速報の注目馬はすべて同じ「○」評価で保存します。' });
  } else {
    if (value.confidence === 'SKIP' && value.marks.length) context.addIssue({ code: 'custom', path: ['marks'], message: '見送り時は最終評価馬を設定できません。' });
    if (value.confidence !== 'SKIP' && value.marks.filter(mark => mark.mark === 'HONMEI').length !== 1) context.addIssue({ code: 'custom', path: ['marks'], message: '見送り以外は最終本命を1頭設定してください。' });
  }
});
export const predictionSaveSchema = z.object({ draft: predictionDraftSchema, revision: z.number().int().min(0), raceRevision: z.number().int().positive(), mutationId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict();
export const publishPreviewSchema = z.object({ predictionRevision: z.number().int().positive(), raceRevision: z.number().int().positive(), correctionReason: z.string().trim().max(500).default('') }).strict();

export const expertPredictionDraftSaveResponseSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  draft: predictionDraftSchema,
  updatedAt: predictionDateTimeSchema
}).strict();
export type ExpertPredictionDraftSaveResponse = z.infer<typeof expertPredictionDraftSaveResponseSchema>;

export const expertPredictionPreviewResponseSchema = z.object({
  previewId: z.string().uuid(),
  expiresAt: predictionDateTimeSchema,
  version: z.number().int().positive(),
  correction: z.boolean(),
  correctionReason: z.string().max(500),
  warnings: z.array(z.string().min(1)).max(18),
  deadlineAt: predictionDateTimeSchema,
  draft: predictionDraftSchema,
  entries: z.array(z.object({
    id: z.string().uuid(),
    number: z.number().int().min(1).max(18),
    horseName: z.string().min(1)
  }).strict()).max(18)
}).strict();
export type ExpertPredictionPreviewResponse = z.infer<typeof expertPredictionPreviewResponseSchema>;

export const expertPredictionPublishResponseSchema = z.discriminatedUnion('alreadyPublished', [
  z.object({
    published: z.literal(true),
    versionId: z.string().uuid(),
    alreadyPublished: z.literal(true)
  }).strict(),
  z.object({
    published: z.literal(true),
    versionId: z.string().uuid(),
    version: z.number().int().positive(),
    alreadyPublished: z.literal(false),
    publishedAt: predictionDateTimeSchema
  }).strict()
]);
export type ExpertPredictionPublishResponse = z.infer<typeof expertPredictionPublishResponseSchema>;

const expertPredictionAssessmentSchema = z.object({
  content: assessmentSchema.pick({ change: true, paddockComment: true })
}).strict();

export const expertPredictionEditorResponseSchema = z.object({
  race: z.object({
    id: z.string().uuid(),
    name: z.string().min(1),
    venue: z.string().min(1),
    number: z.number().int().min(1).max(12),
    startsAt: predictionDateTimeSchema,
    status: z.enum(raceStatuses),
    revision: z.number().int().positive()
  }).strict(),
  entries: z.array(z.object({
    id: z.string().uuid(),
    number: z.number().int().min(1).max(18),
    horseName: z.string().min(1),
    status: z.enum(entryStatuses),
    assessment: expertPredictionAssessmentSchema.nullable()
  }).strict()).max(18),
  prediction: z.object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    draft: predictionDraftSchema
  }).strict().nullable(),
  versions: z.array(z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    status: z.enum(['PUBLISHED', 'CORRECTED']),
    confidence: z.enum(evaluationConfidences),
    summary: z.string(),
    publishedAt: predictionDateTimeSchema,
    correctionReason: z.string().nullable()
  }).strict()),
  correctionPolicy: z.enum(['ADMIN_ONLY', 'EXPERT_OR_ADMIN'])
}).strict();

export type ExpertPredictionEditorResponse = z.infer<typeof expertPredictionEditorResponseSchema>;

const publicPredictionRaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  venue: z.string(),
  number: z.number().int().positive(),
  startsAt: predictionDateTimeSchema
}).strict();

const publicPredictionVersionMetadataShape = {
  id: z.string().uuid(),
  version: z.number().int().positive(),
  status: z.enum(['PUBLISHED', 'CORRECTED']),
  visibility: z.enum(publicationVisibilities),
  publishedAt: predictionDateTimeSchema,
  previousVersionId: z.string().uuid().nullable()
};

const publicPredictionAssessmentSnapshotSchema = z.union([
  z.array(z.object({
    entryId: z.string().uuid(),
    horseId: z.string().uuid(),
    number: z.number().int().positive(),
    horseName: z.string(),
    assessment: assessmentSchema.nullable()
  }).strict()),
  z.object({}).strict()
]);

export const publicPredictionLockedVersionSchema = z.object({
  ...publicPredictionVersionMetadataShape,
  locked: z.literal(true)
}).strict();

export const publicPredictionFullVersionSchema = z.object({
  ...publicPredictionVersionMetadataShape,
  displayMode: z.enum(predictionModes).default('DETAILED'),
  confidence: z.enum(evaluationConfidences),
  formatVersion: z.string().min(1),
  summary: z.string(),
  assessmentSnapshot: publicPredictionAssessmentSnapshotSchema,
  publisherId: z.string().uuid(),
  deadlineAt: predictionDateTimeSchema,
  correctionReason: z.string().nullable(),
  marks: z.array(z.object({
    id: z.string().uuid(),
    versionId: z.string().uuid(),
    entryId: z.string().uuid(),
    horseId: z.string().uuid(),
    horseNumber: z.number().int().positive(),
    horseName: z.string(),
    mark: z.enum(finalMarks),
    reason: z.string()
  }).strict()),
  locked: z.literal(false)
}).strict();

export const publicPredictionVersionSchema = z.discriminatedUnion('locked', [
  publicPredictionLockedVersionSchema,
  publicPredictionFullVersionSchema
]);

export const publicPredictionResponseSchema = z.object({
  race: publicPredictionRaceSchema,
  latest: publicPredictionVersionSchema.nullable(),
  versions: z.array(publicPredictionVersionSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1).max(10000),
  limit: z.literal(20),
  locked: z.boolean()
}).strict();

export type PublicPredictionResponse = z.infer<typeof publicPredictionResponseSchema>;
export type PublicPredictionVersion = z.infer<typeof publicPredictionVersionSchema>;
export type PublicPredictionFullVersion = z.infer<typeof publicPredictionFullVersionSchema>;

// Dormant legacy calculations are retained for historical verification only.
const combinationSchema = z.array(z.number().int().min(1).max(18)).min(1).max(3);
const legacyBetSchema = z.object({ type: z.enum(betTypes), combinations: z.array(combinationSchema).min(1).max(100), amountPerPointYen: z.number().int().min(100).max(1_000_000).multipleOf(100) }).strict();
export const legacyPredictionDraftSchema = z.object({
  visibility: z.enum(publicationVisibilities).nullable(), confidence: z.enum(confidences).nullable(), stance: z.enum(stances).nullable(),
  summary: z.string().trim().max(5000), marks: z.array(markSchema).max(18), bets: z.array(legacyBetSchema).max(30)
}).strict();
export type LegacyPredictionDraft = z.infer<typeof legacyPredictionDraftSchema>;
export const pointsFor = (draft: LegacyPredictionDraft) => draft.bets.reduce((sum, bet) => sum + bet.combinations.length, 0);
export const totalYenFor = (draft: LegacyPredictionDraft) => draft.bets.reduce((sum, bet) => sum + bet.combinations.length * bet.amountPerPointYen, 0);
