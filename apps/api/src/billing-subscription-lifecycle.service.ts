import { ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { AuthService } from './auth.service';
import { recordBillingEvent } from './billing-events';
import type { AppRequest } from './context';
import { loadStripeConfig } from './stripe-config';

type BillingTransport = 'test' | 'stripe';

@Injectable()
export class BillingSubscriptionLifecycleService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  protected async configuredClient() {
    const config = await loadStripeConfig(this.auth.db);
    if (!config.usable) throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED', message: '外部決済の設定が完了していません。' });
    return new Stripe(config.secretKey!);
  }

  async scheduleCancellation(req: AppRequest, userId: string, id: string, transport: BillingTransport) {
    if (transport === 'stripe') {
      const external = await this.auth.db.subscription.findUnique({ where: { id } });
      if (!external || external.userId !== userId) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
      if (external.provider !== 'STRIPE') throw new ConflictException({ code: 'SUBSCRIPTION_PROVIDER_MISMATCH', message: '外部決済の契約ではありません。' });
      if (!external.cancelAtPeriodEnd) {
        const client = await this.configuredClient();
        await client.subscriptions.update(external.providerSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `cancel-at-period-end:${external.id}:${external.updatedAt.getTime()}` });
      }
    }
    return this.auth.db.$transaction(async tx => {
      const current = await tx.subscription.findUnique({ where: { id } });
      if (!current || current.userId !== userId) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
      if (current.cancelAtPeriodEnd) return { id, status: current.status, cancelAtPeriodEnd: true, accessEndsAt: current.currentPeriodEndsAt };
      if (!['ACTIVE', 'PAST_DUE', 'TRIALING'].includes(current.status)) throw new ConflictException({ code: 'SUBSCRIPTION_NOT_CANCELABLE', message: 'この契約は解約予約できません。' });
      const now = new Date();
      const subscription = await tx.subscription.update({ where: { id }, data: { cancelAtPeriodEnd: true, canceledAt: now } });
      await recordBillingEvent(tx, { userId, eventType: 'CANCELLATION_SCHEDULED', subscriptionId: id, actorId: userId, details: { accessEndsAt: current.currentPeriodEndsAt.toISOString() } }, 'BILLING_CANCELLATION_SCHEDULED');
      await this.auth.audit(tx, req, 'SUBSCRIPTION_CANCEL_SCHEDULE', id, '会員本人による解約予約', { accessEndsAt: current.currentPeriodEndsAt }, 'Subscription');
      return { id, status: subscription.status, cancelAtPeriodEnd: true, accessEndsAt: current.currentPeriodEndsAt };
    });
  }

  async resume(req: AppRequest, userId: string, id: string, transport: BillingTransport) {
    const external = await this.auth.db.subscription.findUnique({ where: { id } });
    if (!external || external.userId !== userId) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
    if (!external.cancelAtPeriodEnd) return { id, status: external.status, cancelAtPeriodEnd: false, accessEndsAt: external.currentPeriodEndsAt };
    if (!['ACTIVE', 'PAST_DUE', 'TRIALING'].includes(external.status)) throw new ConflictException({ code: 'SUBSCRIPTION_NOT_RESUMABLE', message: 'この契約は継続へ戻せません。' });
    if (transport === 'stripe') {
      if (external.provider !== 'STRIPE') throw new ConflictException({ code: 'SUBSCRIPTION_PROVIDER_MISMATCH', message: '外部決済の契約ではありません。' });
      const client = await this.configuredClient();
      await client.subscriptions.update(external.providerSubscriptionId, { cancel_at_period_end: false }, { idempotencyKey: `resume-subscription:${external.id}:${external.updatedAt.getTime()}` });
    }
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:subscription:${id}`}))::text`;
      const current = await tx.subscription.findUnique({ where: { id } });
      if (!current || current.userId !== userId) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
      if (!current.cancelAtPeriodEnd) return { id, status: current.status, cancelAtPeriodEnd: false, accessEndsAt: current.currentPeriodEndsAt };
      if (!['ACTIVE', 'PAST_DUE', 'TRIALING'].includes(current.status)) throw new ConflictException({ code: 'SUBSCRIPTION_NOT_RESUMABLE', message: 'この契約は継続へ戻せません。' });
      const subscription = await tx.subscription.update({ where: { id }, data: { cancelAtPeriodEnd: false, canceledAt: null, updatedAt: new Date() } });
      await recordBillingEvent(tx, { userId, eventType: 'CANCELLATION_REVERSED', subscriptionId: id, actorId: userId, details: { accessEndsAt: current.currentPeriodEndsAt.toISOString(), source: 'MEMBER_REQUEST' } }, 'BILLING_CANCELLATION_REVERSED');
      await this.auth.audit(tx, req, 'SUBSCRIPTION_CANCEL_REVERSED', id, '会員本人による解約予約の取消', { accessEndsAt: current.currentPeriodEndsAt }, 'Subscription');
      return { id, status: subscription.status, cancelAtPeriodEnd: false, accessEndsAt: current.currentPeriodEndsAt };
    });
  }
}
