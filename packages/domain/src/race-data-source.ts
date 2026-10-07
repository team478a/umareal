import { z } from 'zod';

export const raceDataModes = ['MANUAL', 'CSV', 'JRA_VAN', 'OTHER_PROVIDER'] as const;
export const raceDataModeSchema = z.enum(raceDataModes);
export type RaceDataMode = z.infer<typeof raceDataModeSchema>;

export const raceDataModeLabels: Record<RaceDataMode, string> = {
  MANUAL: '手動運用',
  CSV: 'CSV運用',
  JRA_VAN: 'JRA-VAN連携',
  OTHER_PROVIDER: 'その他Provider連携'
};

export function resolveRaceDataMode(value?: string): RaceDataMode {
  return raceDataModeSchema.parse(value ?? 'MANUAL');
}

export const manualEntryInputSchema = z.object({
  number: z.number().int().min(1).max(18),
  horseName: z.string().trim().min(1).max(80).refine(value => !/^[=+@\-\t\r]/.test(value), '数式や制御文字で始まる値は使用できません。')
}).strict();
export type ManualEntryInput = z.infer<typeof manualEntryInputSchema>;

export const manualEntryBatchInputSchema = z.array(manualEntryInputSchema).min(1).max(18).superRefine((entries, context) => {
  const numbers = new Set<number>();
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (numbers.has(entry.number)) context.addIssue({ code: 'custom', path: [index, 'number'], message: '同じ馬番が重複しています。' });
    numbers.add(entry.number);
    const normalizedName = entry.horseName.normalize('NFKC');
    if (names.has(normalizedName)) context.addIssue({ code: 'custom', path: [index, 'horseName'], message: '同じ馬名が重複しています。' });
    names.add(normalizedName);
  }
});
export type ManualEntryBatchInput = z.infer<typeof manualEntryBatchInputSchema>;

export type QuickManualEntryParseResult = { entries: ManualEntryInput[]; errors: { row: number; field: string; message: string }[] };

/** Parses a human-entered list containing `horse number, horse name` rows. No identity is inferred here. */
export function parseQuickManualEntryList(input: string): QuickManualEntryParseResult {
  const result: QuickManualEntryParseResult = { entries: [], errors: [] };
  if (input.length > 5000) return { ...result, errors: [{ row: 0, field: 'text', message: '貼り付け内容は5,000文字以内にしてください。' }] };
  const seenNumbers = new Set<number>();
  const seenNames = new Set<string>();
  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.includes('\t') ? '\t' : ',';
    const columns = line.split(separator).map(value => value.trim());
    if (columns.length !== 2) { result.errors.push({ row: index + 1, field: 'row', message: '「馬番,馬名」の2列で入力してください。' }); continue; }
    const parsed = manualEntryInputSchema.safeParse({ number: Number(columns[0]), horseName: columns[1] });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) result.errors.push({ row: index + 1, field: String(issue.path[0] ?? 'row'), message: issue.message });
      continue;
    }
    if (seenNumbers.has(parsed.data.number)) { result.errors.push({ row: index + 1, field: 'number', message: '同じ馬番が重複しています。' }); continue; }
    const normalizedName = parsed.data.horseName.normalize('NFKC');
    if (seenNames.has(normalizedName)) { result.errors.push({ row: index + 1, field: 'horseName', message: '同じ馬名が重複しています。' }); continue; }
    seenNumbers.add(parsed.data.number); seenNames.add(normalizedName); result.entries.push(parsed.data);
  }
  if (!result.entries.length && !result.errors.length) result.errors.push({ row: 0, field: 'text', message: '出走馬を1頭以上入力してください。' });
  if (result.entries.length > 18) result.errors.push({ row: 0, field: 'text', message: '1レースにつき18頭以内で入力してください。' });
  return result;
}

export const horseIdentityResolutionInputSchema = z.object({
  decision: z.enum(['MATCH_EXISTING', 'CONFIRM_DISTINCT']),
  resolvedHorseId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500)
}).strict();
export type HorseIdentityResolutionInput = z.infer<typeof horseIdentityResolutionInputSchema>;

const horseIdentityReviewHorseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  entryCount: z.number().int().nonnegative()
}).strict();

export const horseIdentityReviewQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  raceId: z.string().uuid().optional()
}).strict();
export type HorseIdentityReviewQuery = z.infer<typeof horseIdentityReviewQuerySchema>;

const horseIdentityReviewRaceSchema = z.object({
  raceId: z.string().uuid(),
  raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  venue: z.string().min(1),
  number: z.number().int().positive(),
  name: z.string().min(1),
  entryNumber: z.number().int().positive()
}).strict();

export const horseIdentityReviewResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    provider: z.string().min(1),
    observedName: z.string().min(1),
    matchStatus: z.enum(['POSSIBLE_DUPLICATE', 'UNRESOLVED']),
    createdAt: z.string().datetime({ offset: true }),
    provisionalHorse: horseIdentityReviewHorseSchema,
    candidates: z.array(horseIdentityReviewHorseSchema),
    races: z.array(horseIdentityReviewRaceSchema)
  }).strict()),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive()
}).strict();
export type HorseIdentityReviewResponse = z.infer<typeof horseIdentityReviewResponseSchema>;

export const horseIdentityResolutionResponseSchema = z.object({
  id: z.string().uuid(),
  decision: z.enum(['MATCH_EXISTING', 'CONFIRM_DISTINCT']),
  horseId: z.string().uuid(),
  matchStatus: z.literal('MATCHED')
}).strict();
export type HorseIdentityResolutionResponse = z.infer<typeof horseIdentityResolutionResponseSchema>;

export const horseIdentityCorrectionInputSchema = z.object({
  resolvedHorseId: z.string().uuid(),
  expectedHorseId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500)
}).strict();
export type HorseIdentityCorrectionInput = z.infer<typeof horseIdentityCorrectionInputSchema>;

const horseIdentityAuditSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(['HORSE_IDENTITY_RESOLVE', 'HORSE_IDENTITY_CORRECT']),
  reason: z.string(),
  actorRole: z.string().nullable(),
  actorDisplayName: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  requestId: z.string()
}).strict();

export const horseIdentityHistoryResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    provider: z.string().min(1),
    observedName: z.string().min(1),
    matchStatus: z.literal('MATCHED'),
    updatedAt: z.string().datetime({ offset: true }),
    currentHorse: horseIdentityReviewHorseSchema,
    candidates: z.array(horseIdentityReviewHorseSchema),
    history: z.array(horseIdentityAuditSchema)
  }).strict()),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive()
}).strict();
export type HorseIdentityHistoryResponse = z.infer<typeof horseIdentityHistoryResponseSchema>;

export const horseIdentityCorrectionResponseSchema = z.object({
  id: z.string().uuid(),
  horseId: z.string().uuid(),
  matchStatus: z.literal('MATCHED'),
  updatedAt: z.string().datetime({ offset: true })
}).strict();
export type HorseIdentityCorrectionResponse = z.infer<typeof horseIdentityCorrectionResponseSchema>;

export const raceOperationHistoryResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    action: z.string(),
    targetType: z.string(),
    targetId: z.string(),
    reason: z.string(),
    actorRole: z.string().nullable(),
    actorDisplayName: z.string().nullable(),
    sourceType: z.enum(['MANUAL', 'CSV', 'JRA_VAN', 'UMAREAL']),
    createdAt: z.string().datetime({ offset: true }),
    requestId: z.string()
  }).strict()),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive()
}).strict();
export type RaceOperationHistoryResponse = z.infer<typeof raceOperationHistoryResponseSchema>;

export const raceDataStatusSchema = z.object({
  mode: raceDataModeSchema,
  label: z.string(),
  operationalStatus: z.literal('NORMAL'),
  externalIntegration: z.enum(['NOT_USED', 'CONFIGURED_EXTERNALLY'])
}).strict();
export type RaceDataStatus = z.infer<typeof raceDataStatusSchema>;
