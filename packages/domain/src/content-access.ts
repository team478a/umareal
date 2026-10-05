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
  manual: accessRowSchema
}).strict();

export type ContentAccessPolicy = z.infer<typeof contentAccessPolicySchema>;

export const defaultContentAccessPolicy: ContentAccessPolicy = {
  monthly: { paddock: true, win5: true, racePaper: true, content: true, aiRaceGuide: true },
  dayPass: { paddock: true, win5: true, racePaper: true, content: false, aiRaceGuide: true },
  manual: { paddock: true, win5: true, racePaper: true, content: true, aiRaceGuide: true }
};

const closedContentAccessPolicy: ContentAccessPolicy = {
  monthly: { paddock: false, win5: false, racePaper: false, content: false, aiRaceGuide: false },
  dayPass: { paddock: false, win5: false, racePaper: false, content: false, aiRaceGuide: false },
  manual: { paddock: false, win5: false, racePaper: false, content: false, aiRaceGuide: false }
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
  return false;
}
