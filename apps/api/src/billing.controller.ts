import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { addCalendarMonthUtc, billingReviewResolutionSchema, billingSupportRequestSchema, billingSupportStatusSchema, canManage, dayPassCheckoutSchema, jstDate, launchCapabilities, requiresMfa, resolveLaunchMode, subscriptionCheckoutSchema } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { Prisma } from '@keiba/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';
import { createDayPassAccess } from './day-pass-access';
import { StripeCustomerGatewayService } from './stripe-customer-gateway.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { BillingSubscriptionLifecycleService } from './billing-subscription-lifecycle.service';
import { BillingAdminResolutionService } from './billing-admin-resolution.service';
import { BillingSupportService } from './billing-support.service';
import { BillingLocalSimulationService } from './billing-local-simulation.service';
import { BillingQueryService } from './billing-query.service';
import { recordBillingEvent } from './billing-events';

const reasonSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

@Controller()
export class BillingController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(StripeCustomerGatewayService) private readonly stripeCustomer: StripeCustomerGatewayService,
    @Inject(StripeWebhookService) private readonly stripeWebhookService: StripeWebhookService,
    @Inject(StripeCheckoutService) private readonly stripeCheckout: StripeCheckoutService,
    @Inject(BillingSubscriptionLifecycleService) private readonly subscriptionLifecycle: BillingSubscriptionLifecycleService,
    @Inject(BillingAdminResolutionService) private readonly adminResolution: BillingAdminResolutionService,
    @Inject(BillingSupportService) private readonly billingSupport: BillingSupportService,
    @Inject(BillingLocalSimulationService) private readonly localSimulation: BillingLocalSimulationService,
    @Inject(BillingQueryService) private readonly billingQuery: BillingQueryService
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
    return this.billingQuery.plans();
  }

  @Get('billing/me')
  async mine(@Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    return this.billingQuery.member(actor.id);
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
    return this.billingSupport.create(req, actor.id, input, key, requestHash);
  }

  @Post('billing/checkout')
  async checkout(@Req() req: AppRequest, @Body() body: unknown) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); const input = subscriptionCheckoutSchema.parse(body);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    if (!this.purchaseIdentityReady(actor.user)) throw new ForbiddenException({ code: 'VERIFIED_LOGIN_REQUIRED', message: '申込前にメールアドレスの確認を完了してください。' });
    const key = this.key(req, 'subscription-checkout', actor.id); const requestHash = hashToken(JSON.stringify(input));
    if (transport === 'stripe') return this.stripeCheckout.create(req, actor.id, actor.user.email, 'SUBSCRIPTION', input.planCode, null, key, requestHash);
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
    if (transport === 'stripe') return this.stripeCheckout.create(req, actor.id, actor.user.email, 'DAY_PASS', 'DAY_PASS', input.raceDate, key, requestHash);
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


  @Post('billing/subscriptions/:id/cancel')
  async cancel(@Param('id') id: string, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); z.string().uuid().parse(id);
    return this.subscriptionLifecycle.scheduleCancellation(req, actor.id, id, transport);
  }

  @Post('billing/subscriptions/:id/resume')
  async resume(@Param('id') id: string, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); z.string().uuid().parse(id);
    return this.subscriptionLifecycle.resume(req, actor.id, id, transport);
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
    return this.adminResolution.resolveCheckoutReview(req, actor.id, id, input);
  }

  @Post('admin/billing/day-passes/:id/refund')
  async refundExpiredPendingDayPass(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    const { reason } = reasonSchema.parse(body);
    z.string().uuid().parse(id);
    return this.adminResolution.refundExpiredPendingDayPass(req, actor.id, id, reason);
  }

  @Post('admin/billing/support-requests/:id/status')
  async updateSupportStatus(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    z.string().uuid().parse(id);
    const input = billingSupportStatusSchema.parse(body);
    return this.billingSupport.updateStatus(req, actor.id, id, input);
  }

  @Post('admin/billing/subscriptions/:id/simulate-failure')
  async fail(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.staff(req, ['ADMIN']);
    if (transport !== 'test') throw new ConflictException({ code: 'LOCAL_BILLING_SIMULATION_DISABLED', message: '外部決済契約はWebhookから同期してください。' });
    const { reason } = reasonSchema.parse(body); z.string().uuid().parse(id);
    return this.localSimulation.simulateFailure(req, actor.id, id, reason);
  }

  @Post('admin/billing/subscriptions/:id/recover')
  async recover(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.staff(req, ['ADMIN']);
    if (transport !== 'test') throw new ConflictException({ code: 'LOCAL_BILLING_SIMULATION_DISABLED', message: '外部決済契約はWebhookから同期してください。' });
    const { reason } = reasonSchema.parse(body); z.string().uuid().parse(id);
    return this.localSimulation.simulateRecovery(req, actor.id, id, reason);
  }
}
