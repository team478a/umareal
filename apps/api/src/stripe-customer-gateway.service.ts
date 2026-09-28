import { ConflictException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';
import { DbService } from './db.service';
import { loadStripeConfig } from './stripe-config';

@Injectable()
export class StripeCustomerGatewayService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  protected async configuredClient() {
    const config = await loadStripeConfig(this.db);
    if (!config.usable) throw new ServiceUnavailableException({ code: 'STRIPE_NOT_CONFIGURED', message: '外部決済の設定が完了していません。' });
    return new Stripe(config.secretKey!);
  }

  async receiptUrl(providerPaymentId: string) {
    const client = await this.configuredClient();
    let receiptUrl: string | null = null;
    if (providerPaymentId.startsWith('checkout:') || providerPaymentId.startsWith('review-grant:')) {
      const sessionId = providerPaymentId.startsWith('review-grant:') ? providerPaymentId.slice('review-grant:'.length) : providerPaymentId.slice('checkout:'.length);
      const session = await client.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent.latest_charge', 'invoice'] });
      const invoice = session.invoice && typeof session.invoice === 'object' ? session.invoice : null;
      const intent = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
      const charge = intent?.latest_charge && typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
      receiptUrl = charge?.receipt_url ?? invoice?.hosted_invoice_url ?? null;
    } else if (providerPaymentId.startsWith('invoice:')) {
      const invoiceId = providerPaymentId.slice('invoice:'.length).replace(/:paid$/, '');
      const invoice = await client.invoices.retrieve(invoiceId);
      receiptUrl = invoice.hosted_invoice_url ?? null;
    }
    if (!receiptUrl) throw new ConflictException({ code: 'RECEIPT_NOT_READY', message: '領収書はまだ発行されていません。時間をおいて再度お試しください。' });
    const parsed = new URL(receiptUrl);
    if (parsed.protocol !== 'https:' || !(parsed.hostname === 'stripe.com' || parsed.hostname.endsWith('.stripe.com'))) throw new ServiceUnavailableException({ code: 'RECEIPT_URL_INVALID', message: '領収書リンクを安全に確認できません。' });
    return parsed.toString();
  }

  async customerPortalUrl(providerSubscriptionId: string, returnUrl: string) {
    const client = await this.configuredClient();
    const external = await client.subscriptions.retrieve(providerSubscriptionId);
    const customerId = this.providerId(external.customer);
    if (!customerId) throw new ConflictException({ code: 'STRIPE_CUSTOMER_MISSING', message: 'Stripeの会員情報を確認できません。運営へお問い合わせください。' });
    let session;
    try { session = await client.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl }); }
    catch { throw new ServiceUnavailableException({ code: 'STRIPE_PORTAL_UNAVAILABLE', message: '支払い方法の変更画面を開始できませんでした。時間をおいて再度お試しください。' }); }
    const url = new URL(session.url);
    if (url.protocol !== 'https:' || !(url.hostname === 'billing.stripe.com' || url.hostname.endsWith('.billing.stripe.com'))) throw new ServiceUnavailableException({ code: 'STRIPE_PORTAL_URL_INVALID', message: '支払い方法の変更画面を安全に確認できません。' });
    return url.toString();
  }

  private providerId(value: unknown) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') return value.id;
    return null;
  }
}
