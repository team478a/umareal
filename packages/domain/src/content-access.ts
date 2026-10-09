import { z } from 'zod';

export const paidContentKinds = ['PADDOCK', 'WIN5', 'RACE_PAPER', 'CONTENT', 'AI_RACE_GUIDE'] as const;
export type PaidContentKind = typeof paidContentKinds[number];

const accessRowSchema = z.object({
  paddock: z.boolean(),
  win5: z.boolean(),
  racePaper: z.boolean(),
  content: z.boolean(),
  aiRaceGuide: z.boolean().default(false)
}).strict();

export const contentAccessPolicySchema = z.object({
  monthly: accessRowSchema,
  dayPass: accessRowSchema,
  manual: accessRowSchema,
  referralMonthly: accessRowSchema.default({ paddock: true, win5: true, racePaper: true, content: true, aiRaceGuide: true })
}).strict();

export type ContentAccessPolicy = z.infer<typeof contentAccessPolicySchema>;

const freePredictionTrialSettingsBaseSchema = z.object({
  enabled: z.boolean(),
  endsAt: z.string().datetime({ offset: true }).nullable()
}).strict();

export const freePredictionTrialSettingsSchema = freePredictionTrialSettingsBaseSchema.superRefine((value, context) => {
  if (value.enabled && !value.endsAt) context.addIssue({ code: 'custom', path: ['endsAt'], message: '無料全文公開を有効にする場合は終了日時が必要です。' });
  if (!value.enabled && value.endsAt) context.addIssue({ code: 'custom', path: ['endsAt'], message: '無料全文公開を無効にする場合は終了日時を空にしてください。' });
});

export const freePredictionTrialResponseSchema = freePredictionTrialSettingsBaseSchema.extend({
  active: z.boolean(),
  contentKinds: z.tuple([z.literal('WIN5'), z.literal('PADDOCK')])
}).strict();

export type FreePredictionTrialSettings = z.infer<typeof freePredictionTrialSettingsSchema>;

export function canUseFreePredictionTrial(input: {
  now: Date;
  registeredMember: boolean;
  contentKind: PaidContentKind;
  enabled: boolean;
  endsAt: Date | null;
}) {
  return input.registeredMember && input.enabled && !!input.endsAt && input.now < input.endsAt && ['WIN5', 'PADDOCK'].includes(input.contentKind);
}

export const defaultContentAccessPolicy: ContentAccessPolicy = {
  monthly: { paddock: true, win5: true, racePaper: true, content: true, aiRaceGuide: true },
  dayPass: { paddock: true, win5: true, racePaper: true, content: false, aiRaceGuide: true },
  manual: { paddock: true, win5: true, racePaper: true, content: true, aiRaceGuide: true },
  referralMonthly: { paddock: true, win5: true, racePaper: true, content: true, aiRaceGuide: true }
};

const closedContentAccessPolicy: ContentAccessPolicy = {
  monthly: { paddock: false, win5: false, racePaper: false, content: false, aiRaceGuide: false },
  dayPass: { paddock: false, win5: false, racePaper: false, content: false, aiRaceGuide: false },
  manual: { paddock: false, win5: false, racePaper: false, content: false, aiRaceGuide: false },
  referralMonthly: { paddock: false, win5: false, racePaper: false, content: false, aiRaceGuide: false }
};

export function parseContentAccessPolicy(value: unknown): ContentAccessPolicy {
  const parsed = contentAccessPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : closedContentAccessPolicy;
}

export function planCanReadContent(planCode: string, kind: PaidContentKind, policy: ContentAccessPolicy) {
  const key = kind === 'PADDOCK' ? 'paddock' : kind === 'WIN5' ? 'win5' : kind === 'RACE_PAPER' ? 'racePaper' : kind === 'AI_RACE_GUIDE' ? 'aiRaceGuide' : 'content';
  if (planCode === 'FOUNDER' || planCode === 'STANDARD') return policy.monthly[key];
  if (planCode === 'DAY_PASS') return policy.dayPass[key];
  if (planCode === 'MANUAL') return policy.manual[key];
  if (planCode === 'REFERRAL_MONTHLY_ACCESS') return policy.referralMonthly[key];
  return false;
}
