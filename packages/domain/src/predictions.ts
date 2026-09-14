import { z } from 'zod';
export const publicationVisibilities = ['FREE', 'PAID'] as const;
export const confidences = ['S', 'A', 'B', 'C'] as const;
export const stances = ['BET', 'NORMAL', 'SMALL', 'SKIP'] as const;
export const finalMarks = ['HONMEI', 'TAIKO', 'TANANA', 'RENKA', 'ANA', 'DANGER'] as const;
export const betTypes = ['WIN', 'PLACE', 'QUINELLA', 'EXACTA', 'WIDE', 'TRIO', 'TRIFECTA'] as const;
const markSchema = z.object({ entryId: z.string().uuid(), mark: z.enum(finalMarks), reason: z.string().trim().max(500) }).strict();
const combinationSchema = z.array(z.number().int().min(1).max(18)).min(1).max(3);
const betSchema = z.object({ type: z.enum(betTypes), combinations: z.array(combinationSchema).min(1).max(100), amountPerPointYen: z.number().int().min(100).max(1_000_000).multipleOf(100) }).strict();
export const predictionDraftSchema = z.object({
  visibility: z.enum(publicationVisibilities).nullable(), confidence: z.enum(confidences).nullable(), stance: z.enum(stances).nullable(),
  summary: z.string().trim().max(5000), marks: z.array(markSchema).max(18), bets: z.array(betSchema).max(30)
}).strict().superRefine((value, context) => {
  const entries = new Set<string>();
  for (const [index, mark] of value.marks.entries()) {
    if (entries.has(mark.entryId)) context.addIssue({ code: 'custom', path: ['marks', index, 'entryId'], message: '同じ馬に複数の最終印は設定できません。' });
    entries.add(mark.entryId);
  }
  const combinations = new Set<string>();
  for (const [betIndex, bet] of value.bets.entries()) for (const [combinationIndex, combination] of bet.combinations.entries()) {
    const arity = ['WIN', 'PLACE'].includes(bet.type) ? 1 : ['QUINELLA', 'EXACTA', 'WIDE'].includes(bet.type) ? 2 : 3;
    if (combination.length !== arity || new Set(combination).size !== combination.length) context.addIssue({ code: 'custom', path: ['bets', betIndex, 'combinations', combinationIndex], message: `${bet.type}の組合せを確認してください。` });
    const ordered = ['EXACTA', 'TRIFECTA'].includes(bet.type) ? combination : [...combination].sort((a, b) => a - b);
    const key = `${bet.type}:${ordered.join('-')}`;
    if (combinations.has(key)) context.addIssue({ code: 'custom', path: ['bets', betIndex, 'combinations', combinationIndex], message: '同じ買い目が重複しています。' });
    combinations.add(key);
  }
  if (value.bets.reduce((sum, bet) => sum + bet.combinations.length * bet.amountPerPointYen, 0) > 2_000_000_000) context.addIssue({ code: 'custom', path: ['bets'], message: '想定購入総額が保存上限を超えています。' });
});
export type PredictionDraft = z.infer<typeof predictionDraftSchema>;
export const emptyPredictionDraft: PredictionDraft = { visibility: null, confidence: null, stance: null, summary: '', marks: [], bets: [] };
export const publishablePredictionSchema = predictionDraftSchema.superRefine((value, context) => {
  if (!value.visibility) context.addIssue({ code: 'custom', path: ['visibility'], message: '公開範囲を選択してください。' });
  if (!value.confidence) context.addIssue({ code: 'custom', path: ['confidence'], message: '信頼度を選択してください。' });
  if (!value.stance) context.addIssue({ code: 'custom', path: ['stance'], message: '勝負判断を選択してください。' });
  if (!value.summary) context.addIssue({ code: 'custom', path: ['summary'], message: '総評を入力してください。' });
  if (value.stance === 'SKIP' && value.bets.length) context.addIssue({ code: 'custom', path: ['bets'], message: '見送り時は買い目を設定できません。' });
  if (value.stance !== 'SKIP' && value.marks.filter(mark => mark.mark === 'HONMEI').length !== 1) context.addIssue({ code: 'custom', path: ['marks'], message: '見送り以外は本命を1頭設定してください。' });
});
export const predictionSaveSchema = z.object({ draft: predictionDraftSchema, revision: z.number().int().min(0), raceRevision: z.number().int().positive(), mutationId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict();
export const publishPreviewSchema = z.object({ predictionRevision: z.number().int().positive(), raceRevision: z.number().int().positive(), correctionReason: z.string().trim().max(500).default('') }).strict();
export const pointsFor = (draft: PredictionDraft) => draft.bets.reduce((sum, bet) => sum + bet.combinations.length, 0);
export const totalYenFor = (draft: PredictionDraft) => draft.bets.reduce((sum, bet) => sum + bet.combinations.length * bet.amountPerPointYen, 0);
