import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

describe('member conversion funnel', () => {
  it('records first-time member milestones and exposes aggregate counts to AAL2 staff', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const before = await admin.call('admin/summary'); expect(before.status).toBe(200);

    const fixture = await account();
    const source = `integration-${randomUUID()}`;
    await db.memberAcquisition.create({ data: { userId: fixture.user.id, source, medium: 'test', campaign: 'funnel' } });
    await db.lineAccount.create({ data: { userId: fixture.user.id, subject: `funnel-${randomUUID()}` } });
    const member = new Client(); await member.login(fixture);

    expect((await member.call('me/journey', 'POST', { eventType: 'PLAN_VIEWED' })).status).toBe(201);
    expect((await member.call('me/journey', 'POST', { eventType: 'PLAN_VIEWED' })).status).toBe(201);
    expect(await db.memberJourneyEvent.count({ where: { userId: fixture.user.id, eventType: 'PLAN_VIEWED' } })).toBe(1);
    expect((await member.call('me/journey', 'POST', { eventType: 'CHECKOUT_REVIEWED' })).status).toBe(201);
    expect((await member.call('me/journey', 'POST', { eventType: 'UNKNOWN' })).status).toBe(400);

    await db.$transaction(async tx => {
      const now = new Date(); const endsAt = new Date(now.getTime() + 30 * 86400000);
      const entitlement = await tx.entitlement.create({ data: { userId: fixture.user.id, planCode: 'STANDARD', startsAt: now, endsAt, reason: 'FUNNEL_INTEGRATION_TEST', grantedBy: fixture.user.id } });
      const subscription = await tx.subscription.create({ data: { userId: fixture.user.id, planCode: 'STANDARD', status: 'ACTIVE', priceYen: 2980, currentPeriodStartsAt: now, currentPeriodEndsAt: endsAt, provider: 'LOCAL_TEST', providerSubscriptionId: `funnel-sub-${randomUUID()}`, entitlementId: entitlement.id } });
      await tx.paymentTransaction.create({ data: { userId: fixture.user.id, provider: 'LOCAL_TEST', providerPaymentId: `funnel-pay-${randomUUID()}`, kind: 'SUBSCRIPTION', status: 'SUCCEEDED', amountYen: 2980, subscriptionId: subscription.id } });
    });
    const after = await admin.call('admin/summary'); expect(after.status).toBe(200);
    for (const stage of ['registered', 'identityReady', 'lineReady', 'planViewed', 'checkoutReviewed', 'paid']) {
      expect(after.body.funnel.all[stage] - before.body.funnel.all[stage], stage).toBe(1);
      expect(after.body.funnel.last30Days[stage] - before.body.funnel.last30Days[stage], stage).toBe(1);
    }
    expect(after.body.funnel.trackingStartsAt).toBeTruthy();
    expect(after.body.acquisition.last30Days).toContainEqual({ source, medium: 'test', campaign: 'funnel', registered: 1, paid: 1 });

    const nonMember = new Client(); await nonMember.login(await account('OPERATOR')); await nonMember.mfa();
    expect((await nonMember.call('me/journey', 'POST', { eventType: 'PLAN_VIEWED' })).status).toBe(403);
  });
});
