import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { addCalendarMonthUtc } from '@keiba/domain';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service';
import { recordBillingEvent } from './billing-events';
import type { AppRequest } from './context';

@Injectable()
export class BillingLocalSimulationService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async simulateFailure(req: AppRequest, actorId: string, id: string, reason: string) {
    return this.auth.db.$transaction(async tx => {
      const current = await tx.subscription.findUniqueOrThrow({ where: { id } });
      const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
      if (!['ACTIVE', 'PAST_DUE'].includes(current.status)) throw new ConflictException({ code: 'SUBSCRIPTION_NOT_OPEN', message: '有効な契約だけを試験できます。' });
      const now = new Date();
      const graceEndsAt = new Date(now.getTime() + settings.billingGraceDays * 86400000);
      await tx.subscription.update({ where: { id }, data: { status: 'PAST_DUE', graceEndsAt } });
      await tx.entitlement.update({ where: { id: current.entitlementId }, data: { endsAt: graceEndsAt > now ? graceEndsAt : new Date(now.getTime() + 1), revokedAt: settings.billingGraceDays ? null : now } });
      await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'LOCAL_TEST', providerPaymentId: `local-failed-${randomUUID()}`, kind: 'SUBSCRIPTION', status: 'FAILED', amountYen: current.priceYen, subscriptionId: id } });
      await recordBillingEvent(tx, { userId: current.userId, eventType: 'PAYMENT_FAILED', subscriptionId: id, actorId, details: { reason, graceEndsAt: graceEndsAt.toISOString() } }, 'BILLING_PAYMENT_FAILED');
      await this.auth.audit(tx, req, 'BILLING_SIMULATE_FAILURE', id, reason, { graceEndsAt });
      return { id, status: 'PAST_DUE', graceEndsAt };
    });
  }

  async simulateRecovery(req: AppRequest, actorId: string, id: string, reason: string) {
    return this.auth.db.$transaction(async tx => {
      const current = await tx.subscription.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'PAST_DUE') throw new ConflictException({ code: 'SUBSCRIPTION_NOT_PAST_DUE', message: '支払待ちの契約ではありません。' });
      const now = new Date();
      const endsAt = addCalendarMonthUtc(now);
      await tx.subscription.update({ where: { id }, data: { status: 'ACTIVE', currentPeriodStartsAt: now, currentPeriodEndsAt: endsAt, graceEndsAt: null } });
      await tx.entitlement.update({ where: { id: current.entitlementId }, data: { startsAt: now, endsAt, revokedAt: null } });
      await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'LOCAL_TEST', providerPaymentId: `local-recovery-${randomUUID()}`, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: current.priceYen, subscriptionId: id } });
      await recordBillingEvent(tx, { userId: current.userId, eventType: 'PAYMENT_RECOVERED', subscriptionId: id, actorId, details: { reason, currentPeriodEndsAt: endsAt.toISOString() } }, 'BILLING_PAYMENT_RECOVERED');
      await this.auth.audit(tx, req, 'BILLING_RECOVER', id, reason, { currentPeriodEndsAt: endsAt });
      return { id, status: 'ACTIVE', currentPeriodEndsAt: endsAt };
    });
  }
}
