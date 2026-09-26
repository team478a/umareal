import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';
import { activatePendingDayPasses } from '../apps/api/src/day-pass-access';

afterAll(async () => {
  await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: false, founderSalesEnabled: false, billingGraceDays: 0 } });
  await db.$disconnect();
});

describe('local billing lifecycle', () => {
  let member: Client; let memberId: string; let subscriptionId: string; let paymentId: string;
  beforeAll(async () => {
    const fixture = await account(); memberId = fixture.user.id; member = new Client(); await member.login(fixture);
    await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: false, founderSalesEnabled: false, standardPriceYen: 2980, dayPassPriceYen: 980, founderPriceYen: 1980, founderSalesLimit: 1, billingGraceDays: 1 } });
  });

  it('exposes settings and rejects purchases during the emergency stop', async () => {
    const plans = await member.call('billing/plans'); expect(plans.status).toBe(200); expect(plans.body.plans.find((p: { code: string }) => p.code === 'STANDARD').priceYen).toBe(2980);
    const stopped = await member.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(stopped.status).toBe(503); expect(stopped.body.code).toBe('PURCHASES_STOPPED');
    await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: true } });
  });

  it('creates one subscription, payment, and entitlement idempotently', async () => {
    const key = randomUUID(); const first = await member.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': key });
    expect(first.status).toBe(201); subscriptionId = first.body.subscriptionId; paymentId = first.body.paymentId;
    const replay = await member.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': key });
    expect(replay.body).toEqual(first.body);
    expect((await member.call('billing/checkout', 'POST', { planCode: 'STANDARD' }, undefined, { 'Idempotency-Key': randomUUID() })).body.code).toBe('ACTIVE_SUBSCRIPTION_EXISTS');
    expect(await db.entitlement.count({ where: { userId: memberId, planCode: 'STANDARD' } })).toBe(1);
    expect(await db.paymentTransaction.count({ where: { id: paymentId } })).toBe(1);
  });

  it('schedules cancellation without cutting off the paid period', async () => {
    const canceled = await member.call(`billing/subscriptions/${subscriptionId}/cancel`, 'POST'); expect(canceled.status).toBe(201); expect(canceled.body.cancelAtPeriodEnd).toBe(true);
    const repeated = await member.call(`billing/subscriptions/${subscriptionId}/cancel`, 'POST'); expect(repeated.status).toBe(201);
    const resumed = await member.call(`billing/subscriptions/${subscriptionId}/resume`, 'POST'); expect(resumed.status).toBe(201); expect(resumed.body.cancelAtPeriodEnd).toBe(false);
    const repeatedResume = await member.call(`billing/subscriptions/${subscriptionId}/resume`, 'POST'); expect(repeatedResume.status).toBe(201); expect(repeatedResume.body.cancelAtPeriodEnd).toBe(false);
    expect(await db.billingEvent.count({ where: { subscriptionId, eventType: 'CANCELLATION_REVERSED' } })).toBe(1);
    const subscription = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: { entitlement: true } });
    expect(subscription.entitlement.revokedAt).toBeNull(); expect(subscription.entitlement.endsAt).toEqual(subscription.currentPeriodEndsAt);
  });

  it('limits a day pass to its exclusive JST date and makes duplicate dates conflict', async () => {
    const fixture = await account(); const client = new Client(); await client.login(fixture); const raceDate = '2099-04-03';
    const first = await client.call('billing/day-pass', 'POST', { raceDate }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(first.status).toBe(201); expect(new Date(first.body.startsAt).toISOString()).toBe('2099-04-02T15:00:00.000Z'); expect(new Date(first.body.endsAt).toISOString()).toBe('2099-04-03T15:00:00.000Z');
    expect((await client.call('billing/day-pass', 'POST', { raceDate }, undefined, { 'Idempotency-Key': randomUUID() })).body.code).toBe('DAY_PASS_EXISTS');
  });

  it('enforces the founder cap under a server-side setting', async () => {
    const existing = await db.subscription.count({ where: { planCode: 'FOUNDER' } });
    await db.systemSetting.update({ where: { id: 'global' }, data: { founderSalesEnabled: true, founderSalesLimit: existing + 1 } });
    const a = new Client(); await a.login(await account()); const b = new Client(); await b.login(await account());
    expect((await a.call('billing/checkout', 'POST', { planCode: 'FOUNDER' }, undefined, { 'Idempotency-Key': randomUUID() })).status).toBe(201);
    const full = await b.call('billing/checkout', 'POST', { planCode: 'FOUNDER' }, undefined, { 'Idempotency-Key': randomUUID() }); expect(full.body.code).toBe('FOUNDER_LIMIT_REACHED');
  });

  it('restricts administration to AAL2 and records failure/recovery as append-only history', async () => {
    expect((await member.call('admin/billing')).status).toBe(403);
    const admin = new Client(); await admin.login(await account('ADMIN')); expect((await admin.call('admin/billing')).body.code).toBe('MFA_REQUIRED'); await admin.mfa();
    expect((await admin.call('admin/billing')).status).toBe(200);
    const failed = await admin.call(`admin/billing/subscriptions/${subscriptionId}/simulate-failure`, 'POST', { reason: '支払失敗の結合試験' }); expect(failed.body.status).toBe('PAST_DUE');
    const recovered = await admin.call(`admin/billing/subscriptions/${subscriptionId}/recover`, 'POST', { reason: '支払回復の結合試験' }); expect(recovered.body.status).toBe('ACTIVE');
    const attempts = await db.paymentTransaction.findMany({ where: { subscriptionId } }); expect(attempts.map(v => v.status)).toEqual(expect.arrayContaining(['SUCCEEDED', 'FAILED']));
    await expect(db.paymentTransaction.update({ where: { id: paymentId }, data: { amountYen: 1 } })).rejects.toThrow();
    const event = await db.billingEvent.findFirstOrThrow({ where: { subscriptionId } }); await expect(db.billingEvent.delete({ where: { id: event.id } })).rejects.toThrow();
  });

  it('refunds only an expired publication-wait day pass once and keeps an audit trail', async () => {
    const fixture = await account(); const client = new Client(); await client.login(fixture);
    const pass = await db.dayPass.create({ data: { userId: fixture.user.id, raceDate: '2026-01-03', status: 'PENDING', priceYen: 980, startsAt: null, endsAt: new Date('2026-01-03T15:00:00Z'), provider: 'LOCAL_TEST', source: 'PURCHASE', providerPassId: `expired-${randomUUID()}`, entitlementId: null } });
    const original = await db.paymentTransaction.create({ data: { userId: fixture.user.id, provider: 'LOCAL_TEST', providerPaymentId: `expired-pay-${randomUUID()}`, kind: 'DAY_PASS', status: 'SUCCEEDED', amountYen: 980, dayPassId: pass.id } });
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const review = await admin.call('admin/billing');
    expect(review.body.pendingDayPassReviews).toEqual(expect.arrayContaining([expect.objectContaining({ id: pass.id, raceDate: '2026-01-03' })]));
    const first = await admin.call(`admin/billing/day-passes/${pass.id}/refund`, 'POST', { reason: 'WIN5紙面が公開されず利用開始できなかったため' });
    expect(first.status).toBe(201); expect(first.body.status).toBe('REFUNDED');
    const replay = await admin.call(`admin/billing/day-passes/${pass.id}/refund`, 'POST', { reason: '状態再確認' });
    expect(replay.status).toBe(201); expect(replay.body.refundPaymentId).toBe(first.body.refundPaymentId);
    expect(await db.paymentTransaction.count({ where: { dayPassId: pass.id, status: 'REFUNDED' } })).toBe(1);
    expect(await db.dayPass.findUniqueOrThrow({ where: { id: pass.id } })).toMatchObject({ status: 'REFUNDED', startsAt: null, entitlementId: null });
    const billingEvent = await db.billingEvent.findFirstOrThrow({ where: { dayPassId: pass.id, eventType: 'DAY_PASS_REFUNDED' } });
    expect(await db.notificationEvent.findUnique({ where: { billingEventId: billingEvent.id } })).toMatchObject({ eventType: 'BILLING_REFUND_COMPLETED', status: 'QUEUED' });
    expect(await db.auditLog.findFirst({ where: { action: 'DAY_PASS_REFUNDED', targetId: pass.id } })).not.toBeNull();
    const receipt = await client.call(`billing/payments/${original.id}/receipt`);
    expect(receipt.status).toBe(409); expect(receipt.body.code).toBe('RECEIPT_NOT_AVAILABLE');
  });

  it('keeps a refund-reserved day pass out of WIN5 activation and resumes the refund once', async () => {
    const fixture = await account();
    const targetDate = '2099-05-08';
    const pass = await db.dayPass.create({ data: { userId: fixture.user.id, raceDate: targetDate, status: 'REFUNDING', priceYen: 980, startsAt: null, endsAt: new Date('2099-05-08T15:00:00Z'), provider: 'LOCAL_TEST', source: 'PURCHASE', providerPassId: `refunding-${randomUUID()}`, entitlementId: null } });
    await db.paymentTransaction.create({ data: { userId: fixture.user.id, provider: 'LOCAL_TEST', providerPaymentId: `refunding-pay-${randomUUID()}`, kind: 'DAY_PASS', status: 'SUCCEEDED', amountYen: 980, dayPassId: pass.id } });
    const activated = await db.$transaction(tx => activatePendingDayPasses(tx, targetDate, new Date('2099-05-08T00:00:00Z'), fixture.user.id));
    expect(activated).toBe(0);
    expect(await db.entitlement.count({ where: { userId: fixture.user.id, raceDate: targetDate } })).toBe(0);

    await db.dayPass.update({ where: { id: pass.id }, data: { endsAt: new Date('2026-01-03T15:00:00Z') } });
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const completed = await admin.call(`admin/billing/day-passes/${pass.id}/refund`, 'POST', { reason: '返金処理中断後の安全な再実行' });
    expect(completed.status).toBe(201); expect(completed.body.status).toBe('REFUNDED');
    const replay = await admin.call(`admin/billing/day-passes/${pass.id}/refund`, 'POST', { reason: '返金完了後の再送' });
    expect(replay.status).toBe(201); expect(replay.body.refundPaymentId).toBe(completed.body.refundPaymentId);
    expect(await db.paymentTransaction.count({ where: { dayPassId: pass.id, status: 'REFUNDED' } })).toBe(1);
  });
});
