import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@keiba/db';
import type { AdminReferralBenefitCreate, AdminReferralBenefitVersionCreate, ReferralBenefitConfig } from '@keiba/domain';
import { jstDate } from '@keiba/domain';
import type { AppRequest } from './context';
import { AuthService } from './auth.service';
import { createDayPassAccess } from './day-pass-access';
import { hashToken } from './security';

type Tx = Prisma.TransactionClient;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class ReferralBenefitsService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async validateContents(tx: Tx, config: ReferralBenefitConfig) {
    if (!config.contentItemIds.length) return;
    const count = await tx.contentItem.count({ where: { id: { in: config.contentItemIds } } });
    if (count !== config.contentItemIds.length) throw new ConflictException({ code: 'REFERRAL_BENEFIT_CONTENT_NOT_FOUND', message: '選択したコンテンツを確認できません。最新の一覧から選び直してください。' });
  }

  private versionData(config: ReferralBenefitConfig, reason: string, actorId: string) {
    return {
      name: config.name,
      description: config.description,
      requiredReferralCount: config.requiredReferralCount,
      rewardType: config.rewardType,
      quantity: config.quantity,
      claimValidityDays: config.claimValidityDays,
      accessDays: config.accessDays,
      distributionStartsAt: config.distributionStartsAt ? new Date(config.distributionStartsAt) : null,
      distributionEndsAt: config.distributionEndsAt ? new Date(config.distributionEndsAt) : null,
      published: config.published,
      grantEnabled: config.grantEnabled,
      sortOrder: config.sortOrder,
      memberGuidance: config.memberGuidance,
      usageTerms: config.usageTerms,
      changeReason: reason,
      createdById: actorId,
      contents: { create: config.contentItemIds.map(contentItemId => ({ contentItemId })) }
    };
  }

  private mapVersion(version: {
    id: string; version: number; name: string; description: string; requiredReferralCount: number; rewardType: string; quantity: number;
    claimValidityDays: number; accessDays: number | null; distributionStartsAt: Date | null; distributionEndsAt: Date | null;
    published: boolean; grantEnabled: boolean; sortOrder: number; memberGuidance: string; usageTerms: string; changeReason: string;
    createdAt: Date; createdBy: { id: string; displayName: string };
    contents: Array<{ contentItem: { id: string; title: string; kind: string; status: string } }>;
  }) {
    return {
      id: version.id,
      version: version.version,
      name: version.name,
      description: version.description,
      requiredReferralCount: version.requiredReferralCount,
      rewardType: version.rewardType,
      quantity: version.quantity,
      claimValidityDays: version.claimValidityDays,
      accessDays: version.accessDays,
      distributionStartsAt: version.distributionStartsAt?.toISOString() ?? null,
      distributionEndsAt: version.distributionEndsAt?.toISOString() ?? null,
      published: version.published,
      grantEnabled: version.grantEnabled,
      sortOrder: version.sortOrder,
      memberGuidance: version.memberGuidance,
      usageTerms: version.usageTerms,
      changeReason: version.changeReason,
      createdAt: version.createdAt,
      createdBy: version.createdBy,
      contents: version.contents.map(item => item.contentItem)
    };
  }

  async adminList() {
    const include = {
      createdBy: { select: { id: true, displayName: true } },
      contents: { include: { contentItem: { select: { id: true, title: true, kind: true, status: true } } } }
    } as const;
    const [benefits, contentOptions] = await Promise.all([
      this.auth.db.referralBenefit.findMany({
        include: { versions: { include, orderBy: { version: 'desc' } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      }),
      this.auth.db.contentItem.findMany({ select: { id: true, title: true, kind: true, status: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 100 })
    ]);
    return {
      items: benefits.flatMap(benefit => benefit.versions[0] ? [{ id: benefit.id, revision: benefit.revision, createdAt: benefit.createdAt, latest: this.mapVersion(benefit.versions[0]), versions: benefit.versions.map(version => this.mapVersion(version)) }] : []),
      contentOptions
    };
  }

  private async idempotent<T>(key: string, requestHash: string, work: (tx: Tx) => Promise<T>) {
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
      const previous = await tx.idempotencyKey.findUnique({ where: { key } });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じリクエストキーが異なる内容で使用されています。' });
        return previous.response as T;
      }
      const response = await work(tx);
      await tx.idempotencyKey.create({ data: { key, requestHash, response: json(response) } });
      return response;
    }, { timeout: 20000, maxWait: 10000 });
  }

  async create(actorId: string, input: AdminReferralBenefitCreate, requestKey: string, req: AppRequest) {
    const key = `referral-benefit-create:${actorId}:${requestKey}`;
    const requestHash = hashToken(JSON.stringify(input));
    return this.idempotent(key, requestHash, async tx => {
      await this.validateContents(tx, input.config);
      const benefit = await tx.referralBenefit.create({
        data: { createdById: actorId, versions: { create: { version: 1, ...this.versionData(input.config, input.reason, actorId) } } },
        include: { versions: { select: { id: true, version: true } } }
      });
      await this.auth.audit(tx, req, 'REFERRAL_BENEFIT_CREATED', benefit.id, input.reason, { after: input.config, version: 1 }, 'REFERRAL_BENEFIT');
      return { id: benefit.id, revision: benefit.revision, version: benefit.versions[0]!.version };
    });
  }

  async createVersion(benefitId: string, actorId: string, input: AdminReferralBenefitVersionCreate, requestKey: string, req: AppRequest) {
    const key = `referral-benefit-version:${actorId}:${requestKey}`;
    const requestHash = hashToken(JSON.stringify({ benefitId, ...input }));
    return this.idempotent(key, requestHash, async tx => {
      await tx.$queryRaw`SELECT id FROM referral_benefits WHERE id = ${benefitId}::uuid FOR UPDATE`;
      const benefit = await tx.referralBenefit.findUnique({ where: { id: benefitId }, include: { versions: { orderBy: { version: 'desc' }, take: 1, include: { contents: true } } } });
      if (!benefit?.versions[0]) throw new NotFoundException({ code: 'REFERRAL_BENEFIT_NOT_FOUND', message: '紹介特典を確認できません。' });
      if (benefit.revision !== input.expectedRevision) throw new ConflictException({ code: 'REFERRAL_BENEFIT_CONFLICT', message: '設定が変更されています。再読み込みしてください。' });
      await this.validateContents(tx, input.config);
      const before = benefit.versions[0];
      const nextVersion = before.version + 1;
      await tx.referralBenefitVersion.create({ data: { benefitId, version: nextVersion, ...this.versionData(input.config, input.reason, actorId) } });
      const updated = await tx.referralBenefit.update({ where: { id: benefitId }, data: { revision: { increment: 1 } } });
      await this.auth.audit(tx, req, 'REFERRAL_BENEFIT_VERSION_CREATED', benefitId, input.reason, {
        before: { version: before.version, name: before.name, requiredReferralCount: before.requiredReferralCount, rewardType: before.rewardType, quantity: before.quantity, claimValidityDays: before.claimValidityDays, accessDays: before.accessDays, published: before.published, grantEnabled: before.grantEnabled, contentItemIds: before.contents.map(item => item.contentItemId) },
        after: { version: nextVersion, ...input.config }
      }, 'REFERRAL_BENEFIT');
      return { id: benefitId, revision: updated.revision, version: nextVersion };
    });
  }

  async recordQualification(tx: Tx, input: { referralId: string; referrerUserId: string; qualifiedCount: number; achievedAt: Date }, req: AppRequest) {
    const previousQualifiedCount = input.qualifiedCount - 1;
    const achievement = await tx.referralAchievement.create({ data: { referrerUserId: input.referrerUserId, referralId: input.referralId, previousQualifiedCount, qualifiedCount: input.qualifiedCount, achievedAt: input.achievedAt } });
    const benefits = await tx.referralBenefit.findMany({
      include: { versions: { orderBy: { version: 'desc' }, take: 1, include: { contents: true } } }
    });
    let granted = 0;
    for (const benefit of benefits) {
      const version = benefit.versions[0];
      if (!version?.published || !version.grantEnabled ||
          (version.distributionStartsAt && version.distributionStartsAt > input.achievedAt) ||
          (version.distributionEndsAt && version.distributionEndsAt <= input.achievedAt) ||
          version.requiredReferralCount <= previousQualifiedCount || version.requiredReferralCount > input.qualifiedCount) continue;
      const expiresAt = new Date(input.achievedAt.getTime() + version.claimValidityDays * 86400000);
      const rewardSnapshot = json({ benefitId: benefit.id, version: version.version, name: version.name, description: version.description, requiredReferralCount: version.requiredReferralCount, rewardType: version.rewardType, quantity: version.quantity, accessDays: version.accessDays, memberGuidance: version.memberGuidance, usageTerms: version.usageTerms, contentItemIds: version.contents.map(item => item.contentItemId) });
      for (let unitNo = 1; unitNo <= version.quantity; unitNo += 1) {
        const existing = await tx.referralBenefitGrant.findUnique({ where: { userId_benefitVersionId_unitNo: { userId: input.referrerUserId, benefitVersionId: version.id, unitNo } } });
        if (existing && (existing.status !== 'INVALIDATED' || existing.expiresAt <= input.achievedAt)) continue;
        const grant = existing
          ? await tx.referralBenefitGrant.update({ where: { id: existing.id }, data: { status: 'AVAILABLE', invalidatedAt: null, invalidatedReason: null } })
          : await tx.referralBenefitGrant.create({ data: { userId: input.referrerUserId, benefitVersionId: version.id, achievementId: achievement.id, unitNo, rewardType: version.rewardType, rewardSnapshot, grantedAt: input.achievedAt, expiresAt } });
        granted += 1;
        await this.auth.audit(tx, req, 'REFERRAL_BENEFIT_GRANTED', grant.id, '紹介人数達成による特典付与', { benefitId: benefit.id, benefitVersionId: version.id, version: version.version, unitNo, rewardType: version.rewardType, expiresAt: grant.expiresAt.toISOString() }, 'REFERRAL_BENEFIT_GRANT');
      }
    }
    await this.auth.audit(tx, req, 'REFERRAL_ACHIEVEMENT_RECORDED', achievement.id, '紹介成立人数の到達時点を固定', { referralId: input.referralId, previousQualifiedCount, qualifiedCount: input.qualifiedCount, grants: granted }, 'REFERRAL_ACHIEVEMENT');
    return achievement;
  }

  async reconcileInvalidation(tx: Tx, userId: string, qualifiedCount: number, reason: string, now: Date) {
    await tx.referralBenefitGrant.updateMany({ where: { userId, status: 'AVAILABLE', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
    const grants = await tx.referralBenefitGrant.findMany({ where: { userId, status: 'AVAILABLE', expiresAt: { gt: now }, benefitVersion: { requiredReferralCount: { gt: qualifiedCount } } }, select: { id: true } });
    for (const grant of grants) await tx.referralBenefitGrant.update({ where: { id: grant.id }, data: { status: 'INVALIDATED', invalidatedAt: now, invalidatedReason: `紹介無効化: ${reason}` } });
    return grants.length;
  }

  async adminGrants(page: number, status: 'ALL' | 'AVAILABLE' | 'REDEEMED' | 'EXPIRED' | 'INVALIDATED') {
    const now = new Date();
    await this.auth.db.referralBenefitGrant.updateMany({ where: { status: 'AVAILABLE', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
    const where = status === 'ALL' ? {} : { status };
    const [items, total] = await Promise.all([
      this.auth.db.referralBenefitGrant.findMany({ where, include: { user: { select: { id: true, displayName: true } }, benefitVersion: { select: { benefitId: true, name: true, requiredReferralCount: true, version: true } } }, orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 20, take: 20 }),
      this.auth.db.referralBenefitGrant.count({ where })
    ]);
    return { items: items.map(item => ({ id: item.id, rewardType: item.rewardType, unitNo: item.unitNo, status: item.status, grantedAt: item.grantedAt, expiresAt: item.expiresAt, usedAt: item.usedAt, benefit: { id: item.benefitVersion.benefitId, name: item.benefitVersion.name, requiredReferralCount: item.benefitVersion.requiredReferralCount, version: item.benefitVersion.version }, member: item.user })), page, total };
  }

  async memberGrants(userId: string) {
    const now = new Date();
    await this.auth.db.referralBenefitGrant.updateMany({ where: { userId, status: 'AVAILABLE', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
    const items = await this.auth.db.referralBenefitGrant.findMany({
      where: { userId },
      include: { benefitVersion: { include: { contents: { include: { contentItem: { select: { id: true, title: true, kind: true, status: true, isVisible: true } } } } } } },
      orderBy: [{ grantedAt: 'desc' }, { id: 'desc' }]
    });
    return { items: items.map(item => ({
      id: item.id,
      rewardType: item.rewardType,
      unitNo: item.unitNo,
      status: item.status,
      grantedAt: item.grantedAt,
      expiresAt: item.expiresAt,
      usedAt: item.usedAt,
      benefit: { id: item.benefitVersion.benefitId, name: item.benefitVersion.name, requiredReferralCount: item.benefitVersion.requiredReferralCount, version: item.benefitVersion.version },
      description: item.benefitVersion.description,
      accessDays: item.benefitVersion.accessDays,
      memberGuidance: item.benefitVersion.memberGuidance,
      usageTerms: item.benefitVersion.usageTerms,
      contents: item.benefitVersion.contents.filter(content => content.contentItem.status === 'PUBLISHED' && content.contentItem.isVisible).map(content => ({ id: content.contentItem.id, title: content.contentItem.title, kind: content.contentItem.kind, status: content.contentItem.status }))
    })) };
  }

  async memberProgram(userId: string) {
    const now = new Date();
    const [qualifiedCount, benefits, grants] = await Promise.all([
      this.auth.db.referral.count({ where: { referrerUserId: userId, status: 'QUALIFIED' } }),
      this.auth.db.referralBenefit.findMany({
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      }),
      this.memberGrants(userId)
    ]);
    const offers = benefits.flatMap(benefit => {
      const version = benefit.versions[0];
      if (!version?.published || (version.distributionStartsAt && version.distributionStartsAt > now) || (version.distributionEndsAt && version.distributionEndsAt <= now)) return [];
      return [{
        id: benefit.id,
        versionId: version.id,
        version: version.version,
        name: version.name,
        description: version.description,
        requiredReferralCount: version.requiredReferralCount,
        rewardType: version.rewardType,
        quantity: version.quantity,
        accessDays: version.accessDays,
        grantEnabled: version.grantEnabled,
        memberGuidance: version.memberGuidance,
        usageTerms: version.usageTerms,
        achieved: qualifiedCount >= version.requiredReferralCount,
        remaining: Math.max(0, version.requiredReferralCount - qualifiedCount)
      }];
    }).sort((left, right) => left.requiredReferralCount - right.requiredReferralCount || left.name.localeCompare(right.name, 'ja'));
    return { offers, grants: grants.items };
  }

  async redeem(userId: string, grantId: string, targetDate: string | null, requestKey: string, req: AppRequest) {
    const key = `referral-benefit-redeem:${userId}:${requestKey}`;
    const requestHash = hashToken(JSON.stringify({ grantId, targetDate }));
    return this.idempotent(key, requestHash, async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`referral-benefit-grant:${grantId}`}))::text`;
      const grant = await tx.referralBenefitGrant.findUnique({ where: { id: grantId }, include: { benefitVersion: true } });
      if (!grant || grant.userId !== userId) throw new NotFoundException({ code: 'REFERRAL_BENEFIT_GRANT_NOT_FOUND', message: '紹介特典を確認できません。' });
      const now = new Date();
      if (grant.status === 'REDEEMED') throw new ConflictException({ code: 'REFERRAL_BENEFIT_ALREADY_USED', message: 'この特典は使用済みです。' });
      if (grant.status === 'INVALIDATED') throw new ConflictException({ code: 'REFERRAL_BENEFIT_INVALIDATED', message: 'この特典は利用できません。' });
      if (grant.status === 'EXPIRED' || grant.expiresAt <= now) {
        if (grant.status === 'AVAILABLE') await tx.referralBenefitGrant.update({ where: { id: grant.id }, data: { status: 'EXPIRED' } });
        throw new ConflictException({ code: 'REFERRAL_BENEFIT_EXPIRED', message: 'この特典の受取期限は終了しています。' });
      }
      if (grant.rewardType === 'LIMITED_CONTENT') throw new ConflictException({ code: 'LIMITED_CONTENT_AUTO_AVAILABLE', message: '限定コンテンツは獲得後すぐに利用できます。' });
      if (grant.rewardType === 'DAY_PASS') {
        if (!targetDate) throw new BadRequestException({ code: 'TARGET_DATE_REQUIRED', message: '利用する開催日を選択してください。' });
        if (targetDate < jstDate(now)) throw new BadRequestException({ code: 'PAST_TARGET_DATE', message: '本日以降の日付を選んでください。' });
        if (targetDate > jstDate(grant.expiresAt)) throw new ConflictException({ code: 'REFERRAL_BENEFIT_DATE_AFTER_EXPIRY', message: '特典の受取期限内の日付を選んでください。' });
        if (await tx.dayPass.findUnique({ where: { userId_raceDate: { userId, raceDate: targetDate } } })) throw new ConflictException({ code: 'DAY_PASS_ALREADY_EXISTS', message: 'この対象日の一日利用権はすでにあります。' });
        const access = await createDayPassAccess(tx, { userId, raceDate: targetDate, priceYen: 0, provider: 'REFERRAL_BENEFIT', providerPassId: `referral-benefit-${grant.id}`, reason: 'REFERRAL_BENEFIT_DAY_PASS', actorId: userId, source: 'REFERRAL_REWARD' });
        await tx.referralBenefitGrant.update({ where: { id: grant.id }, data: { status: 'REDEEMED', usedAt: now, dayPassId: access.pass.id } });
        await this.auth.audit(tx, req, 'REFERRAL_BENEFIT_REDEEMED', grant.id, '紹介特典一日券の利用', { targetDate, dayPassId: access.pass.id }, 'REFERRAL_BENEFIT_GRANT');
        return { grantId: grant.id, rewardType: 'DAY_PASS' as const, dayPassId: access.pass.id, status: access.pass.status, startsAt: access.startsAt, endsAt: access.endsAt, waitingForPublication: access.waitingForPublication };
      }
      if (targetDate !== null) throw new BadRequestException({ code: 'TARGET_DATE_NOT_ALLOWED', message: '月額相当特典に開催日は指定できません。' });
      const paid = await tx.entitlement.count({ where: { userId, planCode: { in: ['FOUNDER', 'STANDARD'] }, revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } } });
      if (paid) throw new ConflictException({ code: 'ACTIVE_PAID_ACCESS', message: '現在の月額契約を変更しないため、契約期間終了後にこの特典を開始してください。' });
      const accessDays = grant.benefitVersion.accessDays;
      if (!accessDays) throw new ConflictException({ code: 'REFERRAL_BENEFIT_CONFIGURATION_INVALID', message: '閲覧日数を確認できません。管理者へお問い合わせください。' });
      const endsAt = new Date(now.getTime() + accessDays * 86400000);
      const entitlement = await tx.entitlement.create({ data: { userId, planCode: 'REFERRAL_MONTHLY_ACCESS', startsAt: now, endsAt, reason: `REFERRAL_BENEFIT_MONTHLY_ACCESS:${grant.id}`, grantedBy: userId } });
      await tx.referralBenefitGrant.update({ where: { id: grant.id }, data: { status: 'REDEEMED', usedAt: now, entitlementId: entitlement.id } });
      await this.auth.audit(tx, req, 'REFERRAL_BENEFIT_REDEEMED', grant.id, '紹介特典の期間限定閲覧を開始', { entitlementId: entitlement.id, accessDays, endsAt: endsAt.toISOString(), existingSubscriptionChanged: false }, 'REFERRAL_BENEFIT_GRANT');
      return { grantId: grant.id, rewardType: 'MONTHLY_ACCESS' as const, entitlementId: entitlement.id, startsAt: now, endsAt };
    });
  }

  async hasLimitedContentAccess(userId: string, contentItemId: string, now: Date) {
    return (await this.auth.db.referralBenefitGrant.count({ where: { userId, rewardType: 'LIMITED_CONTENT', status: { in: ['AVAILABLE', 'REDEEMED'] }, expiresAt: { gt: now }, benefitVersion: { contents: { some: { contentItemId } } } } })) > 0;
  }
}
