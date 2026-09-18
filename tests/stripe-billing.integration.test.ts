import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';
import { encryptSecret } from '../packages/db/src/secret-box';

afterAll(() => db.$disconnect());
const stripe = describe.runIf(process.env.BILLING_TRANSPORT === 'stripe');

function signature(payload: unknown, secret = process.env.STRIPE_WEBHOOK_SECRET!) {
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

stripe('Stripe checkout webhook', () => {
  it('grants access only after a signed, matching and idempotent completion event', async () => {
    const fixture = await account();
    const checkout = await db.billingCheckout.create({ data: { userId: fixture.user.id, kind: 'SUBSCRIPTION', planCode: 'STANDARD', amountYen: 2980, status: 'OPEN', idempotencyKey: `subscription-checkout:${fixture.user.id}:${randomUUID()}`, requestHash: 'test-request', providerSessionId: `cs_test_${randomUUID()}`, providerCheckoutUrl: 'https://checkout.stripe.test/session', expiresAt: new Date(Date.now() + 30 * 60000) } });
    expect(await db.entitlement.count({ where: { userId: fixture.user.id } })).toBe(0);
    const payload = { id: `evt_${randomUUID()}`, object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { id: checkout.providerSessionId, object: 'checkout.session', metadata: { checkoutId: checkout.id, userId: fixture.user.id, kind: 'SUBSCRIPTION', planCode: 'STANDARD', raceDate: '' }, payment_status: 'paid', currency: 'jpy', amount_total: 2980, subscription: `sub_${randomUUID()}` } } };
    const client = new Client();
    const first = await client.call('webhooks/stripe', 'POST', payload, undefined, { 'Stripe-Signature': signature(payload) });
    expect(first.status).toBe(201); expect(first.body).toEqual(expect.objectContaining({ outcome: 'PROCESSED', duplicate: false }));
    expect(await db.entitlement.count({ where: { userId: fixture.user.id, revokedAt: null } })).toBe(1);
    expect(await db.subscription.findFirst({ where: { userId: fixture.user.id } })).toEqual(expect.objectContaining({ provider: 'STRIPE', status: 'ACTIVE', priceYen: 2980 }));
    expect(await db.paymentTransaction.count({ where: { userId: fixture.user.id, provider: 'STRIPE' } })).toBe(1);
    const replay = await client.call('webhooks/stripe', 'POST', payload, undefined, { 'Stripe-Signature': signature(payload) });
    expect(replay.body.duplicate).toBe(true);
    expect(await db.subscription.count({ where: { userId: fixture.user.id } })).toBe(1);

    const bad = { ...payload, id: `evt_${randomUUID()}`, data: { object: { ...payload.data.object, amount_total: 1 } } };
    const rejected = await client.call('webhooks/stripe', 'POST', bad, undefined, { 'Stripe-Signature': signature(bad) });
    expect(rejected.body.outcome).toBe('REJECTED');
    expect(await db.subscription.count({ where: { userId: fixture.user.id } })).toBe(1);
    const storedEvent = await db.stripeWebhookEvent.findUniqueOrThrow({ where: { providerEventId: payload.id } });
    await expect(db.stripeWebhookEvent.update({ where: { id: storedEvent.id }, data: { outcome: 'CHANGED' } })).rejects.toThrow(/append-only/);
    await expect(db.stripeWebhookEvent.delete({ where: { id: storedEvent.id } })).rejects.toThrow(/append-only/);
  });

  it('rejects an invalid signature without recording the event', async () => {
    const payload = { id: `evt_${randomUUID()}`, object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: {} } };
    const response = await new Client().call('webhooks/stripe', 'POST', payload, undefined, { 'Stripe-Signature': 't=1,v1=invalid' });
    expect(response.status).toBe(400); expect(response.body.code).toBe('STRIPE_SIGNATURE_INVALID');
    expect(await db.stripeWebhookEvent.count({ where: { providerEventId: payload.id } })).toBe(0);
  });

  it('records a paid checkout for review without granting access when the account is no longer eligible', async () => {
    const fixture = await account();
    const checkout = await db.billingCheckout.create({ data: { userId: fixture.user.id, kind: 'SUBSCRIPTION', planCode: 'STANDARD', amountYen: 2980, status: 'OPEN', idempotencyKey: `disabled-checkout:${fixture.user.id}:${randomUUID()}`, requestHash: 'disabled-checkout', providerSessionId: `cs_test_${randomUUID()}`, providerCheckoutUrl: 'https://checkout.stripe.test/session', expiresAt: new Date(Date.now() + 30 * 60000) } });
    await db.user.update({ where: { id: fixture.user.id }, data: { disabledAt: new Date() } });
    const payload = { id: `evt_${randomUUID()}`, object: 'event', type: 'checkout.session.completed', livemode: false, data: { object: { id: checkout.providerSessionId, object: 'checkout.session', metadata: { checkoutId: checkout.id, userId: fixture.user.id, kind: 'SUBSCRIPTION', planCode: 'STANDARD', raceDate: '' }, payment_status: 'paid', currency: 'jpy', amount_total: 2980, subscription: `sub_${randomUUID()}` } } };
    const response = await new Client().call('webhooks/stripe', 'POST', payload, undefined, { 'Stripe-Signature': signature(payload) });
    expect(response).toMatchObject({ status: 201, body: { outcome: 'REJECTED_ACCOUNT_STATE', duplicate: false } });
    expect(await db.entitlement.count({ where: { userId: fixture.user.id } })).toBe(0);
    expect(await db.subscription.count({ where: { userId: fixture.user.id } })).toBe(0);
    expect(await db.paymentTransaction.findUniqueOrThrow({ where: { providerPaymentId: `checkout:${checkout.providerSessionId}` } })).toMatchObject({ status: 'REQUIRES_REVIEW', amountYen: 2980 });
    expect(await db.billingCheckout.findUniqueOrThrow({ where: { id: checkout.id } })).toMatchObject({ status: 'REJECTED_ACCOUNT_STATE', completedAt: expect.any(Date) });
  });

  it('does not open a second subscription checkout while the first can still be paid', async () => {
    const fixture = await account();
    await db.billingCheckout.create({ data: { userId: fixture.user.id, kind: 'SUBSCRIPTION', planCode: 'STANDARD', amountYen: 2980, status: 'OPEN', idempotencyKey: `open-checkout:${fixture.user.id}:${randomUUID()}`, requestHash: 'open-checkout', providerSessionId: `cs_test_${randomUUID()}`, providerCheckoutUrl: 'https://checkout.stripe.test/session', expiresAt: new Date(Date.now() + 30 * 60000) } });
    const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { newPurchasesEnabled: true } });
    await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: true } });
    try {
      const client = new Client(); await client.login(fixture);
      const response = await client.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': randomUUID() });
      expect(response).toMatchObject({ status: 409, body: { code: 'CHECKOUT_ALREADY_OPEN' } });
    } finally {
      await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: settings.newPurchasesEnabled } });
    }
  });

  it('synchronizes renewal, failure, recovery, cancellation scheduling and termination', async () => {
    const fixture = await account();
    const providerSubscriptionId = `sub_${randomUUID()}`;
    const checkout = await db.billingCheckout.create({ data: { userId: fixture.user.id, kind: 'SUBSCRIPTION', planCode: 'STANDARD', amountYen: 2980, status: 'OPEN', idempotencyKey: `subscription-checkout:${fixture.user.id}:${randomUUID()}`, requestHash: 'lifecycle-test', providerSessionId: `cs_test_${randomUUID()}`, providerCheckoutUrl: 'https://checkout.stripe.test/session', expiresAt: new Date(Date.now() + 30 * 60000) } });
    const client = new Client();
    const post = async (type: string, object: Record<string, unknown>) => {
      const payload = { id: `evt_${randomUUID()}`, object: 'event', type, livemode: false, data: { object } };
      return { payload, response: await client.call('webhooks/stripe', 'POST', payload, undefined, { 'Stripe-Signature': signature(payload) }) };
    };
    await post('checkout.session.completed', { id: checkout.providerSessionId, object: 'checkout.session', metadata: { checkoutId: checkout.id, userId: fixture.user.id, kind: 'SUBSCRIPTION', planCode: 'STANDARD', raceDate: '' }, payment_status: 'paid', currency: 'jpy', amount_total: 2980, subscription: providerSubscriptionId });
    const subscription = await db.subscription.findUniqueOrThrow({ where: { providerSubscriptionId } });
    const initialStart = Math.floor(Date.now() / 1000) - 60;
    const initialEnd = initialStart + 30 * 86400;
    const initial = await post('invoice.paid', { id: `in_${randomUUID()}`, object: 'invoice', subscription: providerSubscriptionId, billing_reason: 'subscription_create', currency: 'jpy', amount_paid: 2980, lines: { data: [{ period: { start: initialStart, end: initialEnd } }] } });
    expect(initial.response.body.outcome).toBe('PROCESSED');
    expect(await db.paymentTransaction.count({ where: { subscriptionId: subscription.id } })).toBe(1);
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).currentPeriodEndsAt.toISOString()).toBe(new Date(initialEnd * 1000).toISOString());

    const renewalStart = initialEnd;
    const renewalEnd = renewalStart + 30 * 86400;
    const renewal = await post('invoice.paid', { id: `in_${randomUUID()}`, object: 'invoice', subscription: providerSubscriptionId, billing_reason: 'subscription_cycle', currency: 'jpy', amount_paid: 2980, lines: { data: [{ period: { start: renewalStart, end: renewalEnd } }] } });
    expect(renewal.response.body.outcome).toBe('PROCESSED');
    expect(await db.paymentTransaction.count({ where: { subscriptionId: subscription.id, status: 'SUCCEEDED' } })).toBe(2);
    const replay = await client.call('webhooks/stripe', 'POST', renewal.payload, undefined, { 'Stripe-Signature': signature(renewal.payload) });
    expect(replay.body).toEqual(expect.objectContaining({ duplicate: true, outcome: 'PROCESSED' }));

    const settings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
    await db.systemSetting.update({ where: { id: 'global' }, data: { billingGraceDays: 2 } });
    try {
      const expiredStart = new Date(Date.now() - 86400000);
      const expiredEnd = new Date(Date.now() - 1000);
      await db.subscription.update({ where: { id: subscription.id }, data: { currentPeriodStartsAt: expiredStart, currentPeriodEndsAt: expiredEnd } });
      await db.entitlement.update({ where: { id: subscription.entitlementId }, data: { startsAt: expiredStart, endsAt: expiredEnd } });
      const failed = await post('invoice.payment_failed', { id: `in_${randomUUID()}`, object: 'invoice', subscription: providerSubscriptionId, currency: 'jpy', amount_due: 2980 });
      expect(failed.response.body.outcome).toBe('PROCESSED');
      const pastDue = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id }, include: { entitlement: true } });
      expect(pastDue.status).toBe('PAST_DUE');
      expect(pastDue.graceEndsAt!.getTime()).toBeGreaterThan(Date.now() + 47 * 3600000);
      expect(pastDue.entitlement.endsAt).toEqual(pastDue.graceEndsAt);
      expect(pastDue.entitlement.revokedAt).toBeNull();
      await post('invoice.payment_failed', { id: `in_${randomUUID()}`, object: 'invoice', subscription: providerSubscriptionId, currency: 'jpy', amount_due: 2980 });
      expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).graceEndsAt).toEqual(pastDue.graceEndsAt);

      const recoveryStart = Math.floor(Date.now() / 1000);
      const recoveryEnd = recoveryStart + 30 * 86400;
      const recovered = await post('invoice.paid', { id: `in_${randomUUID()}`, object: 'invoice', subscription: providerSubscriptionId, billing_reason: 'subscription_cycle', currency: 'jpy', amount_paid: 2980, lines: { data: [{ period: { start: recoveryStart, end: recoveryEnd } }] } });
      expect(recovered.response.body.outcome).toBe('PROCESSED');
      expect(await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).toEqual(expect.objectContaining({ status: 'ACTIVE', graceEndsAt: null }));
      expect(await db.billingEvent.count({ where: { subscriptionId: subscription.id, eventType: 'PAYMENT_RECOVERED' } })).toBe(1);
    } finally {
      await db.systemSetting.update({ where: { id: 'global' }, data: { billingGraceDays: settings.billingGraceDays } });
    }

    const scheduled = await post('customer.subscription.updated', { id: providerSubscriptionId, object: 'subscription', cancel_at_period_end: true, canceled_at: Math.floor(Date.now() / 1000) });
    expect(scheduled.response.body.outcome).toBe('PROCESSED');
    expect((await db.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).cancelAtPeriodEnd).toBe(true);
    const ended = await post('customer.subscription.deleted', { id: providerSubscriptionId, object: 'subscription', canceled_at: Math.floor(Date.now() / 1000) });
    expect(ended.response.body.outcome).toBe('PROCESSED');
    const canceled = await db.subscription.findUniqueOrThrow({ where: { id: subscription.id }, include: { entitlement: true } });
    expect(canceled.status).toBe('CANCELED');
    expect(canceled.entitlement.revokedAt).not.toBeNull();
    expect(await db.billingEvent.count({ where: { subscriptionId: subscription.id, eventType: 'SUBSCRIPTION_ENDED' } })).toBe(1);
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const forbiddenSimulation = await admin.call(`admin/billing/subscriptions/${subscription.id}/simulate-failure`, 'POST', { reason: '外部契約では拒否する' });
    expect(forbiddenSimulation.status).toBe(409);
    expect(forbiddenSimulation.body.code).toBe('LOCAL_BILLING_SIMULATION_DISABLED');
  });

  it('uses encrypted administrator settings instead of environment credentials', async () => {
    const webhookSecret = `whsec_${'a'.repeat(32)}`;
    await db.systemSetting.update({ where: { id: 'global' }, data: { stripeSecretKeyEncrypted: encryptSecret(`sk_test_${'b'.repeat(32)}`), stripeWebhookSecretEncrypted: encryptSecret(webhookSecret), stripeLiveMode: false, stripePriceFounder: 'price_AdminFounder', stripePriceStandard: 'price_AdminStandard', stripePriceDayPass: 'price_AdminDayPass' } });
    try {
      const payload = { id: `evt_${randomUUID()}`, object: 'event', type: 'account.updated', livemode: false, data: { object: { id: `acct_${randomUUID()}` } } };
      const response = await new Client().call('webhooks/stripe', 'POST', payload, undefined, { 'Stripe-Signature': signature(payload, webhookSecret) });
      expect(response.status).toBe(201);
      expect(response.body.outcome).toBe('IGNORED');
    } finally {
      await db.systemSetting.update({ where: { id: 'global' }, data: { stripeSecretKeyEncrypted: null, stripeWebhookSecretEncrypted: null, stripeLiveMode: false, stripePriceFounder: null, stripePriceStandard: null, stripePriceDayPass: null } });
    }
  });
});
