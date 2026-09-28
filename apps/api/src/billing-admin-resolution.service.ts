import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { AuthService } from './auth.service';
import { recordBillingEvent } from './billing-events';
import type { AppRequest } from './context';
import { createDayPassAccess } from './day-pass-access';
import { loadStripeConfig } from './stripe-config';

type BillingReviewResolution = {
  action: 'GRANT_ACCESS' | 'REFUND';
  reason: string;
};

@Injectable()
export class BillingAdminResolutionService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  protected async configuredClient() {
    const config = await loadStripeConfig(this.auth.db);
    if (!config.usable) throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED', message: '外部決済の設定が完了していません。' });
    return new Stripe(config.secretKey!);
  }

  private providerId(value: unknown) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
    return null;
  }

  private async stripePaymentIntentForDayPass(client: Stripe, providerPassId: string) {
    const session = await client.checkout.sessions.retrieve(providerPassId);
    const paymentIntentId = this.providerId(session.payment_intent);
    if (!paymentIntentId) throw new ConflictException({ code: 'STRIPE_PAYMENT_INTENT_MISSING', message: 'Stripeの支払い情報を確認できません。運営で決済状態を確認してください。' });
    return paymentIntentId;
  }

  private async stripePaymentReferenceForCheckout(client: Stripe, providerSessionId: string) {
    const session = await client.checkout.sessions.retrieve(providerSessionId);
    const paymentIntentId = this.providerId(session.payment_intent);
    if (paymentIntentId) return { payment_intent: paymentIntentId } as const;
    const invoiceId = this.providerId(session.invoice);
    if (!invoiceId) throw new ConflictException({ code: 'STRIPE_PAYMENT_REFERENCE_MISSING', message: 'Stripeの返金対象を確認できません。決済管理画面で状態を確認してください。' });
    const payments = await client.invoicePayments.list({ invoice: invoiceId, status: 'paid', limit: 10 });
    const payment = payments.data.find(item => item.payment.type === 'payment_intent' || item.payment.type === 'charge');
    const invoicePaymentIntentId = payment ? this.providerId(payment.payment.payment_intent) : null;
    if (invoicePaymentIntentId) return { payment_intent: invoicePaymentIntentId } as const;
    const chargeId = payment ? this.providerId(payment.payment.charge) : null;
    if (chargeId) return { charge: chargeId } as const;
    throw new ConflictException({ code: 'STRIPE_PAYMENT_REFERENCE_MISSING', message: 'Stripeの返金対象を確認できません。決済管理画面で状態を確認してください。' });
  }

  async resolveCheckoutReview(req: AppRequest, actorId: string, id: string, input: BillingReviewResolution) {
    const initial = await this.auth.db.billingCheckout.findUnique({ where: { id } });
    if (!initial || !initial.providerSessionId || !initial.completedAt) throw new NotFoundException({ code: 'BILLING_REVIEW_NOT_FOUND', message: '要確認の決済を確認できません。' });
    if (initial.status === 'REVIEW_ACCESS_GRANTED' || initial.status === 'REVIEW_REFUNDED') return { checkoutId: id, status: initial.status };
    const reviewStates = ['REJECTED_ACCOUNT_STATE', 'REJECTED_EXISTING_ACCESS', 'REJECTED_FOUNDER_LIMIT', 'REVIEW_REFUNDING'];
    if (!reviewStates.includes(initial.status)) throw new ConflictException({ code: 'BILLING_REVIEW_STATE_CHANGED', message: 'この決済は要確認状態ではありません。' });
    const client = await this.configuredClient();
    if (input.action === 'REFUND') {
      const reserved = await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:checkout-review:${id}`}))::text`;
        const current = await tx.billingCheckout.findUniqueOrThrow({ where: { id } });
        if (current.status === 'REVIEW_REFUNDED') return false;
        if (!reviewStates.includes(current.status)) throw new ConflictException({ code: 'BILLING_REVIEW_STATE_CHANGED', message: '決済状態が変わりました。再読み込みしてください。' });
        if (current.status !== 'REVIEW_REFUNDING') await tx.billingCheckout.update({ where: { id }, data: { status: 'REVIEW_REFUNDING' } });
        return true;
      });
      if (!reserved) {
        await this.auth.audit(this.auth.db, req, 'BILLING_REVIEW_REFUND_CONFIRMED', id, input.reason, { status: 'REVIEW_REFUNDED' }, 'BillingCheckout');
        return { checkoutId: id, status: 'REVIEW_REFUNDED' };
      }
      if (initial.kind === 'SUBSCRIPTION' && initial.providerSubscriptionId) {
        const subscription = await client.subscriptions.retrieve(initial.providerSubscriptionId);
        if (subscription.status !== 'canceled') await client.subscriptions.cancel(initial.providerSubscriptionId, {}, { idempotencyKey: `review-cancel:${id}` });
      }
      const reference = await this.stripePaymentReferenceForCheckout(client, initial.providerSessionId);
      const refund = await client.refunds.create({ ...reference, amount: initial.amountYen, metadata: { checkoutId: initial.id } }, { idempotencyKey: `review-refund:${id}` });
      if (refund.status !== 'succeeded') throw new ConflictException({ code: 'STRIPE_REFUND_PENDING', message: 'Stripeの返金処理が完了していません。管理画面から再確認してください。' });
      return this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:checkout-review:${id}`}))::text`;
        const current = await tx.billingCheckout.findUniqueOrThrow({ where: { id } });
        const providerPaymentId = `refund:${refund.id}`;
        const existing = await tx.paymentTransaction.findUnique({ where: { providerPaymentId } });
        let refundPaymentId = existing?.id ?? null;
        if (!existing) {
          const payment = await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'STRIPE', providerPaymentId, kind: current.kind, status: 'REFUNDED', amountYen: refund.amount, billingCheckoutId: current.id } });
          await recordBillingEvent(tx, { userId: current.userId, eventType: 'CHECKOUT_PAYMENT_REFUNDED', billingCheckoutId: current.id, actorId, details: { checkoutId: current.id, amountYen: refund.amount, reason: input.reason, providerRefundId: refund.id, source: 'ADMIN_REVIEW' } }, 'BILLING_REFUND_COMPLETED');
          refundPaymentId = payment.id;
        }
        await tx.billingCheckout.updateMany({ where: { id, status: { not: 'REVIEW_REFUNDED' } }, data: { status: 'REVIEW_REFUNDED' } });
        if (!await tx.auditLog.findFirst({ where: { action: 'BILLING_REVIEW_REFUNDED', targetType: 'BillingCheckout', targetId: current.id } })) await this.auth.audit(tx, req, 'BILLING_REVIEW_REFUNDED', current.id, input.reason, { amountYen: refund.amount, refundPaymentId }, 'BillingCheckout');
        return { checkoutId: id, status: 'REVIEW_REFUNDED' };
      }, { timeout: 20000, maxWait: 10000 });
    }

    const session = await client.checkout.sessions.retrieve(initial.providerSessionId);
    if (session.payment_status !== 'paid' || session.currency !== 'jpy' || session.amount_total !== initial.amountYen) throw new ConflictException({ code: 'STRIPE_PAYMENT_MISMATCH', message: 'Stripeの支払い内容が申込記録と一致しません。返金対応を確認してください。' });
    const providerSubscriptionId = initial.kind === 'SUBSCRIPTION' ? this.providerId(session.subscription) ?? initial.providerSubscriptionId : null;
    const externalSubscription = providerSubscriptionId ? await client.subscriptions.retrieve(providerSubscriptionId) : null;
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${initial.userId}`}))::text`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:checkout-review:${id}`}))::text`;
      if (initial.planCode === 'FOUNDER') await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('billing:founder-capacity'))::text`;
      const current = await tx.billingCheckout.findUniqueOrThrow({ where: { id } });
      if (current.status === 'REVIEW_ACCESS_GRANTED') return { checkoutId: id, status: current.status };
      if (!['REJECTED_ACCOUNT_STATE', 'REJECTED_EXISTING_ACCESS', 'REJECTED_FOUNDER_LIMIT'].includes(current.status)) throw new ConflictException({ code: 'BILLING_REVIEW_STATE_CHANGED', message: '決済状態が変わりました。再読み込みしてください。' });
      const account = await tx.user.findUnique({ where: { id: current.userId }, select: { role: true, disabledAt: true, accountClosure: { select: { id: true } } } });
      if (!account || account.role !== 'MEMBER' || account.disabledAt || account.accountClosure) throw new ConflictException({ code: 'BILLING_REVIEW_ACCOUNT_NOT_ELIGIBLE', message: '会員状態が有効ではないため、閲覧権限を付与できません。' });
      if (current.kind === 'SUBSCRIPTION') {
        if (!providerSubscriptionId || !externalSubscription || !['active', 'trialing', 'past_due'].includes(externalSubscription.status)) throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_NOT_ACTIVE', message: 'Stripeの月額契約が有効ではありません。返金対応を確認してください。' });
        if (await tx.subscription.count({ where: { userId: current.userId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } })) throw new ConflictException({ code: 'ACTIVE_SUBSCRIPTION_EXISTS', message: 'すでに有効な月額契約があるため、重複付与できません。' });
        if (current.planCode === 'FOUNDER') {
          const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { founderSalesLimit: true } });
          if (await tx.subscription.count({ where: { planCode: 'FOUNDER' } }) >= settings.founderSalesLimit) throw new ConflictException({ code: 'FOUNDER_LIMIT_REACHED', message: '創設会員の販売上限に達しているため、権限を付与できません。' });
        }
        const periods = externalSubscription.items.data.map(item => ({ start: item.current_period_start, end: item.current_period_end })).filter(item => item.end > item.start);
        if (!periods.length) throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_PERIOD_MISSING', message: 'Stripeの契約期間を確認できません。' });
        const startsAt = new Date(Math.min(...periods.map(item => item.start)) * 1000);
        const endsAt = new Date(Math.max(...periods.map(item => item.end)) * 1000);
        const entitlement = await tx.entitlement.create({ data: { userId: current.userId, planCode: current.planCode, startsAt, endsAt, reason: 'ADMIN_BILLING_REVIEW_RESOLVED', grantedBy: actorId } });
        const subscription = await tx.subscription.create({ data: { userId: current.userId, planCode: current.planCode, status: externalSubscription.status === 'past_due' ? 'PAST_DUE' : externalSubscription.status === 'trialing' ? 'TRIALING' : 'ACTIVE', priceYen: current.amountYen, currentPeriodStartsAt: startsAt, currentPeriodEndsAt: endsAt, provider: 'STRIPE', providerSubscriptionId, entitlementId: entitlement.id } });
        await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'STRIPE', providerPaymentId: `review-grant:${current.providerSessionId}`, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: current.amountYen, subscriptionId: subscription.id } });
        await recordBillingEvent(tx, { userId: current.userId, eventType: 'SUBSCRIPTION_STARTED', subscriptionId: subscription.id, actorId, details: { planCode: current.planCode, priceYen: current.amountYen, source: 'ADMIN_BILLING_REVIEW' } }, 'BILLING_PAYMENT_SUCCEEDED');
      } else {
        if (!current.raceDate) throw new ConflictException({ code: 'DAY_PASS_DATE_MISSING', message: '利用日を確認できません。' });
        if (await tx.dayPass.count({ where: { userId: current.userId, raceDate: current.raceDate } })) throw new ConflictException({ code: 'DAY_PASS_EXISTS', message: '同じ開催日の一日券があるため、重複付与できません。' });
        const access = await createDayPassAccess(tx, { userId: current.userId, raceDate: current.raceDate, priceYen: current.amountYen, provider: 'STRIPE', providerPassId: current.providerSessionId!, reason: 'ADMIN_BILLING_REVIEW_RESOLVED', actorId, source: 'STRIPE_CHECKOUT' });
        await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'STRIPE', providerPaymentId: `review-grant:${current.providerSessionId}`, kind: 'DAY_PASS', status: 'SUCCEEDED', amountYen: current.amountYen, dayPassId: access.pass.id } });
        await tx.notificationEvent.create({ data: { billingEventId: access.billingEvent.id, eventType: 'BILLING_PAYMENT_SUCCEEDED', status: 'QUEUED', payload: { billingEventId: access.billingEvent.id } } });
      }
      await tx.billingCheckout.update({ where: { id }, data: { status: 'REVIEW_ACCESS_GRANTED' } });
      await this.auth.audit(tx, req, 'BILLING_REVIEW_ACCESS_GRANTED', id, input.reason, { kind: current.kind, planCode: current.planCode, amountYen: current.amountYen, raceDate: current.raceDate }, 'BillingCheckout');
      return { checkoutId: id, status: 'REVIEW_ACCESS_GRANTED' };
    }, { timeout: 20000, maxWait: 10000 });
  }

  async refundExpiredPendingDayPass(req: AppRequest, actorId: string, id: string, reason: string) {
    const reservation = await this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:day-pass-refund:${id}`}))::text`;
      const current = await tx.dayPass.findUnique({ where: { id }, include: { payments: { orderBy: { occurredAt: 'asc' } } } });
      if (!current) throw new NotFoundException({ code: 'DAY_PASS_NOT_FOUND', message: '1日利用を確認できません。' });
      const existingRefund = current.payments.find(payment => payment.status === 'REFUNDED');
      if (current.status === 'REFUNDED' && existingRefund) return { complete: true as const, response: { dayPassId: id, status: 'REFUNDED', refundPaymentId: existingRefund.id } };
      if (current.source !== 'PURCHASE' || !['PENDING', 'REFUNDING'].includes(current.status) || current.startsAt || current.entitlementId || current.endsAt > new Date()) throw new ConflictException({ code: 'DAY_PASS_REFUND_NOT_ELIGIBLE', message: '期限を過ぎても公開待ちのままの購入済み一日券だけを返金できます。' });
      if (!['STRIPE', 'LOCAL_TEST'].includes(current.provider)) throw new ConflictException({ code: 'DAY_PASS_PROVIDER_REVIEW_REQUIRED', message: 'この決済事業者の返金は管理画面から実行できません。' });
      const succeededPayment = current.payments.find(payment => payment.status === 'SUCCEEDED');
      if (!succeededPayment || succeededPayment.amountYen !== current.priceYen) throw new ConflictException({ code: 'DAY_PASS_PAYMENT_REVIEW_REQUIRED', message: '元の支払いを確認できません。返金前に決済履歴を確認してください。' });
      if (current.status === 'PENDING') {
        const reserved = await tx.dayPass.updateMany({ where: { id, status: 'PENDING', startsAt: null, entitlementId: null, endsAt: { lte: new Date() } }, data: { status: 'REFUNDING', updatedAt: new Date() } });
        if (!reserved.count) throw new ConflictException({ code: 'DAY_PASS_REFUND_STATE_CHANGED', message: '一日券の状態が変わりました。再読み込みしてください。' });
      }
      return { complete: false as const, pass: current };
    }, { timeout: 20000, maxWait: 10000 });
    if (reservation.complete) return reservation.response;
    const initial = reservation.pass;

    let providerRefundId: string;
    if (initial.provider === 'STRIPE') {
      const client = await this.configuredClient();
      const paymentIntentId = await this.stripePaymentIntentForDayPass(client, initial.providerPassId);
      const refund = await client.refunds.create({ payment_intent: paymentIntentId, amount: initial.priceYen, metadata: { dayPassId: initial.id } }, { idempotencyKey: `expired-pending-day-pass:${initial.id}` });
      if (refund.status !== 'succeeded') throw new ConflictException({ code: 'STRIPE_REFUND_PENDING', message: 'Stripeの返金処理が完了していません。決済管理画面で状態を確認してください。' });
      providerRefundId = refund.id;
    } else if (initial.provider === 'LOCAL_TEST') providerRefundId = `local-${initial.id}`;
    else throw new ConflictException({ code: 'DAY_PASS_PROVIDER_REVIEW_REQUIRED', message: 'この決済事業者の返金は管理画面から実行できません。' });

    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:day-pass-refund:${id}`}))::text`;
      const current = await tx.dayPass.findUniqueOrThrow({ where: { id }, include: { payments: { orderBy: { occurredAt: 'asc' } } } });
      const currentRefund = current.payments.find(payment => payment.status === 'REFUNDED');
      if (current.status === 'REFUNDED' && currentRefund) return { dayPassId: id, status: 'REFUNDED', refundPaymentId: currentRefund.id };
      if (current.source !== 'PURCHASE' || current.status !== 'REFUNDING' || current.startsAt || current.entitlementId || current.endsAt > new Date()) throw new ConflictException({ code: 'DAY_PASS_REFUND_STATE_CHANGED', message: '一日券の状態が変わりました。決済状態を確認してください。' });
      const refundPayment = await tx.paymentTransaction.create({ data: { userId: current.userId, provider: current.provider, providerPaymentId: `refund:${providerRefundId}`, kind: 'DAY_PASS', status: 'REFUNDED', amountYen: current.priceYen, dayPassId: current.id } });
      await tx.dayPass.update({ where: { id }, data: { status: 'REFUNDED', updatedAt: new Date() } });
      await recordBillingEvent(tx, { userId: current.userId, eventType: 'DAY_PASS_REFUNDED', dayPassId: current.id, actorId, details: { amountYen: current.priceYen, raceDate: current.raceDate, reason, providerRefundId } }, 'BILLING_REFUND_COMPLETED');
      await this.auth.audit(tx, req, 'DAY_PASS_REFUNDED', current.id, reason, { amountYen: current.priceYen, raceDate: current.raceDate, refundPaymentId: refundPayment.id });
      return { dayPassId: id, status: 'REFUNDED', refundPaymentId: refundPayment.id };
    }, { timeout: 20000, maxWait: 10000 });
  }
}
