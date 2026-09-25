import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@keiba/db';
import { jstDate } from '@keiba/domain';
import type { AppRequest } from './context';
import { AuthService } from './auth.service';
import { createDayPassAccess } from './day-pass-access';

type Tx = Prisma.TransactionClient;

@Injectable()
export class ReferralsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async createPending(tx: Tx, referredUserId: string, memberReferralCode?: string) {
    if (!memberReferralCode) return null;
    const referrer = await tx.user.findFirst({
      where: { referralCode: memberReferralCode.toUpperCase(), role: 'MEMBER', disabledAt: null, accountClosure: null },
      select: { id: true }
    });
    if (!referrer || referrer.id === referredUserId) return null;
    return tx.referral.create({ data: { referrerUserId: referrer.id, referredUserId } });
  }

  async qualify(tx: Tx, referredUserId: string, req: AppRequest) {
    const referral = await tx.referral.findUnique({ where: { referredUserId } });
    if (!referral || referral.status !== 'PENDING') return null;
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`referrals:${referral.referrerUserId}`}))::text`;
    const now = new Date();
    const changed = await tx.referral.updateMany({
      where: { id: referral.id, status: 'PENDING', qualifiedAt: null },
      data: { status: 'QUALIFIED', qualifiedAt: now }
    });
    if (changed.count !== 1) return null;
    await this.auth.audit(tx, req, 'REFERRAL_QUALIFIED', referral.id, '本人確認完了による友達紹介成立', {
      referrerUserId: referral.referrerUserId,
      referredUserId
    }, 'REFERRAL');
    const qualifiedCount = await tx.referral.count({ where: { referrerUserId: referral.referrerUserId, status: 'QUALIFIED' } });
    await this.grantReachedMilestones(tx, referral.referrerUserId, qualifiedCount, now, req);
    return { referralId: referral.id, referrerUserId: referral.referrerUserId, qualifiedCount };
  }

  private async grantReachedMilestones(tx: Tx, userId: string, qualifiedCount: number, now: Date, req: AppRequest) {
    const milestones = await tx.referralMilestone.findMany({
      where: { active: true, requiredReferralCount: { lte: qualifiedCount } },
      orderBy: [{ sortOrder: 'asc' }, { requiredReferralCount: 'asc' }]
    });
    for (const milestone of milestones) {
      const existing = await tx.referralReward.findUnique({ where: { userId_milestoneId: { userId, milestoneId: milestone.id } } });
      if (existing && existing.status !== 'INVALIDATED') continue;
      // Invalidated rewards may be restored only while their original claim
      // window is still alive. Re-reaching a milestone after that deadline
      // must not manufacture a fresh 60-day window.
      if (existing && existing.expiresAt <= now) continue;
      const expiresAt = existing?.expiresAt ?? new Date(now.getTime() + milestone.rewardValidityDays * 86400000);
      const reward = existing
        ? await tx.referralReward.update({ where: { id: existing.id }, data: { status: 'AVAILABLE', invalidatedAt: null, invalidatedReason: null } })
        : await tx.referralReward.create({ data: { userId, milestoneId: milestone.id, rewardType: milestone.rewardType, rewardQuantity: milestone.rewardQuantity, grantedAt: now, expiresAt } });
      await this.auth.audit(tx, req, 'REFERRAL_MILESTONE_REACHED', milestone.id, '友達紹介マイルストーン達成', {
        userId, requiredReferralCount: milestone.requiredReferralCount, qualifiedCount
      }, 'REFERRAL_MILESTONE');
      await this.auth.audit(tx, req, 'REFERRAL_REWARD_GRANTED', reward.id, '友達紹介特典付与', {
        userId, milestoneId: milestone.id, rewardType: milestone.rewardType, rewardQuantity: milestone.rewardQuantity, expiresAt: expiresAt.toISOString()
      }, 'REFERRAL_REWARD');
    }
  }

  async memberSummary(userId: string) {
    const now = new Date();
    await this.auth.db.referralReward.updateMany({
      where: { userId, status: 'AVAILABLE', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' }
    });
    const [user, qualifiedCount, milestones, rewards] = await Promise.all([
      this.auth.db.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } }),
      this.auth.db.referral.count({ where: { referrerUserId: userId, status: 'QUALIFIED' } }),
      this.auth.db.referralMilestone.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { requiredReferralCount: 'asc' }] }),
      this.auth.db.referralReward.findMany({ where: { userId }, include: { milestone: true, dayPass: { select: { raceDate: true, status: true } } }, orderBy: { grantedAt: 'desc' } })
    ]);
    const next = milestones.find(item => item.requiredReferralCount > qualifiedCount) ?? null;
    const base = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '');
    return {
      referralCode: user.referralCode,
      referralUrl: `${base}/register?invite=${encodeURIComponent(user.referralCode)}`,
      qualifiedCount,
      nextMilestone: next ? { requiredReferralCount: next.requiredReferralCount, remaining: next.requiredReferralCount - qualifiedCount, rewardType: next.rewardType, rewardQuantity: next.rewardQuantity } : null,
      milestones: milestones.map(item => ({ id: item.id, requiredReferralCount: item.requiredReferralCount, rewardType: item.rewardType, rewardQuantity: item.rewardQuantity, achieved: qualifiedCount >= item.requiredReferralCount })),
      rewards: rewards.map(reward => ({ id: reward.id, rewardType: reward.rewardType, rewardQuantity: reward.rewardQuantity, status: reward.status, grantedAt: reward.grantedAt, expiresAt: reward.expiresAt, usedAt: reward.usedAt, milestone: { requiredReferralCount: reward.milestone.requiredReferralCount }, dayPass: reward.dayPass }))
    };
  }

  async redeem(userId: string, rewardId: string, targetDate: string, req: AppRequest) {
    if (targetDate < jstDate(new Date())) throw new BadRequestException({ code: 'PAST_TARGET_DATE', message: '本日以降の日付を選んでください。' });
    const result = await this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`referral-reward:${rewardId}`}))::text`;
      const reward = await tx.referralReward.findUnique({ where: { id: rewardId } });
      if (!reward || reward.userId !== userId) throw new NotFoundException({ code: 'REFERRAL_REWARD_NOT_FOUND', message: '紹介特典を確認できません。' });
      const now = new Date();
      if (reward.status === 'REDEEMED') throw new ConflictException({ code: 'REFERRAL_REWARD_ALREADY_USED', message: 'この一日券は使用済みです。' });
      if (reward.status === 'INVALIDATED') throw new ConflictException({ code: 'REFERRAL_REWARD_INVALIDATED', message: 'この一日券は利用できません。' });
      if (reward.status === 'EXPIRED' || reward.expiresAt <= now) {
        if (reward.status === 'AVAILABLE') await tx.referralReward.update({ where: { id: reward.id }, data: { status: 'EXPIRED' } });
        return { expired: true as const };
      }
      if (reward.status !== 'AVAILABLE' || reward.rewardType !== 'DAY_PASS') throw new ConflictException({ code: 'REFERRAL_REWARD_UNAVAILABLE', message: 'この特典は利用できません。' });
      if (targetDate > jstDate(reward.expiresAt)) throw new ConflictException({ code: 'REFERRAL_REWARD_DATE_AFTER_EXPIRY', message: '一日券の有効期限内の日付を選んでください。' });
      if (await tx.dayPass.findUnique({ where: { userId_raceDate: { userId, raceDate: targetDate } } })) throw new ConflictException({ code: 'DAY_PASS_ALREADY_EXISTS', message: 'この対象日の一日利用権はすでにあります。' });
      const access = await createDayPassAccess(tx, { userId, raceDate: targetDate, priceYen: 0, provider: 'REFERRAL_REWARD', providerPassId: `referral-${reward.id}`, reason: 'REFERRAL_REWARD_DAY_PASS', actorId: userId, source: 'REFERRAL_REWARD' });
      await tx.referralReward.update({ where: { id: reward.id }, data: { status: 'REDEEMED', usedAt: now, dayPassId: access.pass.id } });
      await this.auth.audit(tx, req, 'REFERRAL_REWARD_REDEEMED', reward.id, '会員による紹介特典一日券の利用', { targetDate, dayPassId: access.pass.id }, 'REFERRAL_REWARD');
      return { rewardId: reward.id, dayPassId: access.pass.id, status: access.pass.status, startsAt: access.startsAt, endsAt: access.endsAt, waitingForPublication: access.waitingForPublication };
    });
    if ('expired' in result) throw new ConflictException({ code: 'REFERRAL_REWARD_EXPIRED', message: 'この一日券の有効期限は終了しています。' });
    return result;
  }

  async adminList(page: number, status: 'ALL' | 'PENDING' | 'QUALIFIED' | 'INVALIDATED') {
    const where = status === 'ALL' ? {} : { status };
    const [referralCount, qualifiedReferrers, grantedRewards, usedRewards, milestones, referrerGroups, filteredReferrers, recentReferrals] = await Promise.all([
      this.auth.db.referral.count({ where: { status: 'QUALIFIED' } }),
      this.auth.db.referral.groupBy({ by: ['referrerUserId'], where: { status: 'QUALIFIED' }, _count: { _all: true } }),
      this.auth.db.referralReward.count(),
      this.auth.db.referralReward.count({ where: { status: 'REDEEMED' } }),
      this.auth.db.referralMilestone.findMany({ orderBy: [{ sortOrder: 'asc' }, { requiredReferralCount: 'asc' }] }),
      this.auth.db.referral.groupBy({ by: ['referrerUserId'], where, _count: { _all: true }, orderBy: { _count: { referrerUserId: 'desc' } }, skip: (page - 1) * 20, take: 20 }),
      this.auth.db.referral.groupBy({ by: ['referrerUserId'], where }),
      this.auth.db.referral.findMany({ where, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, status: true, createdAt: true, qualifiedAt: true, invalidatedAt: true, referrer: { select: { displayName: true } }, referred: { select: { displayName: true, registrationMethod: true } } } })
    ]);
    const ids = referrerGroups.map(group => group.referrerUserId);
    const [users, qualifiedGroups, rewards] = await Promise.all([
      this.auth.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, referralCode: true } }),
      this.auth.db.referral.groupBy({ by: ['referrerUserId'], where: { referrerUserId: { in: ids }, status: 'QUALIFIED' }, _count: { _all: true } }),
      this.auth.db.referralReward.findMany({ where: { userId: { in: ids } }, select: { userId: true, status: true, milestone: { select: { requiredReferralCount: true } } } })
    ]);
    const qualifiedByUser = new Map(qualifiedGroups.map(group => [group.referrerUserId, group._count._all]));
    const userById = new Map(users.map(user => [user.id, user]));
    return {
      summary: {
        qualifiedReferrals: referralCount,
        referrers: qualifiedReferrers.length,
        milestoneAchievements: milestones.map(milestone => ({ requiredReferralCount: milestone.requiredReferralCount, users: qualifiedReferrers.filter(group => group._count._all >= milestone.requiredReferralCount).length })),
        rewardsGranted: grantedRewards,
        rewardsUsed: usedRewards
      },
      items: referrerGroups.map(group => {
        const user = userById.get(group.referrerUserId)!;
        const userRewards = rewards.filter(reward => reward.userId === group.referrerUserId);
        return { user, referralCount: qualifiedByUser.get(group.referrerUserId) ?? 0, achievedMilestones: userRewards.map(reward => reward.milestone.requiredReferralCount), rewardsGranted: userRewards.length };
      }),
      recentReferrals,
      page,
      total: filteredReferrers.length
    };
  }

  async adminDetail(id: string) {
    const referral = await this.auth.db.referral.findUnique({
      where: { id },
      include: { referrer: { select: { id: true, displayName: true, referralCode: true } }, referred: { select: { id: true, displayName: true, registrationMethod: true, createdAt: true } }, invalidatedBy: { select: { id: true, displayName: true } } }
    });
    if (!referral) throw new NotFoundException({ code: 'REFERRAL_NOT_FOUND', message: '紹介記録を確認できません。' });
    return referral;
  }

  async invalidate(id: string, reason: string, req: AppRequest) {
    return this.auth.db.$transaction(async tx => {
      const current = await tx.referral.findUnique({ where: { id } });
      if (!current) throw new NotFoundException({ code: 'REFERRAL_NOT_FOUND', message: '紹介記録を確認できません。' });
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`referrals:${current.referrerUserId}`}))::text`;
      const referral = await tx.referral.findUniqueOrThrow({ where: { id } });
      if (referral.status === 'INVALIDATED') return { id, status: referral.status, alreadyInvalidated: true };
      if (referral.status !== 'QUALIFIED' || !referral.qualifiedAt) throw new ConflictException({ code: 'REFERRAL_NOT_QUALIFIED', message: '成立済みの紹介だけを無効化できます。' });
      const now = new Date();
      await tx.referral.update({ where: { id }, data: { status: 'INVALIDATED', invalidatedAt: now, invalidatedReason: reason, invalidatedById: req.auth!.id } });
      const qualifiedCount = await tx.referral.count({ where: { referrerUserId: referral.referrerUserId, status: 'QUALIFIED' } });
      // Expiration wins over later invalidation. Otherwise an expired AVAILABLE
      // row could become INVALIDATED and then be revived on a future milestone.
      await tx.referralReward.updateMany({
        where: { userId: referral.referrerUserId, status: 'AVAILABLE', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' }
      });
      const rewards = await tx.referralReward.findMany({ where: { userId: referral.referrerUserId, status: 'AVAILABLE', expiresAt: { gt: now }, milestone: { requiredReferralCount: { gt: qualifiedCount } } } });
      for (const reward of rewards) await tx.referralReward.update({ where: { id: reward.id }, data: { status: 'INVALIDATED', invalidatedAt: now, invalidatedReason: `紹介無効化: ${reason}` } });
      await this.auth.audit(tx, req, 'REFERRAL_INVALIDATED', id, reason, { referrerUserId: referral.referrerUserId, qualifiedCount, unusedRewardsInvalidated: rewards.length }, 'REFERRAL');
      return { id, status: 'INVALIDATED', qualifiedCount, unusedRewardsInvalidated: rewards.length };
    });
  }
}
