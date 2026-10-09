import { z } from 'zod';

export const memberReferralCodeSchema = z.string().trim().min(8).max(32).regex(/^[A-Za-z0-9_-]+$/).transform(value => value.toUpperCase());

// An invite is optional registration context, not a credential. Unknown or
// tampered values must fall back to ordinary registration without revealing
// whether a code exists. A modest input cap still protects the public API from
// unbounded payloads.
export const memberReferralCodeInputSchema = z.string().max(256).transform(value => {
  const parsed = memberReferralCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}).optional();

export const referralRewardRedeemSchema = z.object({ targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().superRefine((value, context) => {
  const parsed = new Date(`${value.targetDate}T00:00:00+09:00`);
  const time = parsed.getTime();
  const roundTrip = Number.isFinite(time) ? new Date(time + 9 * 3600000).toISOString().slice(0, 10) : null;
  if (roundTrip !== value.targetDate) context.addIssue({ code: 'custom', path: ['targetDate'], message: '有効な利用日を指定してください。' });
});

export const adminReferralListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  status: z.enum(['ALL', 'PENDING', 'QUALIFIED', 'INVALIDATED']).default('ALL')
});

export const referralInvalidateSchema = z.object({
  reason: z.string().trim().min(1).max(500)
}).strict();

const referralResponseDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const memberReferralMilestoneSchema = z.object({
  id: z.string().uuid(),
  requiredReferralCount: z.number().int().positive(),
  rewardType: z.string().min(1),
  rewardQuantity: z.number().int().positive(),
  achieved: z.boolean()
}).strict();

export const memberReferralRewardSchema = z.object({
  id: z.string().uuid(),
  rewardType: z.string().min(1),
  rewardQuantity: z.number().int().positive(),
  status: z.enum(['AVAILABLE', 'REDEEMED', 'EXPIRED', 'INVALIDATED']),
  grantedAt: referralResponseDateTimeSchema,
  expiresAt: referralResponseDateTimeSchema,
  usedAt: referralResponseDateTimeSchema.nullable(),
  milestone: z.object({ requiredReferralCount: z.number().int().positive() }).strict(),
  dayPass: z.object({
    raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.string().min(1)
  }).strict().nullable()
}).strict();

export const memberReferralRewardsSchema = z.object({
  items: z.array(memberReferralRewardSchema)
}).strict();

export const memberReferralRewardRedeemResponseSchema = z.object({
  rewardId: z.string().uuid(),
  dayPassId: z.string().uuid(),
  status: z.enum(['PENDING', 'ACTIVE']),
  startsAt: referralResponseDateTimeSchema.nullable(),
  endsAt: referralResponseDateTimeSchema,
  waitingForPublication: z.boolean()
}).strict();

export const memberReferralSummarySchema = z.object({
  referralCode: z.string().min(8).max(32).regex(/^[A-Z0-9_-]+$/),
  referralUrl: z.string().min(1),
  qualifiedCount: z.number().int().nonnegative(),
  nextMilestone: z.object({
    requiredReferralCount: z.number().int().positive(),
    remaining: z.number().int().positive(),
    rewardType: z.string().min(1),
    rewardQuantity: z.number().int().positive()
  }).strict().nullable(),
  milestones: z.array(memberReferralMilestoneSchema),
  rewards: z.array(memberReferralRewardSchema)
}).strict();

export const adminReferralListResponseSchema = z.object({
  summary: z.object({
    qualifiedReferrals: z.number().int().nonnegative(),
    referrers: z.number().int().nonnegative(),
    milestoneAchievements: z.array(z.object({
      requiredReferralCount: z.number().int().positive(),
      users: z.number().int().nonnegative()
    }).strict()),
    rewardsGranted: z.number().int().nonnegative(),
    rewardsUsed: z.number().int().nonnegative()
  }).strict(),
  items: z.array(z.object({
    user: z.object({
      id: z.string().uuid(),
      displayName: z.string().min(1),
      referralCode: z.string().min(8).max(32).regex(/^[A-Z0-9_-]+$/)
    }).strict(),
    referralCount: z.number().int().nonnegative(),
    achievedMilestones: z.array(z.number().int().positive()),
    rewardsGranted: z.number().int().nonnegative()
  }).strict()),
  recentReferrals: z.array(z.object({
    id: z.string().uuid(),
    status: z.enum(['PENDING', 'QUALIFIED', 'INVALIDATED']),
    createdAt: referralResponseDateTimeSchema,
    qualifiedAt: referralResponseDateTimeSchema.nullable(),
    invalidatedAt: referralResponseDateTimeSchema.nullable(),
    referrer: z.object({ displayName: z.string().min(1) }).strict(),
    referred: z.object({
      displayName: z.string().min(1),
      registrationMethod: z.string().min(1)
    }).strict()
  }).strict()),
  page: z.number().int().positive(),
  total: z.number().int().nonnegative()
}).strict();

