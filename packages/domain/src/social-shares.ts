import { z } from 'zod';
import { predictionEvaluationStatuses, win5EvaluationStatuses, type PredictionEvaluationStatus, type Win5EvaluationStatus } from './evaluations';
import { dateSchema } from './races';

export type SocialShareDraft = {
  shareable: boolean;
  headline: string;
  text: string | null;
  resultLines: string[];
  blockedReason: string | null;
};

const socialShareDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminSocialShareItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['PADDOCK', 'WIN5']),
  targetDate: dateSchema,
  title: z.string().min(1),
  status: z.union([z.enum(predictionEvaluationStatuses), z.enum(win5EvaluationStatuses)]),
  resultVersion: z.number().int().positive(),
  predictionVersion: z.number().int().positive(),
  publishedAt: socialShareDateTimeSchema,
  confirmedAt: socialShareDateTimeSchema,
  path: z.string().regex(/^\/(?:races|win5)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  shareable: z.boolean(),
  headline: z.string().min(1),
  text: z.string().min(1).nullable(),
  resultLines: z.array(z.string().min(1)),
  blockedReason: z.string().min(1).nullable()
}).strict().superRefine((value, context) => {
  const allowedStatuses = value.kind === 'PADDOCK' ? predictionEvaluationStatuses : win5EvaluationStatuses;
  if (!(allowedStatuses as readonly string[]).includes(value.status)) {
    context.addIssue({ code: 'custom', path: ['status'], message: 'Evaluation status does not match the share kind.' });
  }
  const expectedPrefix = value.kind === 'PADDOCK' ? '/races/' : '/win5/';
  if (!value.path.startsWith(expectedPrefix)) {
    context.addIssue({ code: 'custom', path: ['path'], message: 'Result path does not match the share kind.' });
  }
  if (value.shareable && (value.text === null || value.resultLines.length === 0 || value.blockedReason !== null)) {
    context.addIssue({ code: 'custom', path: ['shareable'], message: 'Shareable result content is incomplete.' });
  }
  if (!value.shareable && (value.text !== null || value.resultLines.length > 0 || value.blockedReason === null)) {
    context.addIssue({ code: 'custom', path: ['shareable'], message: 'Blocked result content is inconsistent.' });
  }
});

export const adminSocialSharesResponseSchema = z.object({
  items: z.array(adminSocialShareItemSchema).max(100)
}).strict();

export type AdminSocialShareItem = z.infer<typeof adminSocialShareItemSchema>;
export type AdminSocialSharesResponse = z.infer<typeof adminSocialSharesResponseSchema>;

const blocked = (headline: string, reason: string): SocialShareDraft => ({ shareable: false, headline, text: null, resultLines: [], blockedReason: reason });

export function buildRaceSocialShare(input: {
  venue: string;
  raceNumber: number;
  raceName: string;
  status: PredictionEvaluationStatus;
}): SocialShareDraft {
  const race = `${input.venue}${input.raceNumber}R ${input.raceName}`;
  if (input.status === 'REVIEW_REQUIRED') return blocked(race, '評価結果が要確認のため共有できません。');
  if (input.status === 'CANCELED') return blocked(race, 'レース中止のため共有できません。');
  if (input.status === 'EXCLUDED') return blocked(race, '評価対象外のため共有できません。');

  const result = {
    PRIMARY_WIN: '本命馬が1着',
    PRIMARY_TOP2: '本命馬が2着',
    PRIMARY_TOP3: '本命馬が3着',
    WINNER_IN_RECOMMENDED: '勝ち馬を中心馬または相手候補として選出',
    WINNER_NOT_RECOMMENDED: '勝ち馬は候補外',
    SKIPPED: '見送り判断を公開'
  }[input.status];
  const headline = `${race} ${result}`;
  const resultLines = [race, result];
  return {
    shareable: true,
    headline,
    resultLines,
    text: `公開したパドック直前予想。\n${resultLines.join('\n')}\n公開時刻と全予想結果は、\nウマリアルで確認できます。`,
    blockedReason: null
  };
}

export function buildWin5SocialShare(input: {
  targetDate: string;
  status: Win5EvaluationStatus;
  recommendedLegs: number;
}): SocialShareDraft {
  const date = input.targetDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, year: string, month: string, day: string) => `${year}年${Number(month)}月${Number(day)}日`);
  if (input.status === 'REVIEW_REQUIRED') return blocked(`${date} WIN5評価結果`, '要確認の対象レースがあるため共有できません。');

  const result = input.status === 'WIN5_ALL_WINNERS_RECOMMENDED'
    ? '勝ち馬をすべて候補内に選出'
    : input.status === 'WIN5_PARTIAL'
      ? `5レース中${input.recommendedLegs}レースで勝ち馬を候補内に選出`
      : '5レースの勝ち馬は候補外';
  const headline = `WIN5対象5レース ${result}`;
  const resultLines = [`${date} WIN5対象5レース`, result];
  return {
    shareable: true,
    headline,
    resultLines,
    text: `前日に公開したWIN5紙面予想。\n${resultLines.join('\n')}\n公開時刻と全予想結果は、\nウマリアルで確認できます。`,
    blockedReason: null
  };
}
