import { BadRequestException, ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { addCalendarMonthUtc, launchCapabilities, resolveLaunchMode } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import Stripe from 'stripe';
import type { AppRequest } from './context';
import { DbService } from './db.service';
import { createDayPassAccess } from './day-pass-access';
import { recordBillingEvent } from './billing-events';
import { loadStripeConfig, type StripeRuntimeConfig } from './stripe-config';

type StripeRefundContext = { checkoutId?: string; dayPassId?: string; subscriptionId?: string; providerSubscriptionId?: string };

@Injectable()
export class StripeWebhookService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async handle(req: AppRequest) {
    if (!launchCapabilities(resolveLaunchMode(process.env.LAUNCH_MODE)).billing) throw new ServiceUnavailableException({ code: 'BILLING_NOT_IN_LAUNCH', message: '有料プランは現在準備中です。' });
    if (process.env.BILLING_TRANSPORT !== 'stripe') throw new ServiceUnavailableException({ code: 'STRIPE_WEBHOOK_DISABLED', message: 'Stripe Webhookは無効です。' });
    const stripeConfig = await this.stripeConfig();
    const signature = req.headers['stripe-signature'];
    const secret = stripeConfig.webhookSecret;
    if (typeof signature !== 'string' || !secret || !req.rawBody) throw new BadRequestException({ code: 'STRIPE_SIGNATURE_REQUIRED', message: 'Webhook署名を確認できません。' });
    let event: Stripe.Event;
    try { event = this.stripeClient(stripeConfig).webhooks.constructEvent(req.rawBody, signature, secret); }
    catch { throw new BadRequestException({ code: 'STRIPE_SIGNATURE_INVALID', message: 'Webhook署名が正しくありません。' }); }
    const expectedLive = stripeConfig.liveMode;
    if (event.livemode !== expectedLive) throw new BadRequestException({ code: 'STRIPE_MODE_MISMATCH', message: 'Webhookの動作モードが一致しません。' });
    const received = await this.db.stripeWebhookEvent.findUnique({ where: { providerEventId: event.id } });
    if (received) return { received: true, duplicate: true, outcome: received.outcome };
    const refundObject = event.type === 'refund.created' || event.type === 'refund.updated' ? event.data.object as Stripe.Refund : null;
    const refundContext = refundObject?.status === 'succeeded'
      ? await this.resolveStripeRefundContext(this.stripeClient(stripeConfig), refundObject)
      : null;
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe-event:${event.id}`}))::text`;
      const previous = await tx.stripeWebhookEvent.findUnique({ where: { providerEventId: event.id } });
      if (previous) return { received: true, duplicate: true, outcome: previous.outcome };
      if (event.type === 'invoice.paid') return this.processStripeInvoicePaid(tx, event, req);
      if (event.type === 'invoice.payment_failed') return this.processStripeInvoiceFailed(tx, event, req);
      if (event.type === 'customer.subscription.updated') return this.processStripeSubscriptionUpdated(tx, event, req);
      if (event.type === 'customer.subscription.deleted') return this.processStripeSubscriptionDeleted(tx, event, req);
      if (event.type === 'refund.created' || event.type === 'refund.updated') {
        return this.processStripeRefund(tx, event, req, refundContext ?? {});
      }
      if (event.type !== 'checkout.session.completed') {
        await tx.stripeWebhookEvent.create({ data: { providerEventId: event.id, eventType: event.type, livemode: event.livemode, outcome: 'IGNORED' } });
        return { received: true, duplicate: false, outcome: 'IGNORED' };
      }
      const session = event.data.object as Stripe.Checkout.Session;
      const checkoutId = session.metadata?.checkoutId;
      const userId = session.metadata?.userId;
      if (!checkoutId || !userId || session.payment_status !== 'paid' || session.currency !== 'jpy') {
        await tx.stripeWebhookEvent.create({ data: { providerEventId: event.id, eventType: event.type, livemode: event.livemode, outcome: 'REJECTED' } });
        return { received: true, duplicate: false, outcome: 'REJECTED' };
      }
      const checkout = await tx.billingCheckout.findUnique({ where: { id: checkoutId } });
      if (!checkout || checkout.userId !== userId || checkout.providerSessionId !== session.id || checkout.amountYen !== session.amount_total || checkout.kind !== session.metadata?.kind || checkout.planCode !== session.metadata?.planCode || (checkout.raceDate ?? '') !== (session.metadata?.raceDate ?? '')) {
        await tx.stripeWebhookEvent.create({ data: { providerEventId: event.id, eventType: event.type, livemode: event.livemode, outcome: 'REJECTED' } });
        return { received: true, duplicate: false, outcome: 'REJECTED' };
      }
      if (checkout.completedAt) {
        await tx.stripeWebhookEvent.create({ data: { providerEventId: event.id, eventType: event.type, livemode: event.livemode, outcome: 'DUPLICATE_CHECKOUT' } });
        return { received: true, duplicate: true, outcome: 'DUPLICATE_CHECKOUT' };
      }
      const now = new Date();
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))::text`;
      const account = await tx.user.findUnique({ where: { id: userId }, select: { role: true, disabledAt: true, accountClosure: { select: { id: true } } } });
      const rejectPaidCheckout = async (outcome: 'REJECTED_ACCOUNT_STATE' | 'REJECTED_EXISTING_ACCESS' | 'REJECTED_FOUNDER_LIMIT') => {
        const providerSubscriptionId = checkout.kind === 'SUBSCRIPTION'
          ? (typeof session.subscription === 'string' ? session.subscription : session.subscription?.id) ?? null
          : null;
        await tx.paymentTransaction.create({ data: { userId, provider: 'STRIPE', providerPaymentId: `checkout:${session.id}`, kind: checkout.kind, status: 'REQUIRES_REVIEW', amountYen: checkout.amountYen, billingCheckoutId: checkout.id } });
        await tx.billingCheckout.update({ where: { id: checkout.id }, data: { status: outcome, completedAt: now, providerSubscriptionId } });
        await tx.stripeWebhookEvent.create({ data: { providerEventId: event.id, eventType: event.type, livemode: event.livemode, outcome } });
        await tx.auditLog.create({ data: { actorId: userId, actorRole: account?.role ?? 'MEMBER', action: 'STRIPE_CHECKOUT_REQUIRES_REVIEW', targetType: 'BillingCheckout', targetId: checkout.id, reason: '決済後にアカウントまたは契約状態の競合を検出', details: { outcome, kind: checkout.kind, planCode: checkout.planCode, amountYen: checkout.amountYen }, requestId: req.requestId } });
        return { received: true, duplicate: false, outcome };
      };
      if (!account || account.role !== 'MEMBER' || account.disabledAt || account.accountClosure) return rejectPaidCheckout('REJECTED_ACCOUNT_STATE');
      if (checkout.kind === 'SUBSCRIPTION') {
        if (await tx.subscription.count({ where: { userId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } })) return rejectPaidCheckout('REJECTED_EXISTING_ACCESS');
        if (checkout.planCode === 'FOUNDER') {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('billing:founder-capacity'))::text`;
          const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { founderSalesLimit: true } });
          if (await tx.subscription.count({ where: { planCode: 'FOUNDER' } }) >= settings.founderSalesLimit) return rejectPaidCheckout('REJECTED_FOUNDER_LIMIT');
        }
      } else if (checkout.raceDate && await tx.dayPass.count({ where: { userId, raceDate: checkout.raceDate } })) {
        return rejectPaidCheckout('REJECTED_EXISTING_ACCESS');
      }
      if (checkout.kind === 'SUBSCRIPTION') {
        const providerSubscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        if (!providerSubscriptionId) throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_MISSING', message: '契約情報を確認できません。' });
        const endsAt = addCalendarMonthUtc(now);
        const entitlement = await tx.entitlement.create({ data: { userId, planCode: checkout.planCode, startsAt: now, endsAt, reason: 'STRIPE_CHECKOUT_COMPLETED', grantedBy: userId } });
        const subscription = await tx.subscription.create({ data: { userId, planCode: checkout.planCode, status: 'ACTIVE', priceYen: checkout.amountYen, currentPeriodStartsAt: now, currentPeriodEndsAt: endsAt, provider: 'STRIPE', providerSubscriptionId, entitlementId: entitlement.id } });
        await tx.paymentTransaction.create({ data: { userId, provider: 'STRIPE', providerPaymentId: `checkout:${session.id}`, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: checkout.amountYen, subscriptionId: subscription.id } });
        await recordBillingEvent(tx, { userId, eventType: 'SUBSCRIPTION_STARTED', subscriptionId: subscription.id, actorId: userId, details: { planCode: checkout.planCode, priceYen: checkout.amountYen, source: 'STRIPE_CHECKOUT' } }, 'BILLING_PAYMENT_SUCCEEDED');
        await tx.billingCheckout.update({ where: { id: checkout.id }, data: { status: 'COMPLETED', completedAt: now, providerSubscriptionId } });
      } else {
        if (!checkout.raceDate) throw new ConflictException({ code: 'DAY_PASS_DATE_MISSING', message: '利用日を確認できません。' });
        const access = await createDayPassAccess(tx, { userId, raceDate: checkout.raceDate, priceYen: checkout.amountYen, provider: 'STRIPE', providerPassId: session.id, reason: 'STRIPE_CHECKOUT_COMPLETED', actorId: userId, source: 'STRIPE_CHECKOUT' });
        const pass = access.pass;
        await tx.paymentTransaction.create({ data: { userId, provider: 'STRIPE', providerPaymentId: `checkout:${session.id}`, kind: 'DAY_PASS', status: 'SUCCEEDED', amountYen: checkout.amountYen, dayPassId: pass.id } });
        await tx.notificationEvent.create({ data: { billingEventId: access.billingEvent.id, eventType: 'BILLING_PAYMENT_SUCCEEDED', status: 'QUEUED', payload: { billingEventId: access.billingEvent.id } } });
        await tx.billingCheckout.update({ where: { id: checkout.id }, data: { status: 'COMPLETED', completedAt: now } });
      }
      await tx.stripeWebhookEvent.create({ data: { providerEventId: event.id, eventType: event.type, livemode: event.livemode, outcome: 'PROCESSED' } });
      await tx.auditLog.create({ data: { actorId: userId, actorRole: 'MEMBER', action: 'STRIPE_CHECKOUT_COMPLETED', targetType: 'BillingCheckout', targetId: checkout.id, reason: '署名済みStripe Webhookによる決済確定', details: { kind: checkout.kind, planCode: checkout.planCode, amountYen: checkout.amountYen }, requestId: req.requestId } });
      return { received: true, duplicate: false, outcome: 'PROCESSED' };
    }, { timeout: 20000, maxWait: 10000 });
  }

  private providerId(value: unknown) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') return (value as { id: string }).id;
    return null;
  }

  private invoiceSubscriptionId(invoice: Record<string, unknown>) {
    const direct = this.providerId(invoice.subscription);
    if (direct) return direct;
    const parent = invoice.parent as { subscription_details?: { subscription?: unknown } } | undefined;
    const fromParent = this.providerId(parent?.subscription_details?.subscription);
    if (fromParent) return fromParent;
    const lines = (invoice.lines as { data?: Array<{ parent?: { subscription_item_details?: { subscription?: unknown } } }> } | undefined)?.data ?? [];
    return lines.map(line => this.providerId(line.parent?.subscription_item_details?.subscription)).find(Boolean) ?? null;
  }

  private invoicePeriod(invoice: Record<string, unknown>) {
    const lines = (invoice.lines as { data?: Array<{ period?: { start?: unknown; end?: unknown } }> } | undefined)?.data ?? [];
    const periods = lines.map(line => line.period).filter((period): period is { start: number; end: number } => typeof period?.start === 'number' && typeof period.end === 'number' && period.end > period.start);
    if (!periods.length) return null;
    return { startsAt: new Date(Math.min(...periods.map(period => period.start)) * 1000), endsAt: new Date(Math.max(...periods.map(period => period.end)) * 1000) };
  }

  private async stripeOutcome(tx: Prisma.TransactionClient, event: Stripe.Event, outcome: string, duplicate = false) {
    await tx.stripeWebhookEvent.create({ data: { providerEventId: event.id, eventType: event.type, livemode: event.livemode, outcome } });
    return { received: true, duplicate, outcome };
  }

  private async isReviewSubscription(tx: Prisma.TransactionClient, providerSubscriptionId: string) {
    return !!await tx.billingCheckout.findFirst({ where: { providerSubscriptionId, status: { in: ['REJECTED_ACCOUNT_STATE', 'REJECTED_EXISTING_ACCESS', 'REJECTED_FOUNDER_LIMIT', 'REVIEW_REFUNDING', 'REVIEW_REFUNDED'] } }, select: { id: true } });
  }

  private async processStripeInvoicePaid(tx: Prisma.TransactionClient, event: Stripe.Event, req: AppRequest) {
    const invoice = event.data.object as unknown as Record<string, unknown>;
    const invoiceId = this.providerId(invoice);
    const providerSubscriptionId = this.invoiceSubscriptionId(invoice);
    const period = this.invoicePeriod(invoice);
    const amountPaid = invoice.amount_paid;
    if (!invoiceId || !providerSubscriptionId || !period || invoice.currency !== 'jpy' || typeof amountPaid !== 'number') return this.stripeOutcome(tx, event, 'REJECTED');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe-invoice:${invoiceId}`}))::text`;
    const subscription = await tx.subscription.findUnique({ where: { providerSubscriptionId }, include: { entitlement: true } });
    if (!subscription) {
      if (await this.isReviewSubscription(tx, providerSubscriptionId)) return this.stripeOutcome(tx, event, 'REVIEW_CHECKOUT_NO_ACCESS');
      throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_PENDING', message: '契約開始イベントの反映を待っています。' });
    }
    if (subscription.provider !== 'STRIPE' || amountPaid !== subscription.priceYen) return this.stripeOutcome(tx, event, 'REJECTED');
    const billingReason = typeof invoice.billing_reason === 'string' ? invoice.billing_reason : null;
    const initialInvoice = billingReason === 'subscription_create';
    const paymentId = `invoice:${invoiceId}:paid`;
    if (!initialInvoice && await tx.paymentTransaction.findUnique({ where: { providerPaymentId: paymentId } })) return this.stripeOutcome(tx, event, 'DUPLICATE_INVOICE', true);
    const now = new Date();
    await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'ACTIVE', currentPeriodStartsAt: period.startsAt, currentPeriodEndsAt: period.endsAt, graceEndsAt: null, updatedAt: now } });
    await tx.entitlement.update({ where: { id: subscription.entitlementId }, data: { startsAt: period.startsAt, endsAt: period.endsAt, revokedAt: null } });
    if (!initialInvoice) await tx.paymentTransaction.create({ data: { userId: subscription.userId, provider: 'STRIPE', providerPaymentId: paymentId, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: amountPaid, subscriptionId: subscription.id } });
    const recovered = subscription.status === 'PAST_DUE';
    await recordBillingEvent(tx, { userId: subscription.userId, eventType: initialInvoice ? 'INITIAL_PERIOD_SYNCHRONIZED' : recovered ? 'PAYMENT_RECOVERED' : 'SUBSCRIPTION_RENEWED', subscriptionId: subscription.id, actorId: subscription.userId, details: { providerInvoiceId: invoiceId, amountYen: amountPaid, currentPeriodStartsAt: period.startsAt.toISOString(), currentPeriodEndsAt: period.endsAt.toISOString() } }, initialInvoice ? undefined : recovered ? 'BILLING_PAYMENT_RECOVERED' : 'BILLING_PAYMENT_SUCCEEDED');
    await tx.auditLog.create({ data: { actorId: subscription.userId, actorRole: 'MEMBER', action: initialInvoice ? 'STRIPE_INITIAL_PERIOD_SYNC' : recovered ? 'STRIPE_PAYMENT_RECOVERED' : 'STRIPE_SUBSCRIPTION_RENEWED', targetType: 'Subscription', targetId: subscription.id, reason: '署名済みStripe請求成功Webhook', details: { amountYen: amountPaid, currentPeriodEndsAt: period.endsAt }, requestId: req.requestId } });
    return this.stripeOutcome(tx, event, 'PROCESSED');
  }

  private async processStripeInvoiceFailed(tx: Prisma.TransactionClient, event: Stripe.Event, req: AppRequest) {
    const invoice = event.data.object as unknown as Record<string, unknown>;
    const invoiceId = this.providerId(invoice);
    const providerSubscriptionId = this.invoiceSubscriptionId(invoice);
    const amountDue = invoice.amount_due;
    if (!invoiceId || !providerSubscriptionId || invoice.currency !== 'jpy' || typeof amountDue !== 'number') return this.stripeOutcome(tx, event, 'REJECTED');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe-invoice:${invoiceId}`}))::text`;
    const subscription = await tx.subscription.findUnique({ where: { providerSubscriptionId }, include: { entitlement: true } });
    if (!subscription) {
      if (await this.isReviewSubscription(tx, providerSubscriptionId)) return this.stripeOutcome(tx, event, 'REVIEW_CHECKOUT_NO_ACCESS');
      throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_PENDING', message: '契約開始イベントの反映を待っています。' });
    }
    if (subscription.provider !== 'STRIPE' || amountDue !== subscription.priceYen || ['CANCELED', 'EXPIRED'].includes(subscription.status)) return this.stripeOutcome(tx, event, 'REJECTED');
    const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
    const now = new Date();
    const graceEndsAt = subscription.status === 'PAST_DUE' && subscription.graceEndsAt
      ? subscription.graceEndsAt
      : new Date(Math.max(now.getTime(), subscription.currentPeriodEndsAt.getTime()) + settings.billingGraceDays * 86400000);
    const accessEndsAt = new Date(Math.max(subscription.currentPeriodEndsAt.getTime(), graceEndsAt.getTime()));
    const finiteEndsAt = accessEndsAt > subscription.entitlement.startsAt ? accessEndsAt : new Date(subscription.entitlement.startsAt.getTime() + 1);
    await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'PAST_DUE', graceEndsAt, updatedAt: now } });
    await tx.entitlement.update({ where: { id: subscription.entitlementId }, data: { endsAt: finiteEndsAt, revokedAt: accessEndsAt <= now ? now : null } });
    await tx.paymentTransaction.create({ data: { userId: subscription.userId, provider: 'STRIPE', providerPaymentId: `invoice:${invoiceId}:failed:${event.id}`, kind: 'SUBSCRIPTION', status: 'FAILED', amountYen: amountDue, subscriptionId: subscription.id } });
    await recordBillingEvent(tx, { userId: subscription.userId, eventType: 'PAYMENT_FAILED', subscriptionId: subscription.id, actorId: subscription.userId, details: { providerInvoiceId: invoiceId, amountYen: amountDue, graceEndsAt: graceEndsAt.toISOString(), accessEndsAt: accessEndsAt.toISOString() } }, 'BILLING_PAYMENT_FAILED');
    await tx.auditLog.create({ data: { actorId: subscription.userId, actorRole: 'MEMBER', action: 'STRIPE_PAYMENT_FAILED', targetType: 'Subscription', targetId: subscription.id, reason: '署名済みStripe請求失敗Webhook', details: { amountYen: amountDue, graceEndsAt, accessEndsAt }, requestId: req.requestId } });
    return this.stripeOutcome(tx, event, 'PROCESSED');
  }

  private async processStripeSubscriptionUpdated(tx: Prisma.TransactionClient, event: Stripe.Event, req: AppRequest) {
    const external = event.data.object as unknown as Record<string, unknown>;
    const providerSubscriptionId = this.providerId(external);
    if (!providerSubscriptionId || typeof external.cancel_at_period_end !== 'boolean') return this.stripeOutcome(tx, event, 'REJECTED');
    const subscription = await tx.subscription.findUnique({ where: { providerSubscriptionId } });
    if (!subscription) {
      if (await this.isReviewSubscription(tx, providerSubscriptionId)) return this.stripeOutcome(tx, event, 'REVIEW_CHECKOUT_NO_ACCESS');
      throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_PENDING', message: '契約開始イベントの反映を待っています。' });
    }
    if (subscription.provider !== 'STRIPE') return this.stripeOutcome(tx, event, 'REJECTED');
    const cancelAtPeriodEnd = external.cancel_at_period_end;
    if (subscription.cancelAtPeriodEnd === cancelAtPeriodEnd) return this.stripeOutcome(tx, event, 'NO_CHANGE');
    const now = new Date();
    const canceledAt = typeof external.canceled_at === 'number' ? new Date(external.canceled_at * 1000) : cancelAtPeriodEnd ? now : null;
    await tx.subscription.update({ where: { id: subscription.id }, data: { cancelAtPeriodEnd, canceledAt, updatedAt: now } });
    await recordBillingEvent(tx, { userId: subscription.userId, eventType: cancelAtPeriodEnd ? 'CANCELLATION_SCHEDULED' : 'CANCELLATION_REVERSED', subscriptionId: subscription.id, actorId: subscription.userId, details: { source: 'STRIPE_SUBSCRIPTION_UPDATED', accessEndsAt: subscription.currentPeriodEndsAt.toISOString() } }, cancelAtPeriodEnd ? 'BILLING_CANCELLATION_SCHEDULED' : 'BILLING_CANCELLATION_REVERSED');
    await tx.auditLog.create({ data: { actorId: subscription.userId, actorRole: 'MEMBER', action: cancelAtPeriodEnd ? 'STRIPE_CANCELLATION_SCHEDULED' : 'STRIPE_CANCELLATION_REVERSED', targetType: 'Subscription', targetId: subscription.id, reason: '署名済みStripe契約更新Webhook', details: { cancelAtPeriodEnd }, requestId: req.requestId } });
    return this.stripeOutcome(tx, event, 'PROCESSED');
  }

  private async processStripeSubscriptionDeleted(tx: Prisma.TransactionClient, event: Stripe.Event, req: AppRequest) {
    const external = event.data.object as unknown as Record<string, unknown>;
    const providerSubscriptionId = this.providerId(external);
    if (!providerSubscriptionId) return this.stripeOutcome(tx, event, 'REJECTED');
    const subscription = await tx.subscription.findUnique({ where: { providerSubscriptionId }, include: { entitlement: true } });
    if (!subscription) {
      if (await this.isReviewSubscription(tx, providerSubscriptionId)) return this.stripeOutcome(tx, event, 'REVIEW_CHECKOUT_NO_ACCESS');
      throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_PENDING', message: '契約開始イベントの反映を待っています。' });
    }
    if (subscription.provider !== 'STRIPE') return this.stripeOutcome(tx, event, 'REJECTED');
    if (subscription.status === 'CANCELED' && subscription.entitlement.revokedAt) return this.stripeOutcome(tx, event, 'NO_CHANGE');
    const now = new Date();
    const canceledAt = typeof external.canceled_at === 'number' ? new Date(external.canceled_at * 1000) : now;
    await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'CANCELED', cancelAtPeriodEnd: false, canceledAt, graceEndsAt: null, updatedAt: now } });
    await tx.entitlement.update({ where: { id: subscription.entitlementId }, data: { revokedAt: now } });
    await recordBillingEvent(tx, { userId: subscription.userId, eventType: 'SUBSCRIPTION_ENDED', subscriptionId: subscription.id, actorId: subscription.userId, details: { source: 'STRIPE_SUBSCRIPTION_DELETED', canceledAt: canceledAt.toISOString() } }, 'BILLING_SUBSCRIPTION_ENDED');
    await tx.auditLog.create({ data: { actorId: subscription.userId, actorRole: 'MEMBER', action: 'STRIPE_SUBSCRIPTION_ENDED', targetType: 'Subscription', targetId: subscription.id, reason: '署名済みStripe契約終了Webhook', details: { canceledAt }, requestId: req.requestId } });
    return this.stripeOutcome(tx, event, 'PROCESSED');
  }

  private async resolveStripeRefundContext(client: Stripe, refund: Stripe.Refund): Promise<StripeRefundContext> {
    const direct = refund.metadata ?? {};
    if (direct.checkoutId) return { checkoutId: direct.checkoutId };
    if (direct.dayPassId) return { dayPassId: direct.dayPassId };
    if (direct.subscriptionId) return { subscriptionId: direct.subscriptionId };
    const paymentIntentId = this.providerId(refund.payment_intent);
    if (!paymentIntentId) return {};
    const expanded = refund.payment_intent && typeof refund.payment_intent === 'object' ? refund.payment_intent : await client.paymentIntents.retrieve(paymentIntentId);
    if (expanded.metadata?.checkoutId) return { checkoutId: expanded.metadata.checkoutId };
    if (expanded.metadata?.dayPassId) return { dayPassId: expanded.metadata.dayPassId };
    if (expanded.metadata?.subscriptionId) return { subscriptionId: expanded.metadata.subscriptionId };
    const payments = await client.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 10 });
    const invoiceId = payments.data.map(item => this.providerId(item.invoice)).find(Boolean);
    if (!invoiceId) return {};
    const invoice = await client.invoices.retrieve(invoiceId);
    const providerSubscriptionId = this.invoiceSubscriptionId(invoice as unknown as Record<string, unknown>);
    return providerSubscriptionId ? { providerSubscriptionId } : {};
  }

  private async processStripeRefund(tx: Prisma.TransactionClient, event: Stripe.Event, req: AppRequest, context: StripeRefundContext) {
    const refund = event.data.object as Stripe.Refund;
    if (refund.status !== 'succeeded' || refund.currency !== 'jpy' || !Number.isInteger(refund.amount) || refund.amount <= 0) return this.stripeOutcome(tx, event, refund.status === 'failed' || refund.status === 'canceled' ? 'REFUND_FAILED' : 'REFUND_PENDING');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe-refund:${refund.id}`}))::text`;
    const providerPaymentId = `refund:${refund.id}`;
    if (await tx.paymentTransaction.findUnique({ where: { providerPaymentId } })) return this.stripeOutcome(tx, event, 'DUPLICATE_REFUND', true);
    const checkout = context.checkoutId ? await tx.billingCheckout.findUnique({ where: { id: context.checkoutId } }) : null;
    const dayPass = context.dayPassId ? await tx.dayPass.findUnique({ where: { id: context.dayPassId } }) : null;
    const subscription = context.subscriptionId
      ? await tx.subscription.findUnique({ where: { id: context.subscriptionId } })
      : context.providerSubscriptionId ? await tx.subscription.findUnique({ where: { providerSubscriptionId: context.providerSubscriptionId } }) : null;
    const targetCount = Number(!!checkout) + Number(!!dayPass) + Number(!!subscription);
    if (targetCount !== 1) return this.stripeOutcome(tx, event, 'REFUND_REQUIRES_REVIEW');
    if (checkout) {
      await tx.paymentTransaction.create({ data: { userId: checkout.userId, provider: 'STRIPE', providerPaymentId, kind: checkout.kind, status: 'REFUNDED', amountYen: refund.amount, billingCheckoutId: checkout.id } });
      const fullyRefunded = refund.amount >= checkout.amountYen;
      if (fullyRefunded && ['REJECTED_ACCOUNT_STATE', 'REJECTED_EXISTING_ACCESS', 'REJECTED_FOUNDER_LIMIT', 'REVIEW_REFUNDING'].includes(checkout.status)) await tx.billingCheckout.update({ where: { id: checkout.id }, data: { status: 'REVIEW_REFUNDED' } });
      await recordBillingEvent(tx, { userId: checkout.userId, eventType: 'CHECKOUT_PAYMENT_REFUNDED', billingCheckoutId: checkout.id, actorId: checkout.userId, details: { checkoutId: checkout.id, amountYen: refund.amount, providerRefundId: refund.id, fullRefund: fullyRefunded, source: 'STRIPE_WEBHOOK' } }, 'BILLING_REFUND_COMPLETED');
      await tx.auditLog.create({ data: { actorId: checkout.userId, actorRole: 'MEMBER', action: 'STRIPE_CHECKOUT_REFUND_SYNCHRONIZED', targetType: 'BillingCheckout', targetId: checkout.id, reason: '署名済みStripe返金Webhook', details: { amountYen: refund.amount, fullRefund: fullyRefunded }, requestId: req.requestId } });
    } else if (dayPass) {
      await tx.paymentTransaction.create({ data: { userId: dayPass.userId, provider: 'STRIPE', providerPaymentId, kind: 'DAY_PASS', status: 'REFUNDED', amountYen: refund.amount, dayPassId: dayPass.id } });
      const succeeded = await tx.paymentTransaction.aggregate({ where: { dayPassId: dayPass.id, status: 'SUCCEEDED' }, _sum: { amountYen: true } });
      const refunded = await tx.paymentTransaction.aggregate({ where: { dayPassId: dayPass.id, status: 'REFUNDED' }, _sum: { amountYen: true } });
      const fullyRefunded = (refunded._sum.amountYen ?? 0) >= (succeeded._sum.amountYen ?? dayPass.priceYen);
      if (fullyRefunded && !dayPass.startsAt && !dayPass.entitlementId && ['PENDING', 'REFUNDING'].includes(dayPass.status)) await tx.dayPass.update({ where: { id: dayPass.id }, data: { status: 'REFUNDED', updatedAt: new Date() } });
      await recordBillingEvent(tx, { userId: dayPass.userId, eventType: 'DAY_PASS_REFUNDED', dayPassId: dayPass.id, actorId: dayPass.userId, details: { amountYen: refund.amount, raceDate: dayPass.raceDate, providerRefundId: refund.id, fullRefund: fullyRefunded, accessPreserved: !!dayPass.startsAt, source: 'STRIPE_WEBHOOK' } }, 'BILLING_REFUND_COMPLETED');
      await tx.auditLog.create({ data: { actorId: dayPass.userId, actorRole: 'MEMBER', action: 'STRIPE_DAY_PASS_REFUND_SYNCHRONIZED', targetType: 'DayPass', targetId: dayPass.id, reason: '署名済みStripe返金Webhook', details: { amountYen: refund.amount, fullRefund: fullyRefunded, accessPreserved: !!dayPass.startsAt }, requestId: req.requestId } });
    } else if (subscription) {
      await tx.paymentTransaction.create({ data: { userId: subscription.userId, provider: 'STRIPE', providerPaymentId, kind: 'SUBSCRIPTION', status: 'REFUNDED', amountYen: refund.amount, subscriptionId: subscription.id } });
      await recordBillingEvent(tx, { userId: subscription.userId, eventType: 'SUBSCRIPTION_PAYMENT_REFUNDED', subscriptionId: subscription.id, actorId: subscription.userId, details: { amountYen: refund.amount, providerRefundId: refund.id, accessPreserved: true, source: 'STRIPE_WEBHOOK' } }, 'BILLING_REFUND_COMPLETED');
      await tx.auditLog.create({ data: { actorId: subscription.userId, actorRole: 'MEMBER', action: 'STRIPE_SUBSCRIPTION_REFUND_SYNCHRONIZED', targetType: 'Subscription', targetId: subscription.id, reason: '署名済みStripe返金Webhook', details: { amountYen: refund.amount, accessPreserved: true }, requestId: req.requestId } });
    }
    return this.stripeOutcome(tx, event, 'PROCESSED');
  }

  private async stripeConfig() {
    const config = await loadStripeConfig(this.db);
    if (!config.usable) throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED', message: '外部決済の設定が完了していません。' });
    return config;
  }

  private stripeClient(config: StripeRuntimeConfig) {
    return new Stripe(config.secretKey!);
  }
}