export const adminReferralDetailResponseSchema = z.object({
  id: z.string().uuid(),
  referrerUserId: z.string().uuid(),
  referredUserId: z.string().uuid(),
  status: z.enum(['PENDING', 'QUALIFIED', 'INVALIDATED']),
  qualifiedAt: referralResponseDateTimeSchema.nullable(),
  invalidatedAt: referralResponseDateTimeSchema.nullable(),
  invalidatedReason: z.string().nullable(),
  invalidatedById: z.string().uuid().nullable(),
  createdAt: referralResponseDateTimeSchema,
  referrer: z.object({
    id: z.string().uuid(),
    displayName: z.string().min(1),
    referralCode: z.string().min(8).max(32).regex(/^[A-Z0-9_-]+$/)
  }).strict(),
  referred: z.object({
    id: z.string().uuid(),
    displayName: z.string().min(1),
    registrationMethod: z.string().min(1),
    createdAt: referralResponseDateTimeSchema
  }).strict(),
  invalidatedBy: z.object({
    id: z.string().uuid(),
    displayName: z.string().min(1)
  }).strict().nullable()
}).strict();

export const adminReferralInvalidateResponseSchema = z.union([
  z.object({
    id: z.string().uuid(),
    status: z.literal('INVALIDATED'),
    qualifiedCount: z.number().int().nonnegative(),
    unusedRewardsInvalidated: z.number().int().nonnegative()
  }).strict(),
  z.object({
    id: z.string().uuid(),
    status: z.literal('INVALIDATED'),
    alreadyInvalidated: z.literal(true)
  }).strict()
]);

export type MemberReferralMilestone = z.infer<typeof memberReferralMilestoneSchema>;
export type MemberReferralReward = z.infer<typeof memberReferralRewardSchema>;
export type MemberReferralRewards = z.infer<typeof memberReferralRewardsSchema>;
export type MemberReferralRewardRedeemResponse = z.infer<typeof memberReferralRewardRedeemResponseSchema>;
export type MemberReferralSummary = z.infer<typeof memberReferralSummarySchema>;
export type AdminReferralListResponse = z.infer<typeof adminReferralListResponseSchema>;
export type AdminReferralDetailResponse = z.infer<typeof adminReferralDetailResponseSchema>;
export type AdminReferralInvalidateResponse = z.infer<typeof adminReferralInvalidateResponseSchema>;

export const referralBenefitTypes = ['DAY_PASS', 'MONTHLY_ACCESS', 'LIMITED_CONTENT'] as const;
export const referralBenefitTypeSchema = z.enum(referralBenefitTypes);

const referralBenefitConfigBaseSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000),
  requiredReferralCount: z.number().int().min(1).max(100000),
  rewardType: referralBenefitTypeSchema,
  quantity: z.number().int().min(1).max(100),
  claimValidityDays: z.number().int().min(1).max(3650),
  accessDays: z.number().int().min(1).max(3650).nullable(),
  distributionStartsAt: z.string().datetime({ offset: true }).nullable(),
  distributionEndsAt: z.string().datetime({ offset: true }).nullable(),
  published: z.boolean(),
  grantEnabled: z.boolean(),
  sortOrder: z.number().int().min(0).max(100000),
  memberGuidance: z.string().trim().min(1).max(1000),
  usageTerms: z.string().trim().min(1).max(2000),
  contentItemIds: z.array(z.string().uuid()).max(50)
}).strict();

export const referralBenefitConfigSchema = referralBenefitConfigBaseSchema.superRefine((value, context) => {
  if (value.grantEnabled && !value.published) context.addIssue({ code: 'custom', path: ['grantEnabled'], message: '新規付与を有効にする場合は公開も有効にしてください。' });
  if (value.distributionStartsAt && value.distributionEndsAt && new Date(value.distributionEndsAt) <= new Date(value.distributionStartsAt)) context.addIssue({ code: 'custom', path: ['distributionEndsAt'], message: '配布終了は配布開始より後にしてください。' });
  if (value.rewardType === 'MONTHLY_ACCESS' && !value.accessDays) context.addIssue({ code: 'custom', path: ['accessDays'], message: '月額相当特典には閲覧日数が必要です。' });
  if (value.rewardType !== 'MONTHLY_ACCESS' && value.accessDays !== null) context.addIssue({ code: 'custom', path: ['accessDays'], message: '月額相当特典以外に閲覧日数は設定できません。' });
  if (value.rewardType === 'LIMITED_CONTENT' && value.quantity !== 1) context.addIssue({ code: 'custom', path: ['quantity'], message: '限定コンテンツ特典の数量は1にしてください。' });
  if (value.rewardType === 'LIMITED_CONTENT' && value.contentItemIds.length === 0) context.addIssue({ code: 'custom', path: ['contentItemIds'], message: '限定コンテンツを1件以上選択してください。' });
  if (value.rewardType !== 'LIMITED_CONTENT' && value.contentItemIds.length > 0) context.addIssue({ code: 'custom', path: ['contentItemIds'], message: '限定コンテンツ特典以外にコンテンツは指定できません。' });
});

