import { Inject, Injectable } from '@nestjs/common';
import { launchCapabilities, resolveLaunchMode } from '@keiba/domain';
import { DbService } from './db.service';
import { loadStripeConfig } from './stripe-config';
import { BankTransferService } from './bank-transfer.service';

@Injectable()
export class BillingQueryService {
  constructor(@Inject(DbService) private readonly db: DbService, @Inject(BankTransferService) private readonly bankTransfers: BankTransferService) {}

  async plans() {
    const settings = await this.db.systemSetting.findUniqueOrThrow({
      where: { id: 'global' },
      select: { newPurchasesEnabled: true, founderSalesEnabled: true, standardSalesEnabled: true, dayPassSalesEnabled: true, founderPriceYen: true, standardPriceYen: true, dayPassPriceYen: true, founderSalesLimit: true },
    });
    const now = new Date();
    const [founderSold, founderReserved, founderBankReserved] = await Promise.all([
      this.db.subscription.count({ where: { planCode: 'FOUNDER', status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED'] } } }),
      this.db.billingCheckout.count({ where: { planCode: 'FOUNDER', status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: now } } }),
      this.db.bankTransferRequest.count({ where: { planCode: 'FOUNDER', status: { in: ['AWAITING_TRANSFER', 'TRANSFER_REPORTED'] }, expiresAt: { gt: now } } }),
    ]);
    const founderUnavailable = founderSold + founderReserved + founderBankReserved;
    const bankSettings = await this.bankTransfers.settings();
    const billingEnabled = launchCapabilities(resolveLaunchMode(process.env.LAUNCH_MODE)).billing || process.env.BILLING_TRANSPORT === 'bank_transfer';
    const stripeConfig = billingEnabled && process.env.BILLING_TRANSPORT === 'stripe' ? await loadStripeConfig(this.db) : null;
    const transportAvailable = billingEnabled && (process.env.BILLING_TRANSPORT === 'test' || (process.env.BILLING_TRANSPORT === 'stripe' && stripeConfig?.usable) || (process.env.BILLING_TRANSPORT === 'bank_transfer' && bankSettings.enabled));
    return {
      newPurchasesEnabled: billingEnabled && settings.newPurchasesEnabled,
      developmentTerms: true,
      billingTransport: process.env.BILLING_TRANSPORT,
      stripeMode: stripeConfig ? stripeConfig.liveMode ? 'LIVE' : 'TEST' : null,
      currency: 'JPY',
      taxIncluded: true,
      plans: [
        { code: 'FOUNDER', name: '創設会員', priceYen: settings.founderPriceYen, interval: 'MONTH', available: transportAvailable && settings.newPurchasesEnabled && settings.founderSalesEnabled && founderUnavailable < settings.founderSalesLimit, remaining: Math.max(0, settings.founderSalesLimit - founderUnavailable) },
        { code: 'STANDARD', name: '通常会員', priceYen: settings.standardPriceYen, interval: 'MONTH', available: transportAvailable && settings.newPurchasesEnabled && settings.standardSalesEnabled },
        { code: 'DAY_PASS', name: '1日利用', priceYen: settings.dayPassPriceYen, interval: 'JST_DAY', available: transportAvailable && settings.newPurchasesEnabled && settings.dayPassSalesEnabled },
      ],
    };
  }

  async member(userId: string) {
    const [subscriptions, dayPasses, payments, supportRequests, bankTransfers] = await Promise.all([
      this.db.subscription.findMany({ where: { userId }, select: { id: true, planCode: true, status: true, priceYen: true, currentPeriodEndsAt: true, graceEndsAt: true, cancelAtPeriodEnd: true, provider: true }, orderBy: { createdAt: 'desc' } }),
      this.db.dayPass.findMany({ where: { userId }, select: { id: true, raceDate: true, status: true, priceYen: true }, orderBy: { createdAt: 'desc' } }),
      this.db.paymentTransaction.findMany({ where: { userId }, select: { id: true, provider: true, kind: true, status: true, amountYen: true, occurredAt: true }, orderBy: { occurredAt: 'desc' } }),
      this.db.billingSupportRequest.findMany({ where: { userId }, select: { id: true, paymentTransactionId: true, category: true, message: true, status: true, createdAt: true, updatedAt: true, events: { select: { eventType: true, occurredAt: true }, orderBy: { occurredAt: 'asc' } } }, orderBy: { createdAt: 'desc' } }),
      this.bankTransfers.memberRequests(userId),
    ]);
    return {
      subscriptions: subscriptions.map(item => ({
        id: item.id,
        planCode: item.planCode,
        status: item.status,
        priceYen: item.priceYen,
        currentPeriodEndsAt: item.currentPeriodEndsAt,
        graceEndsAt: item.graceEndsAt,
        cancelAtPeriodEnd: item.cancelAtPeriodEnd,
      })),
      dayPasses,
      payments,
      supportRequests,
      bankTransfers,
      customerPortalAvailable: process.env.BILLING_TRANSPORT === 'stripe' && subscriptions.some(item => item.provider === 'STRIPE' && ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(item.status)),
    };
  }

  async admin() {
    const now = new Date();
    const [subscriptions, dayPasses, payments, checkouts, stripeWebhooks, supportRequests, pendingDayPassReviews, reviewCheckouts, bankTransfers, bankTransferSettings] = await Promise.all([
      this.db.subscription.findMany({ select: { id: true, planCode: true, status: true, priceYen: true, currentPeriodEndsAt: true, graceEndsAt: true, cancelAtPeriodEnd: true, user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.db.dayPass.findMany({ select: { id: true, raceDate: true, status: true, priceYen: true, user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.db.paymentTransaction.findMany({ select: { id: true, provider: true, kind: true, status: true, amountYen: true, occurredAt: true, user: { select: { email: true, displayName: true } } }, orderBy: { occurredAt: 'desc' }, take: 100 }),
      this.db.billingCheckout.findMany({ select: { id: true, kind: true, planCode: true, raceDate: true, amountYen: true, status: true, createdAt: true, expiresAt: true, completedAt: true, user: { select: { email: true, displayName: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.db.stripeWebhookEvent.findMany({ select: { id: true, providerEventId: true, eventType: true, livemode: true, outcome: true, receivedAt: true }, orderBy: { receivedAt: 'desc' }, take: 100 }),
      this.db.billingSupportRequest.findMany({ select: { id: true, category: true, message: true, status: true, createdAt: true, updatedAt: true, paymentTransaction: { select: { id: true, kind: true, status: true, amountYen: true, occurredAt: true } }, user: { select: { email: true, displayName: true } }, events: { select: { id: true, eventType: true, actorRole: true, reason: true, occurredAt: true }, orderBy: { occurredAt: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      this.db.dayPass.findMany({ where: { source: 'PURCHASE', status: { in: ['PENDING', 'REFUNDING'] }, startsAt: null, entitlementId: null, endsAt: { lte: now } }, select: { id: true, raceDate: true, status: true, priceYen: true, provider: true, endsAt: true, user: { select: { email: true, displayName: true } } }, orderBy: { endsAt: 'asc' }, take: 100 }),
      this.db.billingCheckout.findMany({ where: { status: { in: ['REJECTED_ACCOUNT_STATE', 'REJECTED_EXISTING_ACCESS', 'REJECTED_FOUNDER_LIMIT', 'REVIEW_REFUNDING'] } }, select: { id: true, kind: true, planCode: true, raceDate: true, amountYen: true, status: true, completedAt: true, user: { select: { email: true, displayName: true } }, payments: { select: { id: true, status: true, occurredAt: true }, orderBy: { occurredAt: 'asc' } } }, orderBy: { completedAt: 'asc' }, take: 100 }),
      this.bankTransfers.adminRequests(),
      this.bankTransfers.settings(),
    ]);
    return { billingTransport: process.env.BILLING_TRANSPORT, subscriptions, dayPasses, payments, checkouts, stripeWebhooks, supportRequests, pendingDayPassReviews, reviewCheckouts, bankTransfers, bankTransferSettings };
  }
}
