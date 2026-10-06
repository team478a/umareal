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

export const raceDataStatusSchema = z.object({
  mode: raceDataModeSchema,
  label: z.string(),
  operationalStatus: z.literal('NORMAL'),
  externalIntegration: z.enum(['NOT_USED', 'CONFIGURED_EXTERNALLY'])
}).strict();
export type RaceDataStatus = z.infer<typeof raceDataStatusSchema>;
