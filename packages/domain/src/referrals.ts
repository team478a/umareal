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

export type MemberReferralMilestone = z.infer<typeof memberReferralMilestoneSchema>;
export type MemberReferralReward = z.infer<typeof memberReferralRewardSchema>;
export type MemberReferralRewards = z.infer<typeof memberReferralRewardsSchema>;
export type MemberReferralRewardRedeemResponse = z.infer<typeof memberReferralRewardRedeemResponseSchema>;
export type MemberReferralSummary = z.infer<typeof memberReferralSummarySchema>;
export type AdminReferralListResponse = z.infer<typeof adminReferralListResponseSchema>;
export type AdminReferralDetailResponse = z.infer<typeof adminReferralDetailResponseSchema>;
