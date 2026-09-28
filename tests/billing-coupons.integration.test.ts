import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';

const code = (prefix: string) => `${prefix}_${randomBytes(5).toString('hex').toUpperCase()}`;

describe('billing plan controls and coupon V1', () => {
  let admin: Client;
  let onceCode: string;
  beforeAll(async () => {
    await db.systemSetting.update({ where: { id: 'global' }, data: {
      newPurchasesEnabled: true, founderSalesEnabled: false, standardSalesEnabled: true, dayPassSalesEnabled: true,
      standardPriceYen: 2980, dayPassPriceYen: 980
    } });
    admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
  });
  afterAll(async () => {
    await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: false, founderSalesEnabled: false, standardSalesEnabled: true, dayPassSalesEnabled: true } });
    await db.$disconnect();
  });

  it('requires ADMIN+AAL2 and creates an immutable coupon definition', async () => {
    const member = new Client(); await member.login(await account());
    expect((await member.call('admin/billing/coupons')).status).toBe(403);
    const aal1 = new Client(); await aal1.login(await account('ADMIN'));
    expect((await aal1.call('admin/billing/coupons')).body.code).toBe('MFA_REQUIRED');

    onceCode = code('WELCOME10');
    const created = await admin.call('admin/billing/coupons', 'POST', {
      code: onceCode, name: '初回10%割引', discountType: 'PERCENT', discountValue: 10, duration: 'ONCE',
      applicablePlanCodes: ['STANDARD', 'DAY_PASS'], startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
      maxRedemptions: 2, reason: 'クーポン結合試験'
    });
    expect(created.status).toBe(201);
    expect(created.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ code: onceCode, redeemedCount: 0, active: true })]));
    expect(await db.auditLog.findFirst({ where: { action: 'BILLING_COUPON_CREATED', targetType: 'BillingCoupon' } })).not.toBeNull();
  });

  it('previews and applies an initial-payment coupon without changing the recurring price', async () => {
    const fixture = await account(); const member = new Client(); await member.login(fixture);
    const preview = await member.call('billing/coupons/preview', 'POST', { planCode: 'STANDARD', couponCode: onceCode.toLowerCase() });
    expect(preview).toMatchObject({ status: 201, body: { code: onceCode, baseAmountYen: 2980, discountAmountYen: 298, amountYen: 2682, duration: 'ONCE' } });
    const checkout = await member.call('billing/checkout', 'POST', { planCode: 'STANDARD', couponCode: onceCode }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(checkout.status).toBe(201);
    const [subscription, payment, redemption] = await Promise.all([
      db.subscription.findUniqueOrThrow({ where: { id: checkout.body.subscriptionId } }),
      db.paymentTransaction.findUniqueOrThrow({ where: { id: checkout.body.paymentId } }),
      db.billingCouponRedemption.findFirstOrThrow({ where: { userId: fixture.user.id } })
    ]);
    expect(subscription.priceYen).toBe(2980);
    expect(payment.amountYen).toBe(2682);
    expect(redemption).toMatchObject({ status: 'REDEEMED', paymentTransactionId: payment.id });
    const secondUse = await member.call('billing/day-pass', 'POST', { raceDate: '2099-06-05', couponCode: onceCode }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(secondUse).toMatchObject({ status: 409, body: { code: 'COUPON_ALREADY_USED' } });
  });

  it('enforces the global limit and plan-specific sales switches', async () => {
    const secondFixture = await account(); const second = new Client(); await second.login(secondFixture);
    const pass = await second.call('billing/day-pass', 'POST', { raceDate: '2099-06-06', couponCode: onceCode }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(pass.status).toBe(201);
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: pass.body.paymentId } })).amountYen).toBe(882);
    const third = new Client(); await third.login(await account());
    expect(await third.call('billing/coupons/preview', 'POST', { planCode: 'DAY_PASS', couponCode: onceCode })).toMatchObject({ status: 409, body: { code: 'COUPON_LIMIT_REACHED' } });

    await db.systemSetting.update({ where: { id: 'global' }, data: { standardSalesEnabled: false, dayPassSalesEnabled: false } });
    const plans = await third.call('billing/plans');
    expect(plans.body.plans.find((item: { code: string }) => item.code === 'STANDARD').available).toBe(false);
    expect(plans.body.plans.find((item: { code: string }) => item.code === 'DAY_PASS').available).toBe(false);
    expect((await third.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': randomUUID() })).body.code).toBe('STANDARD_SALES_CLOSED');
    expect((await third.call('billing/day-pass', 'POST', { raceDate: '2099-06-07' }, undefined, { 'Idempotency-Key': randomUUID() })).body.code).toBe('DAY_PASS_SALES_CLOSED');
    await db.systemSetting.update({ where: { id: 'global' }, data: { standardSalesEnabled: true, dayPassSalesEnabled: true } });
  });

  it('supports a continuing monthly discount and prevents concurrent over-redemption', async () => {
    const foreverCode = code('LOYAL500');
    await admin.call('admin/billing/coupons', 'POST', {
      code: foreverCode, name: '月額500円継続割引', discountType: 'FIXED_YEN', discountValue: 500, duration: 'FOREVER', applicablePlanCodes: ['STANDARD'],
      startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(), maxRedemptions: 1, reason: '継続割引の結合試験'
    });
    const fixtures = await Promise.all([account(), account()]);
    const clients = await Promise.all(fixtures.map(async fixture => { const client = new Client(); await client.login(fixture); return client; }));
    const results = await Promise.all(clients.map(client => client.call('billing/checkout', 'POST', { planCode: 'STANDARD', couponCode: foreverCode }, undefined, { 'Idempotency-Key': randomUUID() })));
    expect(results.map(result => result.status).sort()).toEqual([201, 409]);
    expect(results.find(result => result.status === 409)?.body.code).toBe('COUPON_LIMIT_REACHED');
    const successful = results.find(result => result.status === 201)!;
    expect((await db.subscription.findUniqueOrThrow({ where: { id: successful.body.subscriptionId } })).priceYen).toBe(2480);
    expect((await db.paymentTransaction.findUniqueOrThrow({ where: { id: successful.body.paymentId } })).amountYen).toBe(2480);
  });

  it('deactivates future use while preserving existing redemption history', async () => {
    const list = await admin.call('admin/billing/coupons');
    const coupon = list.body.items.find((item: { code: string }) => item.code === onceCode);
    const stopped = await admin.call(`admin/billing/coupons/${coupon.id}/deactivate`, 'POST', { reason: 'キャンペーン終了' });
    expect(stopped.status).toBe(201);
    expect(stopped.body.items.find((item: { id: string }) => item.id === coupon.id)).toMatchObject({ active: false, redeemedCount: 2 });
    const another = new Client(); await another.login(await account());
    expect(await another.call('billing/coupons/preview', 'POST', { planCode: 'STANDARD', couponCode: onceCode })).toMatchObject({ status: 409, body: { code: 'COUPON_NOT_AVAILABLE' } });
    expect(await db.auditLog.findFirst({ where: { action: 'BILLING_COUPON_DEACTIVATED', targetId: coupon.id } })).not.toBeNull();
  });
});
