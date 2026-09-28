import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma } from '@keiba/db';
import type { AppRequest } from './context';
import { AuthService } from './auth.service';

type PlanCode = 'FOUNDER' | 'STANDARD' | 'DAY_PASS';
type CouponInput = {
  code: string;
  name: string;
  discountType: 'PERCENT' | 'FIXED_YEN';
  discountValue: number;
  duration: 'ONCE' | 'FOREVER';
  applicablePlanCodes: PlanCode[];
  startsAt: string;
  endsAt: string;
  maxRedemptions: number | null;
  reason: string;
};

@Injectable()
export class BillingCouponService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private discount(baseAmountYen: number, coupon: { discountType: string; discountValue: number }) {
    const discountAmountYen = coupon.discountType === 'PERCENT'
      ? Math.floor(baseAmountYen * coupon.discountValue / 100)
      : coupon.discountValue;
    const amountYen = baseAmountYen - discountAmountYen;
    if (discountAmountYen <= 0 || amountYen < 50) {
      throw new UnprocessableEntityException({ code: 'COUPON_DISCOUNT_INVALID', message: 'この料金にはクーポンを適用できません。' });
    }
    return { discountAmountYen, amountYen };
  }

  private async eligible(tx: Prisma.TransactionClient, userId: string, planCode: PlanCode, baseAmountYen: number, code: string, now: Date, lock: boolean) {
    const normalized = code.trim().toUpperCase();
    if (lock) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing-coupon:${normalized}`}))::text`;
    const coupon = await tx.billingCoupon.findUnique({ where: { code: normalized } });
    if (!coupon || !coupon.active || coupon.startsAt > now || coupon.endsAt <= now || !coupon.applicablePlanCodes.includes(planCode)) {
      throw new ConflictException({ code: 'COUPON_NOT_AVAILABLE', message: 'このクーポンは現在利用できません。' });
    }
    const existing = await tx.billingCouponRedemption.findUnique({ where: { couponId_userId: { couponId: coupon.id, userId } } });
    if (existing?.status === 'REDEEMED') throw new ConflictException({ code: 'COUPON_ALREADY_USED', message: 'このクーポンはすでに利用済みです。' });
    if (lock && existing?.status === 'RESERVED' && existing.reservedUntil && existing.reservedUntil > now) {
      throw new ConflictException({ code: 'COUPON_ALREADY_RESERVED', message: 'このクーポンを使った決済が進行中です。' });
    }
    if (coupon.maxRedemptions !== null) {
      const used = await tx.billingCouponRedemption.count({
        where: {
          couponId: coupon.id,
          ...(existing ? { userId: { not: userId } } : {}),
          OR: [{ status: 'REDEEMED' }, { status: 'RESERVED', reservedUntil: { gt: now } }]
        }
      });
      if (used >= coupon.maxRedemptions) throw new ConflictException({ code: 'COUPON_LIMIT_REACHED', message: 'このクーポンは利用上限に達しました。' });
    }
    return { coupon, ...this.discount(baseAmountYen, coupon) };
  }

  async preview(userId: string, planCode: PlanCode, baseAmountYen: number, code: string) {
    const now = new Date();
    return this.auth.db.$transaction(async tx => {
      const result = await this.eligible(tx, userId, planCode, baseAmountYen, code, now, false);
      return {
        code: result.coupon.code,
        name: result.coupon.name,
        planCode,
        baseAmountYen,
        discountAmountYen: result.discountAmountYen,
        amountYen: result.amountYen,
        duration: result.coupon.duration as 'ONCE' | 'FOREVER',
        endsAt: result.coupon.endsAt
      };
    });
  }

  async quoteForPurchase(tx: Prisma.TransactionClient, input: { userId: string; planCode: PlanCode; baseAmountYen: number; code: string }) {
    const now = new Date();
    return this.eligible(tx, input.userId, input.planCode, input.baseAmountYen, input.code, now, true);
  }

  async reserveQuoted(tx: Prisma.TransactionClient, input: { userId: string; couponId: string; checkoutId: string; reservedUntil: Date }) {
    const now = new Date();
    const data = { billingCheckoutId: input.checkoutId, paymentTransactionId: null, status: 'RESERVED', reservedUntil: input.reservedUntil, redeemedAt: null, updatedAt: now };
    await tx.billingCouponRedemption.upsert({
      where: { couponId_userId: { couponId: input.couponId, userId: input.userId } },
      create: { couponId: input.couponId, userId: input.userId, ...data },
      update: data
    });
  }

  async recordLocalRedemption(tx: Prisma.TransactionClient, input: { userId: string; couponId: string; paymentTransactionId: string }) {
    const now = new Date();
    await tx.billingCouponRedemption.upsert({
      where: { couponId_userId: { couponId: input.couponId, userId: input.userId } },
      create: { couponId: input.couponId, userId: input.userId, paymentTransactionId: input.paymentTransactionId, status: 'REDEEMED', redeemedAt: now },
      update: { billingCheckoutId: null, paymentTransactionId: input.paymentTransactionId, status: 'REDEEMED', reservedUntil: null, redeemedAt: now, updatedAt: now }
    });
  }

  async markCheckoutRedeemed(tx: Prisma.TransactionClient, checkoutId: string, now: Date) {
    const redemption = await tx.billingCouponRedemption.findUnique({ where: { billingCheckoutId: checkoutId } });
    if (!redemption) return;
    if (redemption.status === 'REDEEMED') return;
    await tx.billingCouponRedemption.update({ where: { id: redemption.id }, data: { status: 'REDEEMED', reservedUntil: null, redeemedAt: now, updatedAt: now } });
  }

  async releaseCheckout(checkoutId: string) {
    await this.auth.db.billingCouponRedemption.updateMany({ where: { billingCheckoutId: checkoutId, status: 'RESERVED' }, data: { status: 'RELEASED', reservedUntil: null, updatedAt: new Date() } });
  }

  async list() {
    const now = new Date();
    const [coupons, reservedGroups, redeemedGroups] = await Promise.all([
      this.auth.db.billingCoupon.findMany({ orderBy: [{ createdAt: 'desc' }] }),
      this.auth.db.billingCouponRedemption.groupBy({ by: ['couponId'], where: { status: 'RESERVED', reservedUntil: { gt: now } }, _count: { _all: true } }),
      this.auth.db.billingCouponRedemption.groupBy({ by: ['couponId'], where: { status: 'REDEEMED' }, _count: { _all: true } })
    ]);
    const reservedCounts = new Map(reservedGroups.map(item => [item.couponId, item._count._all]));
    const redeemedCounts = new Map(redeemedGroups.map(item => [item.couponId, item._count._all]));
    return { items: coupons.map(coupon => ({
      id: coupon.id, code: coupon.code, name: coupon.name,
      discountType: coupon.discountType as 'PERCENT' | 'FIXED_YEN', discountValue: coupon.discountValue, duration: coupon.duration as 'ONCE' | 'FOREVER',
      applicablePlanCodes: coupon.applicablePlanCodes as PlanCode[], startsAt: coupon.startsAt, endsAt: coupon.endsAt,
      maxRedemptions: coupon.maxRedemptions, active: coupon.active,
      reservedCount: reservedCounts.get(coupon.id) ?? 0,
      redeemedCount: redeemedCounts.get(coupon.id) ?? 0,
      createdAt: coupon.createdAt, deactivatedAt: coupon.deactivatedAt, deactivationReason: coupon.deactivationReason
    })) };
  }

  async create(req: AppRequest, actorId: string, input: CouponInput) {
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing-coupon:${input.code}`}))::text`;
      if (await tx.billingCoupon.findUnique({ where: { code: input.code } })) throw new ConflictException({ code: 'COUPON_CODE_EXISTS', message: '同じクーポンコードがすでに存在します。' });
      const coupon = await tx.billingCoupon.create({ data: {
        code: input.code, name: input.name, discountType: input.discountType, discountValue: input.discountValue, duration: input.duration,
        applicablePlanCodes: input.applicablePlanCodes, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), maxRedemptions: input.maxRedemptions,
        createdById: actorId
      } });
      await this.auth.audit(tx, req, 'BILLING_COUPON_CREATED', coupon.id, input.reason, {
        name: coupon.name, discountType: coupon.discountType, discountValue: coupon.discountValue, duration: coupon.duration,
        applicablePlanCodes: coupon.applicablePlanCodes, startsAt: coupon.startsAt, endsAt: coupon.endsAt, maxRedemptions: coupon.maxRedemptions
      }, 'BillingCoupon');
      return coupon;
    });
  }

  async deactivate(req: AppRequest, actorId: string, couponId: string, reason: string) {
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing-coupon-id:${couponId}`}))::text`;
      const coupon = await tx.billingCoupon.findUnique({ where: { id: couponId } });
      if (!coupon) throw new NotFoundException({ code: 'COUPON_NOT_FOUND', message: 'クーポンを確認できません。' });
      if (!coupon.active) return coupon;
      const after = await tx.billingCoupon.update({ where: { id: couponId }, data: { active: false, deactivatedById: actorId, deactivatedAt: new Date(), deactivationReason: reason } });
      await this.auth.audit(tx, req, 'BILLING_COUPON_DEACTIVATED', coupon.id, reason, { activeReservationsRemainValid: true }, 'BillingCoupon');
      return after;
    });
  }
}
