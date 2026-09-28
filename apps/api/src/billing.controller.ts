import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req, ServiceUnavailableException } from '@nestjs/common';
import { adminBillingCheckoutResolutionResponseSchema, adminBillingCouponsResponseSchema, adminBillingDayPassRefundResponseSchema, adminBillingFailureSimulationResponseSchema, adminBillingRecoverySimulationResponseSchema, adminBillingResponseSchema, adminBillingSupportStatusResponseSchema, billingCouponCreateSchema, billingCouponDeactivateSchema, billingCouponPreviewResponseSchema, billingCouponPreviewSchema, billingDayPassCheckoutResponseSchema, billingPlansResponseSchema, billingPortalResponseSchema, billingReceiptResponseSchema, billingReviewResolutionSchema, billingSubscriptionCheckoutResponseSchema, billingSubscriptionLifecycleResponseSchema, billingSupportRequestCreatedResponseSchema, billingSupportRequestSchema, billingSupportStatusSchema, canManage, dayPassCheckoutWithCouponSchema, jstDate, launchCapabilities, memberBillingResponseSchema, requiresMfa, resolveLaunchMode, subscriptionCheckoutSchema } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';
import { StripeCustomerGatewayService } from './stripe-customer-gateway.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { StripeCheckoutService } from './stripe-checkout.service';
import { BillingSubscriptionLifecycleService } from './billing-subscription-lifecycle.service';
import { BillingAdminResolutionService } from './billing-admin-resolution.service';
import { BillingSupportService } from './billing-support.service';
import { BillingLocalSimulationService } from './billing-local-simulation.service';
import { BillingLocalCheckoutService } from './billing-local-checkout.service';
import { BillingQueryService } from './billing-query.service';
import { BillingCouponService } from './billing-coupon.service';

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
    @Inject(BillingLocalCheckoutService) private readonly localCheckout: BillingLocalCheckoutService,
    @Inject(BillingQueryService) private readonly billingQuery: BillingQueryService,
    @Inject(BillingCouponService) private readonly coupons: BillingCouponService
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
    return billingPlansResponseSchema.parse(await this.billingQuery.plans());
  }

  @Get('billing/me')
  async mine(@Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    return memberBillingResponseSchema.parse(await this.billingQuery.member(actor.id));
  }

  @Get('billing/payments/:id/receipt')
  async receipt(@Param('id') id: string, @Req() req: AppRequest) {
    const actor = await this.auth.authenticate(req);
    z.string().uuid().parse(id);
    const payment = await this.auth.db.paymentTransaction.findUnique({ where: { id } });
    if (!payment || payment.userId !== actor.id) throw new NotFoundException({ code: 'PAYMENT_NOT_FOUND', message: '対象の支払いを確認できません。' });
    if (payment.provider !== 'STRIPE' || payment.status !== 'SUCCEEDED') throw new ConflictException({ code: 'RECEIPT_NOT_AVAILABLE', message: 'この支払いには外部決済の領収書がありません。' });
    const receiptUrl = await this.stripeCustomer.receiptUrl(payment.providerPaymentId);
    return billingReceiptResponseSchema.parse({ paymentId: payment.id, receiptUrl });
  }

  @Post('billing/support-requests')
  async createSupportRequest(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    const input = billingSupportRequestSchema.parse(body);
    const key = this.key(req, 'billing-support', actor.id);
    const requestHash = hashToken(JSON.stringify(input));
    return billingSupportRequestCreatedResponseSchema.parse(await this.billingSupport.create(req, actor.id, input, key, requestHash));
  }

  @Post('billing/checkout')
  async checkout(@Req() req: AppRequest, @Body() body: unknown) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); const input = subscriptionCheckoutSchema.parse(body);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    if (!this.purchaseIdentityReady(actor.user)) throw new ForbiddenException({ code: 'VERIFIED_LOGIN_REQUIRED', message: '申込前にメールアドレスの確認を完了してください。' });
    const key = this.key(req, 'subscription-checkout', actor.id); const requestHash = hashToken(JSON.stringify(input));
    const response = transport === 'stripe'
      ? await this.stripeCheckout.create(req, actor.id, actor.user.email, 'SUBSCRIPTION', input.planCode, null, input.couponCode, key, requestHash)
      : await this.localCheckout.subscription(actor.id, input.planCode, input.couponCode, key, requestHash);
    return billingSubscriptionCheckoutResponseSchema.parse(response);
  }

  @Post('billing/day-pass')
  async dayPass(@Req() req: AppRequest, @Body() body: unknown) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); const input = dayPassCheckoutWithCouponSchema.parse(body);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    if (!this.purchaseIdentityReady(actor.user)) throw new ForbiddenException({ code: 'VERIFIED_LOGIN_REQUIRED', message: '申込前にメールアドレスの確認を完了してください。' });
    if (input.raceDate < jstDate(new Date())) throw new BadRequestException({ code: 'PAST_RACE_DATE', message: '過去の日付は購入できません。' });
    const key = this.key(req, 'day-pass', actor.id); const requestHash = hashToken(JSON.stringify(input));
    const response = transport === 'stripe'
      ? await this.stripeCheckout.create(req, actor.id, actor.user.email, 'DAY_PASS', 'DAY_PASS', input.raceDate, input.couponCode, key, requestHash)
      : await this.localCheckout.dayPass(actor.id, input.raceDate, input.couponCode, key, requestHash);
    return billingDayPassCheckoutResponseSchema.parse(response);
  }

  @Post('billing/coupons/preview')
  async previewCoupon(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.auth.authenticate(req);
    if (actor.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員本人としてログインしてください。' });
    const input = billingCouponPreviewSchema.parse(body);
    const settings = await this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { founderPriceYen: true, standardPriceYen: true, dayPassPriceYen: true } });
    const baseAmountYen = input.planCode === 'FOUNDER' ? settings.founderPriceYen : input.planCode === 'STANDARD' ? settings.standardPriceYen : settings.dayPassPriceYen;
    return billingCouponPreviewResponseSchema.parse(await this.coupons.preview(actor.id, input.planCode, baseAmountYen, input.couponCode));
  }

  @Post('webhooks/stripe')
  stripeWebhook(@Req() req: AppRequest) {
    return this.stripeWebhookService.handle(req);
  }


  @Post('billing/subscriptions/:id/cancel')
  async cancel(@Param('id') id: string, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); z.string().uuid().parse(id);
    return billingSubscriptionLifecycleResponseSchema.parse(await this.subscriptionLifecycle.scheduleCancellation(req, actor.id, id, transport));
  }

  @Post('billing/subscriptions/:id/resume')
  async resume(@Param('id') id: string, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.auth.authenticate(req); z.string().uuid().parse(id);
    return billingSubscriptionLifecycleResponseSchema.parse(await this.subscriptionLifecycle.resume(req, actor.id, id, transport));
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
    return billingPortalResponseSchema.parse({ portalUrl });
  }

  @Get('admin/billing')
  async admin(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    return adminBillingResponseSchema.parse(await this.billingQuery.admin());
  }

  @Get('admin/billing/coupons')
  async adminCoupons(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    return adminBillingCouponsResponseSchema.parse(await this.coupons.list());
  }

  @Post('admin/billing/coupons')
  async createCoupon(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req, ['ADMIN']);
    const input = billingCouponCreateSchema.parse(body);
    await this.coupons.create(req, actor.id, input);
    return adminBillingCouponsResponseSchema.parse(await this.coupons.list());
  }

  @Post('admin/billing/coupons/:id/deactivate')
  async deactivateCoupon(@Param('id') id: string, @Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req, ['ADMIN']);
    z.string().uuid().parse(id);
    const input = billingCouponDeactivateSchema.parse(body);
    await this.coupons.deactivate(req, actor.id, id, input.reason);
    return adminBillingCouponsResponseSchema.parse(await this.coupons.list());
  }

  @Post('admin/billing/checkouts/:id/resolve')
  async resolveCheckoutReview(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    if (this.transport() !== 'stripe') throw new ConflictException({ code: 'STRIPE_REVIEW_RESOLUTION_DISABLED', message: '要確認決済の解決はStripe接続環境で行ってください。' });
    z.string().uuid().parse(id);
    const input = billingReviewResolutionSchema.parse(body);
    return adminBillingCheckoutResolutionResponseSchema.parse(await this.adminResolution.resolveCheckoutReview(req, actor.id, id, input));
  }

  @Post('admin/billing/day-passes/:id/refund')
  async refundExpiredPendingDayPass(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    const { reason } = reasonSchema.parse(body);
    z.string().uuid().parse(id);
    return adminBillingDayPassRefundResponseSchema.parse(await this.adminResolution.refundExpiredPendingDayPass(req, actor.id, id, reason));
  }

  @Post('admin/billing/support-requests/:id/status')
  async updateSupportStatus(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    z.string().uuid().parse(id);
    const input = billingSupportStatusSchema.parse(body);
    return adminBillingSupportStatusResponseSchema.parse(await this.billingSupport.updateStatus(req, actor.id, id, input));
  }

  @Post('admin/billing/subscriptions/:id/simulate-failure')
  async fail(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.staff(req, ['ADMIN']);
    if (transport !== 'test') throw new ConflictException({ code: 'LOCAL_BILLING_SIMULATION_DISABLED', message: '外部決済契約はWebhookから同期してください。' });
    const { reason } = reasonSchema.parse(body); z.string().uuid().parse(id);
    return adminBillingFailureSimulationResponseSchema.parse(await this.localSimulation.simulateFailure(req, actor.id, id, reason));
  }

  @Post('admin/billing/subscriptions/:id/recover')
  async recover(@Param('id') id: string, @Body() body: unknown, @Req() req: AppRequest) {
    const transport = this.transport(); const actor = await this.staff(req, ['ADMIN']);
    if (transport !== 'test') throw new ConflictException({ code: 'LOCAL_BILLING_SIMULATION_DISABLED', message: '外部決済契約はWebhookから同期してください。' });
    const { reason } = reasonSchema.parse(body); z.string().uuid().parse(id);
    return adminBillingRecoverySimulationResponseSchema.parse(await this.localSimulation.simulateRecovery(req, actor.id, id, reason));
  }
}
