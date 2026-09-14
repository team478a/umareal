import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { addCalendarMonthUtc, canManage, dayPassCheckoutSchema, dayPassWindow, jstDate, requiresMfa, subscriptionCheckoutSchema } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';
import Stripe from 'stripe';
import { loadStripeConfig, type StripeRuntimeConfig } from './stripe-config';

const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

@Controller()
export class BillingController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private transport() {
    const transport = process.env.BILLING_TRANSPORT;
    if (transport !== 'test' && transport !== 'stripe') throw new ServiceUnavailableException({ code: 'BILLING_TRANSPORT_UNAVAILABLE', message: 'この環境では申込を処理できません。' });
    return transport;
  }
  private key(req: AppRequest, prefix: string, userId: string) {
    return `${prefix}:${userId}:${z.string().uuid().parse(req.headers['idempotency-key'])}`;
  }
  private async staff(req: AppRequest, roles: Role[]) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, roles)) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '管理権限と二段階認証を確認してください。' });
    return actor;
  }

  @Get('billing/plans')
  async plans() {
    const settings = await this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
    const founderSold = await this.auth.db.subscription.count({ where: { planCode: 'FOUNDER', status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'] } } });
    const stripeConfig = process.env.BILLING_TRANSPORT === 'stripe' ? await loadStripeConfig(this.auth.db) : null;
    const transportAvailable = process.env.BILLING_TRANSPORT === 'test' || (process.env.BILLING_TRANSPORT === 'stripe' && stripeConfig?.usable);
    return { newPurchasesEnabled: settings.newPurchasesEnabled, developmentTerms: true, billingTransport: process.env.BILLING_TRANSPORT, currency: 'JPY', taxIncluded: true,
      plans: [
        { code: 'FOUNDER', name: '創設会員', priceYen: settings.founderPriceYen, interval: 'MONTH', available: transportAvailable && settings.newPurchasesEnabled && settings.founderSalesEnabled && founderSold < settings.founderSalesLimit, remaining: Math.max(0, settings.founderSalesLimit - founderSold) },
        { code: 'STANDARD', name: '通常会員', priceYen: settings.standardPriceYen, interval: 'MONTH', available: transportAvailable && settings.newPurchasesEnabled },
        { code: 'DAY_PASS', name: '1日利用', priceYen: settings.dayPassPriceYen, interval: 'JST_DAY', available: transportAvailable && settings.newPurchasesEnabled }
      ] };
  }

  @Get('billing/me')
  async mine(@Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    const [subscriptions, dayPasses, payments] = await Promise.all([
      this.auth.db.subscription.findMany({ where: { userId: actor.id }, orderBy: { createdAt: 'desc' } }),
      this.auth.db.dayPass.findMany({ where: { userId: actor.id }, orderBy: { createdAt: 'desc' } }),
      this.auth.db.paymentTransaction.findMany({ where: { userId: actor.id }, select: { id: true, provider: true, providerPaymentId: true, kind: true, status: true, amountYen: true, subscriptionId: true, dayPassId: true, occurredAt: true }, orderBy: { occurredAt: 'desc' } })
    ]);
    return { subscriptions, dayPasses, payments };
  }

  @Post('billing/checkout')
  async checkout(@Req() req: AppRequest, @Body() body: unknown) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); const input = subscriptionCheckoutSchema.parse(body);
    if (!actor.user.emailVerifiedAt || !actor.user.passwordHash) throw new ForbiddenException({ code: 'FALLBACK_AUTH_REQUIRED', message: '申込前に確認済みメールアドレスとパスワードを設定してください。' });
    const key = this.key(req, 'subscription-checkout', actor.id); const requestHash = hashToken(JSON.stringify(input));
    if (transport === 'stripe') return this.createStripeCheckout(req, actor.id, actor.user.email, 'SUBSCRIPTION', input.planCode, null, key, requestHash);
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${actor.id}`}))::text`;
        const previous = await tx.idempotencyKey.findUnique({ where: { key } });
        if (previous) { if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ申込キーが異なる内容で使われています。' }); return previous.response; }
        const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
        if (!settings.newPurchasesEnabled) throw new ServiceUnavailableException({ code: 'PURCHASES_STOPPED', message: '現在、新規購入を停止しています。' });
        if (await tx.subscription.count({ where: { userId: actor.id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } })) throw new ConflictException({ code: 'ACTIVE_SUBSCRIPTION_EXISTS', message: '有効な月額契約があります。' });
        if (input.planCode === 'FOUNDER') {
          if (!settings.founderSalesEnabled) throw new ConflictException({ code: 'FOUNDER_SALES_CLOSED', message: '創設会員プランは販売していません。' });
          const sold = await tx.subscription.count({ where: { planCode: 'FOUNDER' } });
          if (sold >= settings.founderSalesLimit) throw new ConflictException({ code: 'FOUNDER_LIMIT_REACHED', message: '創設会員プランは販売上限に達しました。' });
        }
        const now = new Date(); const endsAt = addCalendarMonthUtc(now); const priceYen = input.planCode === 'FOUNDER' ? settings.founderPriceYen : settings.standardPriceYen;
        const entitlement = await tx.entitlement.create({ data: { userId: actor.id, planCode: input.planCode, startsAt: now, endsAt, reason: 'LOCAL_TEST_SUBSCRIPTION', grantedBy: actor.id } });
        const subscription = await tx.subscription.create({ data: { userId: actor.id, planCode: input.planCode, status: 'ACTIVE', priceYen, currentPeriodStartsAt: now, currentPeriodEndsAt: endsAt, provider: 'LOCAL_TEST', providerSubscriptionId: `local-sub-${randomUUID()}`, entitlementId: entitlement.id } });
        const payment = await tx.paymentTransaction.create({ data: { userId: actor.id, provider: 'LOCAL_TEST', providerPaymentId: `local-pay-${randomUUID()}`, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: priceYen, subscriptionId: subscription.id } });
        await tx.billingEvent.create({ data: { userId: actor.id, eventType: 'SUBSCRIPTION_STARTED', subscriptionId: subscription.id, actorId: actor.id, details: { planCode: input.planCode, priceYen, developmentSimulation: true } } });
        const response = { subscriptionId: subscription.id, paymentId: payment.id, status: subscription.status, currentPeriodEndsAt: endsAt };
        await tx.idempotencyKey.create({ data: { key, requestHash, response } }); return response;
      }, { timeout: 20000, maxWait: 10000 });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (previous?.requestHash === requestHash) return previous.response;
      throw new ConflictException({ code: 'BILLING_CONFLICT', message: '申込状態が競合しました。再読み込みしてください。' });
    }
  }

  @Post('billing/day-pass')
  async dayPass(@Req() req: AppRequest, @Body() body: unknown) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); const input = dayPassCheckoutSchema.parse(body);
    if (!actor.user.emailVerifiedAt || !actor.user.passwordHash) throw new ForbiddenException({ code: 'FALLBACK_AUTH_REQUIRED', message: '申込前に確認済みメールアドレスとパスワードを設定してください。' });
    if (input.raceDate < jstDate(new Date())) throw new BadRequestException({ code: 'PAST_RACE_DATE', message: '過去の日付は購入できません。' });
    const key = this.key(req, 'day-pass', actor.id); const requestHash = hashToken(JSON.stringify(input));
    if (transport === 'stripe') return this.createStripeCheckout(req, actor.id, actor.user.email, 'DAY_PASS', 'DAY_PASS', input.raceDate, key, requestHash);
    try {
      return await this.auth.db.$transaction(async tx => {
        const previous = await tx.idempotencyKey.findUnique({ where: { key } });
        if (previous) { if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ申込キーが異なる内容で使われています。' }); return previous.response; }
        const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
        if (!settings.newPurchasesEnabled) throw new ServiceUnavailableException({ code: 'PURCHASES_STOPPED', message: '現在、新規購入を停止しています。' });
        const window = dayPassWindow(input.raceDate);
        const entitlement = await tx.entitlement.create({ data: { userId: actor.id, planCode: 'DAY_PASS', ...window, raceDate: input.raceDate, reason: 'LOCAL_TEST_DAY_PASS', grantedBy: actor.id } });
        const pass = await tx.dayPass.create({ data: { userId: actor.id, raceDate: input.raceDate, status: 'ACTIVE', priceYen: settings.dayPassPriceYen, ...window, provider: 'LOCAL_TEST', providerPassId: `local-pass-${randomUUID()}`, entitlementId: entitlement.id } });
        const payment = await tx.paymentTransaction.create({ data: { userId: actor.id, provider: 'LOCAL_TEST', providerPaymentId: `local-pay-${randomUUID()}`, kind: 'DAY_PASS', status: 'SUCCEEDED', amountYen: settings.dayPassPriceYen, dayPassId: pass.id } });
        await tx.billingEvent.create({ data: { userId: actor.id, eventType: 'DAY_PASS_STARTED', dayPassId: pass.id, actorId: actor.id, details: { raceDate: input.raceDate, priceYen: settings.dayPassPriceYen, developmentSimulation: true } } });
        const response = { dayPassId: pass.id, paymentId: payment.id, status: pass.status, ...window };
        await tx.idempotencyKey.create({ data: { key, requestHash, response } }); return response;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (previous?.requestHash === requestHash) return previous.response;
      throw new ConflictException({ code: 'DAY_PASS_EXISTS', message: 'この開催日の1日利用は登録済みです。' });
    }
  }

  @Post('webhooks/stripe')
  async stripeWebhook(@Req() req: AppRequest) {
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
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe-event:${event.id}`}))::text`;
      const previous = await tx.stripeWebhookEvent.findUnique({ where: { providerEventId: event.id } });
      if (previous) return { received: true, duplicate: true, outcome: previous.outcome };
      if (event.type === 'invoice.paid') return this.processStripeInvoicePaid(tx, event, req);
      if (event.type === 'invoice.payment_failed') return this.processStripeInvoiceFailed(tx, event, req);
      if (event.type === 'customer.subscription.updated') return this.processStripeSubscriptionUpdated(tx, event, req);
      if (event.type === 'customer.subscription.deleted') return this.processStripeSubscriptionDeleted(tx, event, req);
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
      if (checkout.status === 'COMPLETED') {
        await tx.stripeWebhookEvent.create({ data: { providerEventId: event.id, eventType: event.type, livemode: event.livemode, outcome: 'DUPLICATE_CHECKOUT' } });
        return { received: true, duplicate: true, outcome: 'DUPLICATE_CHECKOUT' };
      }
      const now = new Date();
      if (checkout.kind === 'SUBSCRIPTION') {
        const providerSubscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        if (!providerSubscriptionId) throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_MISSING', message: '契約情報を確認できません。' });
        const endsAt = addCalendarMonthUtc(now);
        const entitlement = await tx.entitlement.create({ data: { userId, planCode: checkout.planCode, startsAt: now, endsAt, reason: 'STRIPE_CHECKOUT_COMPLETED', grantedBy: userId } });
        const subscription = await tx.subscription.create({ data: { userId, planCode: checkout.planCode, status: 'ACTIVE', priceYen: checkout.amountYen, currentPeriodStartsAt: now, currentPeriodEndsAt: endsAt, provider: 'STRIPE', providerSubscriptionId, entitlementId: entitlement.id } });
        await tx.paymentTransaction.create({ data: { userId, provider: 'STRIPE', providerPaymentId: `checkout:${session.id}`, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: checkout.amountYen, subscriptionId: subscription.id } });
        await tx.billingEvent.create({ data: { userId, eventType: 'SUBSCRIPTION_STARTED', subscriptionId: subscription.id, actorId: userId, details: { planCode: checkout.planCode, priceYen: checkout.amountYen, source: 'STRIPE_CHECKOUT' } } });
        await tx.billingCheckout.update({ where: { id: checkout.id }, data: { status: 'COMPLETED', completedAt: now, providerSubscriptionId } });
      } else {
        if (!checkout.raceDate) throw new ConflictException({ code: 'DAY_PASS_DATE_MISSING', message: '利用日を確認できません。' });
        const window = dayPassWindow(checkout.raceDate);
        const entitlement = await tx.entitlement.create({ data: { userId, planCode: 'DAY_PASS', ...window, raceDate: checkout.raceDate, reason: 'STRIPE_CHECKOUT_COMPLETED', grantedBy: userId } });
        const pass = await tx.dayPass.create({ data: { userId, raceDate: checkout.raceDate, status: 'ACTIVE', priceYen: checkout.amountYen, ...window, provider: 'STRIPE', providerPassId: session.id, entitlementId: entitlement.id } });
        await tx.paymentTransaction.create({ data: { userId, provider: 'STRIPE', providerPaymentId: `checkout:${session.id}`, kind: 'DAY_PASS', status: 'SUCCEEDED', amountYen: checkout.amountYen, dayPassId: pass.id } });
        await tx.billingEvent.create({ data: { userId, eventType: 'DAY_PASS_STARTED', dayPassId: pass.id, actorId: userId, details: { raceDate: checkout.raceDate, priceYen: checkout.amountYen, source: 'STRIPE_CHECKOUT' } } });
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

  private async processStripeInvoicePaid(tx: Prisma.TransactionClient, event: Stripe.Event, req: AppRequest) {
    const invoice = event.data.object as unknown as Record<string, unknown>;
    const invoiceId = this.providerId(invoice);
    const providerSubscriptionId = this.invoiceSubscriptionId(invoice);
    const period = this.invoicePeriod(invoice);
    const amountPaid = invoice.amount_paid;
    if (!invoiceId || !providerSubscriptionId || !period || invoice.currency !== 'jpy' || typeof amountPaid !== 'number') return this.stripeOutcome(tx, event, 'REJECTED');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`stripe-invoice:${invoiceId}`}))::text`;
    const subscription = await tx.subscription.findUnique({ where: { providerSubscriptionId }, include: { entitlement: true } });
    if (!subscription) throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_PENDING', message: '契約開始イベントの反映を待っています。' });
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
    await tx.billingEvent.create({ data: { userId: subscription.userId, eventType: initialInvoice ? 'INITIAL_PERIOD_SYNCHRONIZED' : recovered ? 'PAYMENT_RECOVERED' : 'SUBSCRIPTION_RENEWED', subscriptionId: subscription.id, actorId: subscription.userId, details: { providerInvoiceId: invoiceId, amountYen: amountPaid, currentPeriodStartsAt: period.startsAt.toISOString(), currentPeriodEndsAt: period.endsAt.toISOString() } } });
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
    if (!subscription) throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_PENDING', message: '契約開始イベントの反映を待っています。' });
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
    await tx.billingEvent.create({ data: { userId: subscription.userId, eventType: 'PAYMENT_FAILED', subscriptionId: subscription.id, actorId: subscription.userId, details: { providerInvoiceId: invoiceId, amountYen: amountDue, graceEndsAt: graceEndsAt.toISOString(), accessEndsAt: accessEndsAt.toISOString() } } });
    await tx.auditLog.create({ data: { actorId: subscription.userId, actorRole: 'MEMBER', action: 'STRIPE_PAYMENT_FAILED', targetType: 'Subscription', targetId: subscription.id, reason: '署名済みStripe請求失敗Webhook', details: { amountYen: amountDue, graceEndsAt, accessEndsAt }, requestId: req.requestId } });
    return this.stripeOutcome(tx, event, 'PROCESSED');
  }

  private async processStripeSubscriptionUpdated(tx: Prisma.TransactionClient, event: Stripe.Event, req: AppRequest) {
    const external = event.data.object as unknown as Record<string, unknown>;
    const providerSubscriptionId = this.providerId(external);
    if (!providerSubscriptionId || typeof external.cancel_at_period_end !== 'boolean') return this.stripeOutcome(tx, event, 'REJECTED');
    const subscription = await tx.subscription.findUnique({ where: { providerSubscriptionId } });
    if (!subscription) throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_PENDING', message: '契約開始イベントの反映を待っています。' });
    if (subscription.provider !== 'STRIPE') return this.stripeOutcome(tx, event, 'REJECTED');
    const cancelAtPeriodEnd = external.cancel_at_period_end;
    if (subscription.cancelAtPeriodEnd === cancelAtPeriodEnd) return this.stripeOutcome(tx, event, 'NO_CHANGE');
    const now = new Date();
    const canceledAt = typeof external.canceled_at === 'number' ? new Date(external.canceled_at * 1000) : cancelAtPeriodEnd ? now : null;
    await tx.subscription.update({ where: { id: subscription.id }, data: { cancelAtPeriodEnd, canceledAt, updatedAt: now } });
    await tx.billingEvent.create({ data: { userId: subscription.userId, eventType: cancelAtPeriodEnd ? 'CANCELLATION_SCHEDULED' : 'CANCELLATION_REVERSED', subscriptionId: subscription.id, actorId: subscription.userId, details: { source: 'STRIPE_SUBSCRIPTION_UPDATED', accessEndsAt: subscription.currentPeriodEndsAt.toISOString() } } });
    await tx.auditLog.create({ data: { actorId: subscription.userId, actorRole: 'MEMBER', action: cancelAtPeriodEnd ? 'STRIPE_CANCELLATION_SCHEDULED' : 'STRIPE_CANCELLATION_REVERSED', targetType: 'Subscription', targetId: subscription.id, reason: '署名済みStripe契約更新Webhook', details: { cancelAtPeriodEnd }, requestId: req.requestId } });
    return this.stripeOutcome(tx, event, 'PROCESSED');
  }

  private async processStripeSubscriptionDeleted(tx: Prisma.TransactionClient, event: Stripe.Event, req: AppRequest) {
    const external = event.data.object as unknown as Record<string, unknown>;
    const providerSubscriptionId = this.providerId(external);
    if (!providerSubscriptionId) return this.stripeOutcome(tx, event, 'REJECTED');
    const subscription = await tx.subscription.findUnique({ where: { providerSubscriptionId }, include: { entitlement: true } });
    if (!subscription) throw new ConflictException({ code: 'STRIPE_SUBSCRIPTION_PENDING', message: '契約開始イベントの反映を待っています。' });
    if (subscription.provider !== 'STRIPE') return this.stripeOutcome(tx, event, 'REJECTED');
    if (subscription.status === 'CANCELED' && subscription.entitlement.revokedAt) return this.stripeOutcome(tx, event, 'NO_CHANGE');
    const now = new Date();
    const canceledAt = typeof external.canceled_at === 'number' ? new Date(external.canceled_at * 1000) : now;
    await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'CANCELED', cancelAtPeriodEnd: false, canceledAt, graceEndsAt: null, updatedAt: now } });
    await tx.entitlement.update({ where: { id: subscription.entitlementId }, data: { revokedAt: now } });
    await tx.billingEvent.create({ data: { userId: subscription.userId, eventType: 'SUBSCRIPTION_ENDED', subscriptionId: subscription.id, actorId: subscription.userId, details: { source: 'STRIPE_SUBSCRIPTION_DELETED', canceledAt: canceledAt.toISOString() } } });
    await tx.auditLog.create({ data: { actorId: subscription.userId, actorRole: 'MEMBER', action: 'STRIPE_SUBSCRIPTION_ENDED', targetType: 'Subscription', targetId: subscription.id, reason: '署名済みStripe契約終了Webhook', details: { canceledAt }, requestId: req.requestId } });
    return this.stripeOutcome(tx, event, 'PROCESSED');
  }

  private async stripeConfig() {
    const config = await loadStripeConfig(this.auth.db);
    if (!config.usable) throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED', message: '外部決済の設定が完了していません。' });
    return config;
  }

  private stripeClient(config: StripeRuntimeConfig) {
    return new Stripe(config.secretKey!);
  }

  private async createStripeCheckout(req: AppRequest, userId: string, email: string | null, kind: 'SUBSCRIPTION' | 'DAY_PASS', planCode: 'FOUNDER' | 'STANDARD' | 'DAY_PASS', raceDate: string | null, idempotencyKey: string, requestHash: string) {
    if (!email) throw new ForbiddenException({ code: 'VERIFIED_EMAIL_REQUIRED', message: '確認済みメールアドレスが必要です。' });
    const settings = await this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
    if (!settings.newPurchasesEnabled) throw new ServiceUnavailableException({ code: 'PURCHASES_STOPPED', message: '現在、新規購入を停止しています。' });
    if (kind === 'SUBSCRIPTION' && await this.auth.db.subscription.count({ where: { userId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } })) throw new ConflictException({ code: 'ACTIVE_SUBSCRIPTION_EXISTS', message: '有効な月額契約があります。' });
    if (planCode === 'FOUNDER') {
      if (!settings.founderSalesEnabled) throw new ConflictException({ code: 'FOUNDER_SALES_CLOSED', message: '創設会員プランは販売していません。' });
      if (await this.auth.db.subscription.count({ where: { planCode: 'FOUNDER' } }) >= settings.founderSalesLimit) throw new ConflictException({ code: 'FOUNDER_LIMIT_REACHED', message: '創設会員プランは販売上限に達しました。' });
    }
    if (kind === 'DAY_PASS' && await this.auth.db.dayPass.count({ where: { userId, raceDate: raceDate! } })) throw new ConflictException({ code: 'DAY_PASS_EXISTS', message: 'この開催日の1日利用は登録済みです。' });
    const amountYen = planCode === 'FOUNDER' ? settings.founderPriceYen : planCode === 'STANDARD' ? settings.standardPriceYen : settings.dayPassPriceYen;
    const existing = await this.auth.db.billingCheckout.findUnique({ where: { idempotencyKey } });
    if (existing?.requestHash !== undefined && existing.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ申込キーが異なる内容で使われています。' });
    if (existing?.providerSessionId && existing.providerCheckoutUrl) return { checkoutId: existing.id, checkoutUrl: existing.providerCheckoutUrl, status: existing.status };
    const checkout = existing ?? await this.auth.db.billingCheckout.create({ data: { userId, kind, planCode, raceDate, amountYen, idempotencyKey, requestHash, expiresAt: new Date(Date.now() + 30 * 60000) } });
    const stripeConfig = await this.stripeConfig();
    const price = planCode === 'FOUNDER' ? stripeConfig.priceFounder : planCode === 'STANDARD' ? stripeConfig.priceStandard : stripeConfig.priceDayPass;
    const metadata = { checkoutId: checkout.id, userId, kind, planCode, raceDate: raceDate ?? '' };
    const baseUrl = process.env.APP_BASE_URL!;
    const session = await this.stripeClient(stripeConfig).checkout.sessions.create({ mode: kind === 'SUBSCRIPTION' ? 'subscription' : 'payment', payment_method_types: ['card'], client_reference_id: checkout.id, customer_email: email, line_items: [{ price: price!, quantity: 1 }], metadata, ...(kind === 'SUBSCRIPTION' ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }), success_url: `${baseUrl}/account?checkout=success`, cancel_url: `${baseUrl}/plans?checkout=canceled`, expires_at: Math.floor(checkout.expiresAt.getTime() / 1000) }, { idempotencyKey });
    if (!session.url) throw new ServiceUnavailableException({ code: 'STRIPE_CHECKOUT_URL_MISSING', message: '決済画面を開始できませんでした。' });
    await this.auth.db.billingCheckout.update({ where: { id: checkout.id }, data: { status: 'OPEN', providerSessionId: session.id, providerCheckoutUrl: session.url, expiresAt: new Date(session.expires_at * 1000) } });
    await this.auth.audit(this.auth.db, req, 'STRIPE_CHECKOUT_CREATED', checkout.id, '会員本人による外部決済開始', { kind, planCode, amountYen, raceDate });
    return { checkoutId: checkout.id, checkoutUrl: session.url, status: 'OPEN' };
  }

  @Post('billing/subscriptions/:id/cancel')
  async cancel(@Param('id') id: string, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); z.string().uuid().parse(id);
    if (transport === 'stripe') {
      const external = await this.auth.db.subscription.findUnique({ where: { id } });
      if (!external || external.userId !== actor.id) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
      if (external.provider !== 'STRIPE') throw new ConflictException({ code: 'SUBSCRIPTION_PROVIDER_MISMATCH', message: '外部決済の契約ではありません。' });
      if (!external.cancelAtPeriodEnd) { const stripeConfig = await this.stripeConfig(); await this.stripeClient(stripeConfig).subscriptions.update(external.providerSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `cancel-at-period-end:${external.id}` }); }
    }
    return this.auth.db.$transaction(async tx => {
      const current = await tx.subscription.findUnique({ where: { id } });
      if (!current || current.userId !== actor.id) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
      if (current.cancelAtPeriodEnd) return { id, status: current.status, cancelAtPeriodEnd: true, accessEndsAt: current.currentPeriodEndsAt };
      if (!['ACTIVE', 'PAST_DUE', 'TRIALING'].includes(current.status)) throw new ConflictException({ code: 'SUBSCRIPTION_NOT_CANCELABLE', message: 'この契約は解約予約できません。' });
      const now = new Date(); const subscription = await tx.subscription.update({ where: { id }, data: { cancelAtPeriodEnd: true, canceledAt: now } });
      await tx.billingEvent.create({ data: { userId: actor.id, eventType: 'CANCELLATION_SCHEDULED', subscriptionId: id, actorId: actor.id, details: { accessEndsAt: current.currentPeriodEndsAt.toISOString() } } });
      await this.auth.audit(tx, req, 'SUBSCRIPTION_CANCEL_SCHEDULE', id, '会員本人による解約予約', { accessEndsAt: current.currentPeriodEndsAt });
      return { id, status: subscription.status, cancelAtPeriodEnd: true, accessEndsAt: current.currentPeriodEndsAt };
    });
  }

  @Get('admin/billing')
  async admin(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    const [subscriptions, dayPasses, payments, checkouts, stripeWebhooks] = await Promise.all([
      this.auth.db.subscription.findMany({ include: { user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.auth.db.dayPass.findMany({ include: { user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.auth.db.paymentTransaction.findMany({ select: { id: true, provider: true, providerPaymentId: true, kind: true, status: true, amountYen: true, subscriptionId: true, dayPassId: true, occurredAt: true, user: { select: { email: true, displayName: true } } }, orderBy: { occurredAt: 'desc' }, take: 100 }),
      this.auth.db.billingCheckout.findMany({ select: { id: true, kind: true, planCode: true, raceDate: true, amountYen: true, status: true, createdAt: true, expiresAt: true, completedAt: true, user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.auth.db.stripeWebhookEvent.findMany({ select: { id: true, providerEventId: true, eventType: true, livemode: true, outcome: true, receivedAt: true }, orderBy: { receivedAt: 'desc' }, take: 100 })
    ]); return { billingTransport: process.env.BILLING_TRANSPORT, subscriptions, dayPasses, payments, checkouts, stripeWebhooks };
  }

  @Post('admin/billing/subscriptions/:id/simulate-failure')
  async fail(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.staff(req, ['ADMIN']);
    if (transport !== 'test') throw new ConflictException({ code: 'LOCAL_BILLING_SIMULATION_DISABLED', message: '外部決済契約はWebhookから同期してください。' });
    const { reason } = reasonSchema.parse(body); z.string().uuid().parse(id);
    return this.auth.db.$transaction(async tx => {
      const current = await tx.subscription.findUniqueOrThrow({ where: { id } }); const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
      if (!['ACTIVE', 'PAST_DUE'].includes(current.status)) throw new ConflictException({ code: 'SUBSCRIPTION_NOT_OPEN', message: '有効な契約だけを試験できます。' });
      const now = new Date(); const graceEndsAt = new Date(now.getTime() + settings.billingGraceDays * 86400000);
      await tx.subscription.update({ where: { id }, data: { status: 'PAST_DUE', graceEndsAt } });
      await tx.entitlement.update({ where: { id: current.entitlementId }, data: { endsAt: graceEndsAt > now ? graceEndsAt : new Date(now.getTime() + 1), revokedAt: settings.billingGraceDays ? null : now } });
      await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'LOCAL_TEST', providerPaymentId: `local-failed-${randomUUID()}`, kind: 'SUBSCRIPTION', status: 'FAILED', amountYen: current.priceYen, subscriptionId: id } });
      await tx.billingEvent.create({ data: { userId: current.userId, eventType: 'PAYMENT_FAILED', subscriptionId: id, actorId: actor.id, details: { reason, graceEndsAt: graceEndsAt.toISOString() } } });
      await this.auth.audit(tx, req, 'BILLING_SIMULATE_FAILURE', id, reason, { graceEndsAt }); return { id, status: 'PAST_DUE', graceEndsAt };
    });
  }

  @Post('admin/billing/subscriptions/:id/recover')
  async recover(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.staff(req, ['ADMIN']);
    if (transport !== 'test') throw new ConflictException({ code: 'LOCAL_BILLING_SIMULATION_DISABLED', message: '外部決済契約はWebhookから同期してください。' });
    const { reason } = reasonSchema.parse(body); z.string().uuid().parse(id);
    return this.auth.db.$transaction(async tx => {
      const current = await tx.subscription.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'PAST_DUE') throw new ConflictException({ code: 'SUBSCRIPTION_NOT_PAST_DUE', message: '支払待ちの契約ではありません。' });
      const now = new Date(); const endsAt = addCalendarMonthUtc(now);
      await tx.subscription.update({ where: { id }, data: { status: 'ACTIVE', currentPeriodStartsAt: now, currentPeriodEndsAt: endsAt, graceEndsAt: null } });
      await tx.entitlement.update({ where: { id: current.entitlementId }, data: { startsAt: now, endsAt, revokedAt: null } });
      await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'LOCAL_TEST', providerPaymentId: `local-recovery-${randomUUID()}`, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: current.priceYen, subscriptionId: id } });
      await tx.billingEvent.create({ data: { userId: current.userId, eventType: 'PAYMENT_RECOVERED', subscriptionId: id, actorId: actor.id, details: { reason, currentPeriodEndsAt: endsAt.toISOString() } } });
      await this.auth.audit(tx, req, 'BILLING_RECOVER', id, reason, { currentPeriodEndsAt: endsAt }); return { id, status: 'ACTIVE', currentPeriodEndsAt: endsAt };
    });
  }
}