export const adminReferralBenefitCreateSchema = z.object({
  expectedRevision: z.literal(0),
  reason: z.string().trim().min(1).max(500),
  config: referralBenefitConfigSchema
}).strict();

export const adminReferralBenefitVersionCreateSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  config: referralBenefitConfigSchema
}).strict();

const referralBenefitContentSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  kind: z.enum(['ARTICLE', 'VIDEO', 'AUDIO']),
  status: z.string().min(1)
}).strict();

export const adminReferralBenefitVersionSchema = referralBenefitConfigBaseSchema.omit({ contentItemIds: true }).extend({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  changeReason: z.string().min(1),
  createdAt: referralResponseDateTimeSchema,
  createdBy: z.object({ id: z.string().uuid(), displayName: z.string().min(1) }).strict(),
  contents: z.array(referralBenefitContentSchema)
}).strict();

export const adminReferralBenefitSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  createdAt: referralResponseDateTimeSchema,
  latest: adminReferralBenefitVersionSchema,
  versions: z.array(adminReferralBenefitVersionSchema)
}).strict();

export const adminReferralBenefitsResponseSchema = z.object({
  items: z.array(adminReferralBenefitSchema),
  contentOptions: z.array(referralBenefitContentSchema)
}).strict();

export const adminReferralBenefitMutationResponseSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  version: z.number().int().positive()
}).strict();

export const adminReferralBenefitGrantListQuerySchema = z.object({
  status: z.enum(['ALL', 'AVAILABLE', 'REDEEMED', 'EXPIRED', 'INVALIDATED']).default('ALL'),
  page: z.coerce.number().int().min(1).max(100000).default(1)
}).strict();

export const referralBenefitGrantSchema = z.object({
  id: z.string().uuid(),
  rewardType: referralBenefitTypeSchema,
  unitNo: z.number().int().positive(),
  status: z.enum(['AVAILABLE', 'REDEEMED', 'EXPIRED', 'INVALIDATED']),
  grantedAt: referralResponseDateTimeSchema,
  expiresAt: referralResponseDateTimeSchema,
  usedAt: referralResponseDateTimeSchema.nullable(),
  benefit: z.object({ id: z.string().uuid(), name: z.string().min(1), requiredReferralCount: z.number().int().positive(), version: z.number().int().positive() }).strict(),
  member: z.object({ id: z.string().uuid(), displayName: z.string().min(1) }).strict().optional()
}).strict();

export const adminReferralBenefitGrantsResponseSchema = z.object({
  items: z.array(referralBenefitGrantSchema),
  page: z.number().int().positive(),
  total: z.number().int().nonnegative()
}).strict();

export const memberReferralBenefitGrantsResponseSchema = z.object({
  items: z.array(referralBenefitGrantSchema)
}).strict();

export const referralBenefitGrantRedeemSchema = z.object({
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()
}).strict();

export const referralBenefitGrantRedeemResponseSchema = z.discriminatedUnion('rewardType', [
  z.object({
    grantId: z.string().uuid(),
    rewardType: z.literal('DAY_PASS'),
    dayPassId: z.string().uuid(),
    status: z.enum(['PENDING', 'ACTIVE']),
    startsAt: referralResponseDateTimeSchema.nullable(),
    endsAt: referralResponseDateTimeSchema,
    waitingForPublication: z.boolean()
  }).strict(),
  z.object({
    grantId: z.string().uuid(),
    rewardType: z.literal('MONTHLY_ACCESS'),
    entitlementId: z.string().uuid(),
    startsAt: referralResponseDateTimeSchema,
    endsAt: referralResponseDateTimeSchema
  }).strict()
]);

export type ReferralBenefitType = z.infer<typeof referralBenefitTypeSchema>;
export type ReferralBenefitConfig = z.infer<typeof referralBenefitConfigSchema>;
export type AdminReferralBenefitCreate = z.infer<typeof adminReferralBenefitCreateSchema>;
export type AdminReferralBenefitVersionCreate = z.infer<typeof adminReferralBenefitVersionCreateSchema>;
export type AdminReferralBenefitsResponse = z.infer<typeof adminReferralBenefitsResponseSchema>;
export type AdminReferralBenefitMutationResponse = z.infer<typeof adminReferralBenefitMutationResponseSchema>;
export type AdminReferralBenefitGrantsResponse = z.infer<typeof adminReferralBenefitGrantsResponseSchema>;
export type MemberReferralBenefitGrantsResponse = z.infer<typeof memberReferralBenefitGrantsResponseSchema>;
export type ReferralBenefitGrantRedeemResponse = z.infer<typeof referralBenefitGrantRedeemResponseSchema>;
