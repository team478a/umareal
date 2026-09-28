import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { addCalendarMonthUtc } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service';
import { recordBillingEvent } from './billing-events';
import { createDayPassAccess } from './day-pass-access';

@Injectable()
export class BillingLocalCheckoutService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async subscription(userId: string, planCode: 'FOUNDER' | 'STANDARD', key: string, requestHash: string) {
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))::text`;
        const previous = await tx.idempotencyKey.findUnique({ where: { key } });
        if (previous) {
          if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ申込キーが異なる内容で使われています。' });
          return previous.response;
        }
        const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
        if (!settings.newPurchasesEnabled) throw new ServiceUnavailableException({ code: 'PURCHASES_STOPPED', message: '現在、新規購入を停止しています。' });
        if (await tx.subscription.count({ where: { userId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } })) throw new ConflictException({ code: 'ACTIVE_SUBSCRIPTION_EXISTS', message: '有効な月額契約があります。' });
        if (planCode === 'FOUNDER') {
          if (!settings.founderSalesEnabled) throw new ConflictException({ code: 'FOUNDER_SALES_CLOSED', message: '創設会員プランは販売していません。' });
          const sold = await tx.subscription.count({ where: { planCode: 'FOUNDER' } });
          if (sold >= settings.founderSalesLimit) throw new ConflictException({ code: 'FOUNDER_LIMIT_REACHED', message: '創設会員プランは販売上限に達しました。' });
        }
        const now = new Date();
        const endsAt = addCalendarMonthUtc(now);
        const priceYen = planCode === 'FOUNDER' ? settings.founderPriceYen : settings.standardPriceYen;
        const entitlement = await tx.entitlement.create({ data: { userId, planCode, startsAt: now, endsAt, reason: 'LOCAL_TEST_SUBSCRIPTION', grantedBy: userId } });
        const subscription = await tx.subscription.create({ data: { userId, planCode, status: 'ACTIVE', priceYen, currentPeriodStartsAt: now, currentPeriodEndsAt: endsAt, provider: 'LOCAL_TEST', providerSubscriptionId: `local-sub-${randomUUID()}`, entitlementId: entitlement.id } });
        const payment = await tx.paymentTransaction.create({ data: { userId, provider: 'LOCAL_TEST', providerPaymentId: `local-pay-${randomUUID()}`, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: priceYen, subscriptionId: subscription.id } });
        await recordBillingEvent(tx, { userId, eventType: 'SUBSCRIPTION_STARTED', subscriptionId: subscription.id, actorId: userId, details: { planCode, priceYen, developmentSimulation: true } }, 'BILLING_PAYMENT_SUCCEEDED');
        const response = { subscriptionId: subscription.id, paymentId: payment.id, status: subscription.status, currentPeriodEndsAt: endsAt };
        await tx.idempotencyKey.create({ data: { key, requestHash, response } });
        return response;
      }, { timeout: 20000, maxWait: 10000 });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (previous?.requestHash === requestHash) return previous.response;
      throw new ConflictException({ code: 'BILLING_CONFLICT', message: '申込状態が競合しました。再読み込みしてください。' });
    }
  }

  async dayPass(userId: string, raceDate: string, key: string, requestHash: string) {
    try {
      return await this.auth.db.$transaction(async tx => {
        const previous = await tx.idempotencyKey.findUnique({ where: { key } });
        if (previous) {
          if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ申込キーが異なる内容で使われています。' });
          return previous.response;
        }
        const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
        if (!settings.newPurchasesEnabled) throw new ServiceUnavailableException({ code: 'PURCHASES_STOPPED', message: '現在、新規購入を停止しています。' });
        const access = await createDayPassAccess(tx, { userId, raceDate, priceYen: settings.dayPassPriceYen, provider: 'LOCAL_TEST', providerPassId: `local-pass-${randomUUID()}`, reason: 'LOCAL_TEST_DAY_PASS', actorId: userId, source: 'LOCAL_TEST' });
        const pass = access.pass;
        const payment = await tx.paymentTransaction.create({ data: { userId, provider: 'LOCAL_TEST', providerPaymentId: `local-pay-${randomUUID()}`, kind: 'DAY_PASS', status: 'SUCCEEDED', amountYen: settings.dayPassPriceYen, dayPassId: pass.id } });
        await tx.notificationEvent.create({ data: { billingEventId: access.billingEvent.id, eventType: 'BILLING_PAYMENT_SUCCEEDED', status: 'QUEUED', payload: { billingEventId: access.billingEvent.id } } });
        const response = { dayPassId: pass.id, paymentId: payment.id, status: pass.status, startsAt: access.startsAt, endsAt: access.endsAt, waitingForPublication: access.waitingForPublication };
        await tx.idempotencyKey.create({ data: { key, requestHash, response } });
        return response;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (previous?.requestHash === requestHash) return previous.response;
      throw new ConflictException({ code: 'DAY_PASS_EXISTS', message: 'この開催日の1日利用は登録済みです。' });
    }
  }
}
