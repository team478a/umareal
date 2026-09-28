import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { addCalendarMonthUtc, billingReviewResolutionSchema, billingSupportEventType, billingSupportRequestSchema, billingSupportStatusSchema, canManage, dayPassCheckoutSchema, jstDate, launchCapabilities, requiresMfa, resolveLaunchMode, subscriptionCheckoutSchema } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';
import { createDayPassAccess } from './day-pass-access';
import Stripe from 'stripe';
import { loadStripeConfig, type StripeRuntimeConfig } from './stripe-config';
import { stripePriceMatchesCheckout } from './stripe-price';
import { StripeCustomerGatewayService } from './stripe-customer-gateway.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { recordBillingEvent } from './billing-events';

const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

@Controller()
export class BillingController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(StripeCustomerGatewayService) private readonly stripeCustomer: StripeCustomerGatewayService,
    @Inject(StripeWebhookService) private readonly stripeWebhookService: StripeWebhookService
  ) {}

  private transport() {
    if (!launchCapabilities(resolveLaunchMode(process.env.LAUNCH_MODE)).billing) throw new ServiceUnavailableException({ code: 'BILLING_NOT_IN_LAUNCH', message: '有料プランは現在準備中です。' });
    const transport = process.env.BILLING_TRANSPORT;
    if (transport !== 'test' && transport !== 'stripe') throw new ServiceUnavailableException({ code: 'BILLING_TRANSPORT_UNAVAILABLE', message: 'この環境では申込を処理できません。' });
    return transport;
  }
  private key(req: AppRequest, prefix: string, userId: string) {
    return `${prefix}:${userId}:${z.string().uuid().parse(req.headers['idempotency-key'])}`;
  }
  private purchaseIdentityReady(user: { email: string | null; emailVerifiedAt: Date | null; passwordHash: string | null; authSubject: string | null }) {
    return !!user.email && !!user.emailVerifiedAt && (!!user.passwordHash || (process.env.AUTH_PROVIDER === 'supabase' && !!user.authSubject));
  }
  private async staff(req: AppRequest, roles: Role[]) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, roles)) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '管理権限と二段階認証を確認してください。' });
    return actor;
  }

  @Get('billing/plans')
  async plans() {
    const settings = await this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
    const now = new Date();
    const [founderSold, founderReserved] = await Promise.all([
      this.auth.db.subscription.count({ where: { planCode: 'FOUNDER', status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'] } } }),
      this.auth.db.billingCheckout.count({ where: { planCode: 'FOUNDER', status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: now } } })
    ]);
    const founderUnavailable = founderSold + founderReserved;
    const billingEnabled = launchCapabilities(resolveLaunchMode(process.env.LAUNCH_MODE)).billing;
    const stripeConfig = billingEnabled && process.env.BILLING_TRANSPORT === 'stripe' ? await loadStripeConfig(this.auth.db) : null;
    const transportAvailable = billingEnabled && (process.env.BILLING_TRANSPORT === 'test' || (process.env.BILLING_TRANSPORT === 'stripe' && stripeConfig?.usable));
    return { newPurchasesEnabled: billingEnabled && settings.newPurchasesEnabled, developmentTerms: true, billingTransport: process.env.BILLING_TRANSPORT, stripeMode: stripeConfig ? stripeConfig.liveMode ? 'LIVE' : 'TEST' : null, currency: 'JPY', taxIncluded: true,
      plans: [
        { code: 'FOUNDER', name: '創設会員', priceYen: settings.founderPriceYen, interval: 'MONTH', available: transportAvailable && settings.newPurchasesEnabled && settings.founderSalesEnabled && founderUnavailable < settings.founderSalesLimit, remaining: Math.max(0, settings.founderSalesLimit - founderUnavailable) },
        { code: 'STANDARD', name: '通常会員', priceYen: settings.standardPriceYen, interval: 'MONTH', available: transportAvailable && settings.newPurchasesEnabled },
        { code: 'DAY_PASS', name: '1日利用', priceYen: settings.dayPassPriceYen, interval: 'JST_DAY', available: transportAvailable && settings.newPurchasesEnabled }
      ] };
  }

  @Get('billing/me')
  async mine(@Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    const [subscriptions, dayPasses, payments, supportRequests] = await Promise.all([
      this.auth.db.subscription.findMany({ where: { userId: actor.id }, orderBy: { createdAt: 'desc' } }),
      this.auth.db.dayPass.findMany({ where: { userId: actor.id }, orderBy: { createdAt: 'desc' } }),
      this.auth.db.paymentTransaction.findMany({ where: { userId: actor.id }, select: { id: true, provider: true, providerPaymentId: true, kind: true, status: true, amountYen: true, subscriptionId: true, dayPassId: true, occurredAt: true }, orderBy: { occurredAt: 'desc' } }),
      this.auth.db.billingSupportRequest.findMany({ where: { userId: actor.id }, select: { id: true, paymentTransactionId: true, category: true, message: true, status: true, createdAt: true, updatedAt: true, events: { select: { eventType: true, occurredAt: true }, orderBy: { occurredAt: 'asc' } } }, orderBy: { createdAt: 'desc' } })
    ]);
    return { subscriptions, dayPasses, payments, supportRequests, customerPortalAvailable: process.env.BILLING_TRANSPORT === 'stripe' && subscriptions.some(item => item.provider === 'STRIPE' && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(item.status)) };
  }

  @Get('billing/payments/:id/receipt')
  async receipt(@Param('id') id: string, @Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    z.string().uuid().parse(id);
    const payment = await this.auth.db.paymentTransaction.findUnique({ where: { id } });
    if (!payment || payment.userId !== actor.id) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: '対象の支払いを確認できません。' });
    if (payment.provider !== 'STRIPE' || payment.status !== 'SUCCEEDED') throw new ConflictException({ code: 'RECEIPT_NOT_AVAILABLE', message: 'この支払いには外部決済の領収書がありません。' });
    const receiptUrl = await this.stripeCustomer.receiptUrl(payment.providerPaymentId);
    return { paymentId: payment.id, receiptUrl };
  }

  @Post('billing/support-requests')
  async createSupportRequest(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    const input = billingSupportRequestSchema.parse(body);
    const key = this.key(req, 'billing-support', actor.id);
    const requestHash = hashToken(JSON.stringify(input));
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text`;
        const previous = await tx.idempotencyKey.findUnique({ where: { key } });
        if (previous) {
          if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ受付キーが異なる内容で使われています。' });
          return previous.response;
        }
        if (input.paymentTransactionId) {
          const payment = await tx.paymentTransaction.findUnique({ where: { id: input.paymentTransactionId }, select: { userId: true } });
          if (!payment || payment.userId !== actor.id) throw new ForbiddenException({ code: 'PAYMENT_ACCESS_DENIED', message: '対象の支払いを確認できません。' });
        }
        const support = await tx.billingSupportRequest.create({ data: { userId: actor.id, paymentTransactionId: input.paymentTransactionId ?? null, category: input.category, message: input.message, events: { create: { eventType: 'CREATED', actorId: actor.id, actorRole: 'MEMBER', reason: input.message } } } });
        const response = { id: support.id, category: support.category, status: support.status, paymentTransactionId: support.paymentTransactionId, createdAt: support.createdAt.toISOString() };
        await tx.idempotencyKey.create({ data: { key, requestHash, response } });
        await this.auth.audit(tx, req, 'BILLING_SUPPORT_REQUEST_CREATED', support.id, '会員本人による請求問い合わせ受付', { category: support.category, paymentTransactionId: support.paymentTransactionId });
        return response;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (previous?.requestHash === requestHash) return previous.response;
      throw new ConflictException({ code: 'BILLING_SUPPORT_CONFLICT', message: '受付状態が競合しました。再読み込みしてください。' });
    }
  }

  @Post('billing/checkout')
  async checkout(@Req() req: AppRequest, @Body() body: unknown) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); const input = subscriptionCheckoutSchema.parse(body);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    if (!this.purchaseIdentityReady(actor.user)) throw new ForbiddenException({ code: 'VERIFIED_LOGIN_REQUIRED', message: '申込前にメールアドレスの確認を完了してください。' });
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
        await recordBillingEvent(tx, { userId: actor.id, eventType: 'SUBSCRIPTION_STARTED', subscriptionId: subscription.id, actorId: actor.id, details: { planCode: input.planCode, priceYen, developmentSimulation: true } }, 'BILLING_PAYMENT_SUCCEEDED');
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
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    if (!this.purchaseIdentityReady(actor.user)) throw new ForbiddenException({ code: 'VERIFIED_LOGIN_REQUIRED', message: '申込前にメールアドレスの確認を完了してください。' });
    if (input.raceDate < jstDate(new Date())) throw new BadRequestException({ code: 'PAST_RACE_DATE', message: '過去の日付は購入できません。' });
    const key = this.key(req, 'day-pass', actor.id); const requestHash = hashToken(JSON.stringify(input));
    if (transport === 'stripe') return this.createStripeCheckout(req, actor.id, actor.user.email, 'DAY_PASS', 'DAY_PASS', input.raceDate, key, requestHash);
    try {
      return await this.auth.db.$transaction(async tx => {
        const previous = await tx.idempotencyKey.findUnique({ where: { key } });
        if (previous) { if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ申込キーが異なる内容で使われています。' }); return previous.response; }
        const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
        if (!settings.newPurchasesEnabled) throw new ServiceUnavailableException({ code: 'PURCHASES_STOPPED', message: '現在、新規購入を停止しています。' });
        const access = await createDayPassAccess(tx, { userId: actor.id, raceDate: input.raceDate, priceYen: settings.dayPassPriceYen, provider: 'LOCAL_TEST', providerPassId: `local-pass-${randomUUID()}`, reason: 'LOCAL_TEST_DAY_PASS', actorId: actor.id, source: 'LOCAL_TEST' });
        const pass = access.pass;
        const payment = await tx.paymentTransaction.create({ data: { userId: actor.id, provider: 'LOCAL_TEST', providerPaymentId: `local-pay-${randomUUID()}`, kind: 'DAY_PASS', status: 'SUCCEEDED', amountYen: settings.dayPassPriceYen, dayPassId: pass.id } });
        await tx.notificationEvent.create({ data: { billingEventId: access.billingEvent.id, eventType: 'BILLING_PAYMENT_SUCCEEDED', status: 'QUEUED', payload: { billingEventId: access.billingEvent.id } } });
        const response = { dayPassId: pass.id, paymentId: payment.id, status: pass.status, startsAt: access.startsAt, endsAt: access.endsAt, waitingForPublication: access.waitingForPublication };
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
  stripeWebhook(@Req() req: AppRequest) {
    return this.stripeWebhookService.handle(req);
  }

  private async stripeConfig() {
    const config = await loadStripeConfig(this.auth.db);
    if (!config.usable) throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED', message: '外部決済の設定が完了していません。' });
    return config;
  }

  private stripeClient(config: StripeRuntimeConfig) {
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

  private async createStripeCheckout(req: AppRequest, userId: string, email: string | null, kind: 'SUBSCRIPTION' | 'DAY_PASS', planCode: 'FOUNDER' | 'STANDARD' | 'DAY_PASS', raceDate: string | null, idempotencyKey: string, requestHash: string) {
    if (!email) throw new ForbiddenException({ code: 'VERIFIED_EMAIL_REQUIRED', message: '確認済みメールアドレスが必要です。' });
    const stripeConfig = await this.stripeConfig();
    const reservation = await this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))::text`;
      if (planCode === 'FOUNDER') await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('billing:founder-capacity'))::text`;
      const currentUser = await tx.user.findUnique({ where: { id: userId }, select: { role: true, disabledAt: true, accountClosure: { select: { id: true } } } });
      if (!currentUser || currentUser.role !== 'MEMBER' || currentUser.disabledAt || currentUser.accountClosure) throw new ForbiddenException({ code: 'PURCHASE_ACCOUNT_NOT_ELIGIBLE', message: 'このアカウントでは新しい申込を開始できません。' });
      const existing = await tx.billingCheckout.findUnique({ where: { idempotencyKey } });
      if (existing && existing.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じ申込キーが異なる内容で使われています。' });
      if (existing?.providerSessionId && existing.providerCheckoutUrl) {
        if (existing.status === 'OPEN' && existing.expiresAt <= new Date()) throw new ConflictException({ code: 'CHECKOUT_EXPIRED', message: '決済画面の有効期限が切れました。再度お申し込みください。' });
        return { response: { checkoutId: existing.id, checkoutUrl: existing.providerCheckoutUrl, status: existing.status }, checkout: null };
      }
      const settings = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
      if (!settings.newPurchasesEnabled) throw new ServiceUnavailableException({ code: 'PURCHASES_STOPPED', message: '現在、新規購入を停止しています。' });
      if (kind === 'SUBSCRIPTION' && await tx.subscription.count({ where: { userId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } } })) throw new ConflictException({ code: 'ACTIVE_SUBSCRIPTION_EXISTS', message: '有効な月額契約があります。' });
      const now = new Date();
      const pendingWhere = kind === 'SUBSCRIPTION'
        ? { userId, kind, status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: now }, ...(existing ? { id: { not: existing.id } } : {}) }
        : { userId, kind, raceDate, status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: now }, ...(existing ? { id: { not: existing.id } } : {}) };
      if (await tx.billingCheckout.count({ where: pendingWhere })) throw new ConflictException({ code: 'CHECKOUT_ALREADY_OPEN', message: '同じ申込の決済画面が開いています。期限切れ後に再度お申し込みください。' });
      if (planCode === 'FOUNDER') {
        if (!settings.founderSalesEnabled) throw new ConflictException({ code: 'FOUNDER_SALES_CLOSED', message: '創設会員プランは販売していません。' });
        const [sold, pending] = await Promise.all([
          tx.subscription.count({ where: { planCode: 'FOUNDER' } }),
          tx.billingCheckout.count({ where: { planCode: 'FOUNDER', status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: now }, ...(existing ? { id: { not: existing.id } } : {}) } })
        ]);
        if (sold + pending >= settings.founderSalesLimit) throw new ConflictException({ code: 'FOUNDER_LIMIT_REACHED', message: '創設会員プランは販売上限に達しました。' });
      }
      if (kind === 'DAY_PASS' && await tx.dayPass.count({ where: { userId, raceDate: raceDate! } })) throw new ConflictException({ code: 'DAY_PASS_EXISTS', message: 'この開催日の1日利用は登録済みです。' });
      const amountYen = existing?.amountYen ?? (planCode === 'FOUNDER' ? settings.founderPriceYen : planCode === 'STANDARD' ? settings.standardPriceYen : settings.dayPassPriceYen);
      const expiresAt = new Date(now.getTime() + 30 * 60000);
      const checkout = existing
        ? await tx.billingCheckout.update({ where: { id: existing.id }, data: { status: 'INITIATED', expiresAt } })
        : await tx.billingCheckout.create({ data: { userId, kind, planCode, raceDate, amountYen, idempotencyKey, requestHash, expiresAt } });
      return { response: null, checkout };
    }, { timeout: 20000, maxWait: 10000 });
    if (reservation.response) return reservation.response;
    const checkout = reservation.checkout!;
    const amountYen = checkout.amountYen;
    const price = planCode === 'FOUNDER' ? stripeConfig.priceFounder : planCode === 'STANDARD' ? stripeConfig.priceStandard : stripeConfig.priceDayPass;
    const metadata = { checkoutId: checkout.id, userId, kind, planCode, raceDate: raceDate ?? '' };
    const baseUrl = process.env.APP_BASE_URL!;
    const client = this.stripeClient(stripeConfig);
    let stripePrice;
    try { stripePrice = await client.prices.retrieve(price!); }
    catch {
      await this.auth.db.billingCheckout.updateMany({ where: { id: checkout.id, status: 'INITIATED' }, data: { status: 'FAILED' } });
      throw new ServiceUnavailableException({ code: 'STRIPE_PRICE_UNAVAILABLE', message: '料金設定を確認できません。時間をおいて再度お試しください。' });
    }
    if (!stripePriceMatchesCheckout(stripePrice, amountYen, kind)) {
      await this.auth.db.billingCheckout.updateMany({ where: { id: checkout.id, status: 'INITIATED' }, data: { status: 'FAILED' } });
      throw new ServiceUnavailableException({ code: 'STRIPE_PRICE_MISMATCH', message: '料金設定が申込内容と一致しません。運営へお問い合わせください。' });
    }
    let session;
    try { session = await client.checkout.sessions.create({ mode: kind === 'SUBSCRIPTION' ? 'subscription' : 'payment', payment_method_types: ['card'], client_reference_id: checkout.id, customer_email: email, line_items: [{ price: price!, quantity: 1 }], metadata, ...(kind === 'SUBSCRIPTION' ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }), success_url: `${baseUrl}/account?checkout=success`, cancel_url: `${baseUrl}/plans?checkout=canceled`, expires_at: Math.floor(checkout.expiresAt.getTime() / 1000) }, { idempotencyKey }); }
    catch {
      await this.auth.db.billingCheckout.updateMany({ where: { id: checkout.id, status: 'INITIATED' }, data: { status: 'FAILED' } });
      throw new ServiceUnavailableException({ code: 'STRIPE_CHECKOUT_UNAVAILABLE', message: '決済画面を開始できませんでした。時間をおいて再度お試しください。' });
    }
    if (!session.url) {
      await this.auth.db.billingCheckout.updateMany({ where: { id: checkout.id, status: 'INITIATED' }, data: { status: 'FAILED' } });
      throw new ServiceUnavailableException({ code: 'STRIPE_CHECKOUT_URL_MISSING', message: '決済画面を開始できませんでした。' });
    }
    await this.auth.db.billingCheckout.update({ where: { id: checkout.id }, data: { status: 'OPEN', providerSessionId: session.id, providerCheckoutUrl: session.url, expiresAt: new Date(session.expires_at * 1000) } });
    await this.auth.audit(this.auth.db, req, 'STRIPE_CHECKOUT_CREATED', checkout.id, '会員本人による外部決済開始', { kind, planCode, amountYen, raceDate }, 'BillingCheckout');
    return { checkoutId: checkout.id, checkoutUrl: session.url, status: 'OPEN' };
  }

  @Post('billing/subscriptions/:id/cancel')
  async cancel(@Param('id') id: string, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); z.string().uuid().parse(id);
    if (transport === 'stripe') {
      const external = await this.auth.db.subscription.findUnique({ where: { id } });
      if (!external || external.userId !== actor.id) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
      if (external.provider !== 'STRIPE') throw new ConflictException({ code: 'SUBSCRIPTION_PROVIDER_MISMATCH', message: '外部決済の契約ではありません。' });
      if (!external.cancelAtPeriodEnd) { const stripeConfig = await this.stripeConfig(); await this.stripeClient(stripeConfig).subscriptions.update(external.providerSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey: `cancel-at-period-end:${external.id}:${external.updatedAt.getTime()}` }); }
    }
    return this.auth.db.$transaction(async tx => {
      const current = await tx.subscription.findUnique({ where: { id } });
      if (!current || current.userId !== actor.id) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
      if (current.cancelAtPeriodEnd) return { id, status: current.status, cancelAtPeriodEnd: true, accessEndsAt: current.currentPeriodEndsAt };
      if (!['ACTIVE', 'PAST_DUE', 'TRIALING'].includes(current.status)) throw new ConflictException({ code: 'SUBSCRIPTION_NOT_CANCELABLE', message: 'この契約は解約予約できません。' });
      const now = new Date(); const subscription = await tx.subscription.update({ where: { id }, data: { cancelAtPeriodEnd: true, canceledAt: now } });
      await recordBillingEvent(tx, { userId: actor.id, eventType: 'CANCELLATION_SCHEDULED', subscriptionId: id, actorId: actor.id, details: { accessEndsAt: current.currentPeriodEndsAt.toISOString() } }, 'BILLING_CANCELLATION_SCHEDULED');
      await this.auth.audit(tx, req, 'SUBSCRIPTION_CANCEL_SCHEDULE', id, '会員本人による解約予約', { accessEndsAt: current.currentPeriodEndsAt }, 'Subscription');
      return { id, status: subscription.status, cancelAtPeriodEnd: true, accessEndsAt: current.currentPeriodEndsAt };
    });
  }

  @Post('billing/subscriptions/:id/resume')
  async resume(@Param('id') id: string, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); z.string().uuid().parse(id);
    const external = await this.auth.db.subscription.findUnique({ where: { id } });
    if (!external || external.userId !== actor.id) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
    if (!external.cancelAtPeriodEnd) return { id, status: external.status, cancelAtPeriodEnd: false, accessEndsAt: external.currentPeriodEndsAt };
    if (!['ACTIVE', 'PAST_DUE', 'TRIALING'].includes(external.status)) throw new ConflictException({ code: 'SUBSCRIPTION_NOT_RESUMABLE', message: 'この契約は継続へ戻せません。' });
    if (transport === 'stripe') {
      if (external.provider !== 'STRIPE') throw new ConflictException({ code: 'SUBSCRIPTION_PROVIDER_MISMATCH', message: '外部決済の契約ではありません。' });
      const stripeConfig = await this.stripeConfig();
      await this.stripeClient(stripeConfig).subscriptions.update(external.providerSubscriptionId, { cancel_at_period_end: false }, { idempotencyKey: `resume-subscription:${external.id}:${external.updatedAt.getTime()}` });
    }
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:subscription:${id}`}))::text`;
      const current = await tx.subscription.findUnique({ where: { id } });
      if (!current || current.userId !== actor.id) throw new ForbiddenException({ code: 'SUBSCRIPTION_ACCESS_DENIED', message: '契約を確認できません。' });
      if (!current.cancelAtPeriodEnd) return { id, status: current.status, cancelAtPeriodEnd: false, accessEndsAt: current.currentPeriodEndsAt };
      if (!['ACTIVE', 'PAST_DUE', 'TRIALING'].includes(current.status)) throw new ConflictException({ code: 'SUBSCRIPTION_NOT_RESUMABLE', message: 'この契約は継続へ戻せません。' });
      const subscription = await tx.subscription.update({ where: { id }, data: { cancelAtPeriodEnd: false, canceledAt: null, updatedAt: new Date() } });
      await recordBillingEvent(tx, { userId: actor.id, eventType: 'CANCELLATION_REVERSED', subscriptionId: id, actorId: actor.id, details: { accessEndsAt: current.currentPeriodEndsAt.toISOString(), source: 'MEMBER_REQUEST' } }, 'BILLING_CANCELLATION_REVERSED');
      await this.auth.audit(tx, req, 'SUBSCRIPTION_CANCEL_REVERSED', id, '会員本人による解約予約の取消', { accessEndsAt: current.currentPeriodEndsAt }, 'Subscription');
      return { id, status: subscription.status, cancelAtPeriodEnd: false, accessEndsAt: current.currentPeriodEndsAt };
    });
  }

  @Post('billing/portal')
  async portal(@Req() req: AppRequest) {
    if (this.transport() !== 'stripe') throw new ConflictException({ code: 'STRIPE_PORTAL_UNAVAILABLE', message: 'この環境では支払い方法の変更画面を利用できません。' });
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    const subscription = await this.auth.db.subscription.findFirst({ where: { userId: actor.id, provider: 'STRIPE', status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } }, orderBy: { createdAt: 'desc' } });
    if (!subscription) throw new NotFoundException({ code: 'STRIPE_SUBSCRIPTION_NOT_FOUND', message: '管理できる月額契約がありません。' });
    const portalUrl = await this.stripeCustomer.customerPortalUrl(subscription.providerSubscriptionId, `${process.env.APP_BASE_URL!}/account`);
    await this.auth.audit(this.auth.db, req, 'STRIPE_CUSTOMER_PORTAL_OPENED', subscription.id, '会員本人による支払い管理画面の開始', {}, 'Subscription');
    return { portalUrl };
  }

  @Get('admin/billing')
  async admin(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    const now = new Date();
    const [subscriptions, dayPasses, payments, checkouts, stripeWebhooks, supportRequests, pendingDayPassReviews, reviewCheckouts] = await Promise.all([
      this.auth.db.subscription.findMany({ include: { user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.auth.db.dayPass.findMany({ include: { user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.auth.db.paymentTransaction.findMany({ select: { id: true, provider: true, providerPaymentId: true, kind: true, status: true, amountYen: true, subscriptionId: true, dayPassId: true, occurredAt: true, user: { select: { email: true, displayName: true } } }, orderBy: { occurredAt: 'desc' }, take: 100 }),
      this.auth.db.billingCheckout.findMany({ select: { id: true, kind: true, planCode: true, raceDate: true, amountYen: true, status: true, createdAt: true, expiresAt: true, completedAt: true, user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.auth.db.stripeWebhookEvent.findMany({ select: { id: true, providerEventId: true, eventType: true, livemode: true, outcome: true, receivedAt: true }, orderBy: { receivedAt: 'desc' }, take: 100 }),
      this.auth.db.billingSupportRequest.findMany({ select: { id: true, category: true, message: true, status: true, createdAt: true, updatedAt: true, paymentTransaction: { select: { id: true, kind: true, status: true, amountYen: true, occurredAt: true } }, user: { select: { email: true, displayName: true } }, events: { select: { id: true, eventType: true, actorRole: true, reason: true, occurredAt: true }, orderBy: { occurredAt: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.auth.db.dayPass.findMany({ where: { source: 'PURCHASE', status: { in: ['PENDING', 'REFUNDING'] }, startsAt: null, entitlementId: null, endsAt: { lte: now } }, select: { id: true, raceDate: true, status: true, priceYen: true, provider: true, endsAt: true, user: { select: { email: true, displayName: true } } }, orderBy: { endsAt: 'asc' }, take: 100 }),
      this.auth.db.billingCheckout.findMany({ where: { status: { in: ['REJECTED_ACCOUNT_STATE', 'REJECTED_EXISTING_ACCESS', 'REJECTED_FOUNDER_LIMIT', 'REVIEW_REFUNDING'] } }, select: { id: true, kind: true, planCode: true, raceDate: true, amountYen: true, status: true, completedAt: true, user: { select: { email: true, displayName: true } }, payments: { select: { id: true, status: true, occurredAt: true }, orderBy: { occurredAt: 'asc' } } }, orderBy: { completedAt: 'asc' }, take: 100 })
    ]); return { billingTransport: process.env.BILLING_TRANSPORT, subscriptions, dayPasses, payments, checkouts, stripeWebhooks, supportRequests, pendingDayPassReviews, reviewCheckouts };
  }

  @Post('admin/billing/checkouts/:id/resolve')
  async resolveCheckoutReview(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    if (this.transport() !== 'stripe') throw new ConflictException({ code: 'STRIPE_REVIEW_RESOLUTION_DISABLED', message: '要確認決済の解決はStripe接続環境で行ってください。' });
    z.string().uuid().parse(id);
    const input = billingReviewResolutionSchema.parse(body);
    const initial = await this.auth.db.billingCheckout.findUnique({ where: { id } });
    if (!initial || !initial.providerSessionId || !initial.completedAt) throw new NotFoundException({ code: 'BILLING_REVIEW_NOT_FOUND', message: '要確認の決済を確認できません。' });
    if (initial.status === 'REVIEW_ACCESS_GRANTED' || initial.status === 'REVIEW_REFUNDED') return { checkoutId: id, status: initial.status };
    const reviewStates = ['REJECTED_ACCOUNT_STATE', 'REJECTED_EXISTING_ACCESS', 'REJECTED_FOUNDER_LIMIT', 'REVIEW_REFUNDING'];
    if (!reviewStates.includes(initial.status)) throw new ConflictException({ code: 'BILLING_REVIEW_STATE_CHANGED', message: 'この決済は要確認状態ではありません。' });
    const stripeConfig = await this.stripeConfig();
    const client = this.stripeClient(stripeConfig);
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
          await recordBillingEvent(tx, { userId: current.userId, eventType: 'CHECKOUT_PAYMENT_REFUNDED', billingCheckoutId: current.id, actorId: actor.id, details: { checkoutId: current.id, amountYen: refund.amount, reason: input.reason, providerRefundId: refund.id, source: 'ADMIN_REVIEW' } }, 'BILLING_REFUND_COMPLETED');
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
        const entitlement = await tx.entitlement.create({ data: { userId: current.userId, planCode: current.planCode, startsAt, endsAt, reason: 'ADMIN_BILLING_REVIEW_RESOLVED', grantedBy: actor.id } });
        const subscription = await tx.subscription.create({ data: { userId: current.userId, planCode: current.planCode, status: externalSubscription.status === 'past_due' ? 'PAST_DUE' : externalSubscription.status === 'trialing' ? 'TRIALING' : 'ACTIVE', priceYen: current.amountYen, currentPeriodStartsAt: startsAt, currentPeriodEndsAt: endsAt, provider: 'STRIPE', providerSubscriptionId, entitlementId: entitlement.id } });
        await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'STRIPE', providerPaymentId: `review-grant:${current.providerSessionId}`, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: current.amountYen, subscriptionId: subscription.id } });
        await recordBillingEvent(tx, { userId: current.userId, eventType: 'SUBSCRIPTION_STARTED', subscriptionId: subscription.id, actorId: actor.id, details: { planCode: current.planCode, priceYen: current.amountYen, source: 'ADMIN_BILLING_REVIEW' } }, 'BILLING_PAYMENT_SUCCEEDED');
      } else {
        if (!current.raceDate) throw new ConflictException({ code: 'DAY_PASS_DATE_MISSING', message: '利用日を確認できません。' });
        if (await tx.dayPass.count({ where: { userId: current.userId, raceDate: current.raceDate } })) throw new ConflictException({ code: 'DAY_PASS_EXISTS', message: '同じ開催日の一日券があるため、重複付与できません。' });
        const access = await createDayPassAccess(tx, { userId: current.userId, raceDate: current.raceDate, priceYen: current.amountYen, provider: 'STRIPE', providerPassId: current.providerSessionId!, reason: 'ADMIN_BILLING_REVIEW_RESOLVED', actorId: actor.id, source: 'STRIPE_CHECKOUT' });
        await tx.paymentTransaction.create({ data: { userId: current.userId, provider: 'STRIPE', providerPaymentId: `review-grant:${current.providerSessionId}`, kind: 'DAY_PASS', status: 'SUCCEEDED', amountYen: current.amountYen, dayPassId: access.pass.id } });
        await tx.notificationEvent.create({ data: { billingEventId: access.billingEvent.id, eventType: 'BILLING_PAYMENT_SUCCEEDED', status: 'QUEUED', payload: { billingEventId: access.billingEvent.id } } });
      }
      await tx.billingCheckout.update({ where: { id }, data: { status: 'REVIEW_ACCESS_GRANTED' } });
      await this.auth.audit(tx, req, 'BILLING_REVIEW_ACCESS_GRANTED', id, input.reason, { kind: current.kind, planCode: current.planCode, amountYen: current.amountYen, raceDate: current.raceDate }, 'BillingCheckout');
      return { checkoutId: id, status: 'REVIEW_ACCESS_GRANTED' };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Post('admin/billing/day-passes/:id/refund')
  async refundExpiredPendingDayPass(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    const { reason } = reasonSchema.parse(body);
    z.string().uuid().parse(id);
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
      const stripeConfig = await this.stripeConfig();
      const client = this.stripeClient(stripeConfig);
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
      await recordBillingEvent(tx, { userId: current.userId, eventType: 'DAY_PASS_REFUNDED', dayPassId: current.id, actorId: actor.id, details: { amountYen: current.priceYen, raceDate: current.raceDate, reason, providerRefundId } }, 'BILLING_REFUND_COMPLETED');
      await this.auth.audit(tx, req, 'DAY_PASS_REFUNDED', current.id, reason, { amountYen: current.priceYen, raceDate: current.raceDate, refundPaymentId: refundPayment.id });
      return { dayPassId: id, status: 'REFUNDED', refundPaymentId: refundPayment.id };
    }, { timeout: 20000, maxWait: 10000 });
  }

  @Post('admin/billing/support-requests/:id/status')
  async updateSupportStatus(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    z.string().uuid().parse(id);
    const input = billingSupportStatusSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing-support:${id}`}))::text`;
      const current = await tx.billingSupportRequest.findUnique({ where: { id } });
      if (!current) throw new NotFoundException({ code: 'BILLING_SUPPORT_NOT_FOUND', message: '問い合わせを確認できません。' });
      const eventType = billingSupportEventType(current.status, input.status);
      if (!eventType) throw new ConflictException({ code: 'BILLING_SUPPORT_TRANSITION_INVALID', message: '現在の状態から指定された状態へ変更できません。' });
      const updated = await tx.billingSupportRequest.update({ where: { id }, data: { status: input.status, updatedAt: new Date() } });
      await tx.billingSupportEvent.create({ data: { requestId: id, eventType, actorId: actor.id, actorRole: 'ADMIN', reason: input.reason } });
      await this.auth.audit(tx, req, 'BILLING_SUPPORT_STATUS_CHANGED', id, input.reason, { category: current.category, previousStatus: current.status, status: input.status });
      return { id: updated.id, status: updated.status, updatedAt: updated.updatedAt };
    });
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
      await recordBillingEvent(tx, { userId: current.userId, eventType: 'PAYMENT_FAILED', subscriptionId: id, actorId: actor.id, details: { reason, graceEndsAt: graceEndsAt.toISOString() } }, 'BILLING_PAYMENT_FAILED');
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
      await recordBillingEvent(tx, { userId: current.userId, eventType: 'PAYMENT_RECOVERED', subscriptionId: id, actorId: actor.id, details: { reason, currentPeriodEndsAt: endsAt.toISOString() } }, 'BILLING_PAYMENT_RECOVERED');
      await this.auth.audit(tx, req, 'BILLING_RECOVER', id, reason, { currentPeriodEndsAt: endsAt }); return { id, status: 'ACTIVE', currentPeriodEndsAt: endsAt };
    });
  }
}
