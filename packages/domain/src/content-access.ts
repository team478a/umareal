import { z } from 'zod';

export const paidContentKinds = ['PADDOCK', 'WIN5', 'RACE_PAPER', 'CONTENT'] as const;
export type PaidContentKind = typeof paidContentKinds[number];

const accessRowSchema = z.object({
  paddock: z.boolean(),
  win5: z.boolean(),
  racePaper: z.boolean(),
  content: z.boolean()
}).strict();

export const contentAccessPolicySchema = z.object({
  monthly: accessRowSchema,
  dayPass: accessRowSchema,
  manual: accessRowSchema
}).strict();

export type ContentAccessPolicy = z.infer<typeof contentAccessPolicySchema>;

export const defaultContentAccessPolicy: ContentAccessPolicy = {
  monthly: { paddock: true, win5: true, racePaper: true, content: true },
  dayPass: { paddock: true, win5: true, racePaper: true, content: false },
  manual: { paddock: true, win5: true, racePaper: true, content: true }
};

const closedContentAccessPolicy: ContentAccessPolicy = {
  monthly: { paddock: false, win5: false, racePaper: false, content: false },
  dayPass: { paddock: false, win5: false, racePaper: false, content: false },
  manual: { paddock: false, win5: false, racePaper: false, content: false }
};

export function parseContentAccessPolicy(value: unknown): ContentAccessPolicy {
  const parsed = contentAccessPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : closedContentAccessPolicy;
}

export function planCanReadContent(planCode: string, kind: PaidContentKind, policy: ContentAccessPolicy) {
  const key = kind === 'PADDOCK' ? 'paddock' : kind === 'WIN5' ? 'win5' : kind === 'RACE_PAPER' ? 'racePaper' : 'content';
  if (planCode === 'FOUNDER' || planCode === 'STANDARD') return policy.monthly[key];
  if (planCode === 'DAY_PASS') return policy.dayPass[key];
  if (planCode === 'MANUAL') return policy.manual[key];
  return false;
}
