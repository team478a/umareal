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

export const horseIdentityReviewResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    provider: z.string().min(1),
    observedName: z.string().min(1),
    matchStatus: z.enum(['POSSIBLE_DUPLICATE', 'UNRESOLVED']),
    createdAt: z.string().datetime({ offset: true }),
    provisionalHorse: horseIdentityReviewHorseSchema,
    candidates: z.array(horseIdentityReviewHorseSchema)
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
