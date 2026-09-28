import { ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { loadStripeConfig } from './stripe-config';
import { stripePriceMatchesCheckout } from './stripe-price';

@Injectable()
export class StripeCheckoutService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  protected async configuredClient() {
    const config = await loadStripeConfig(this.auth.db);
    if (!config.usable) throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED', message: '外部決済の設定が完了していません。' });
    return { config, client: new Stripe(config.secretKey!) };
  }

  async create(req: AppRequest, userId: string, email: string | null, kind: 'SUBSCRIPTION' | 'DAY_PASS', planCode: 'FOUNDER' | 'STANDARD' | 'DAY_PASS', raceDate: string | null, idempotencyKey: string, requestHash: string) {
    if (!email) throw new ForbiddenException({ code: 'VERIFIED_EMAIL_REQUIRED', message: '確認済みメールアドレスが必要です。' });
    const { config: stripeConfig, client } = await this.configuredClient();
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
}
