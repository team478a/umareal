import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { account, Client, db } from './helpers';

beforeAll(() => { const url = new URL(process.env.DATABASE_URL ?? ''); if (!['localhost', '127.0.0.1'].includes(url.hostname) || process.env.AUTH_PROVIDER !== 'local') throw new Error('Integration suite is limited to a local development database'); });
afterAll(() => db.$disconnect());

describe('extended administrator notification tests', () => {
  it('tests race, WIN5 and billing messages without publishing or creating member deliveries', async () => {
    const suffix = randomUUID().slice(0, 8);
    const admin = await account('ADMIN'); const member = await account(); const client = new Client(); await client.login(admin); await client.mfa();
    await db.systemSetting.update({ where: { id: 'global' }, data: { emailNotificationsEnabled: true, lineNotificationsEnabled: false } });

    let dayOffset = Number.parseInt(suffix, 16) % 20_000;
    let targetDate = new Date(Date.UTC(2199, 0, 1) + dayOffset * 86_400_000).toISOString().slice(0, 10);
    while (await db.predictionProduct.findFirst({ where: { type: 'WIN5_PREVIEW', targetDate } })) {
      dayOffset += 1;
      targetDate = new Date(Date.UTC(2199, 0, 1) + dayOffset * 86_400_000).toISOString().slice(0, 10);
    }

    const race = await db.race.create({ data: { raceDate: targetDate, venue: `通知${suffix}`, number: 9, name: `パドック通知${suffix}`, startsAt: new Date(`${targetDate}T15:00:00+09:00`) } });
    await db.prediction.create({ data: { raceId: race.id, revision: 1, updatedBy: admin.user.id, draft: { visibility: 'PAID', confidence: 'SKIP', summary: '状態を確認したうえで見送ります。', marks: [] } } });

    const product = await db.predictionProduct.create({ data: { type: 'WIN5_PREVIEW', targetDate, title: `WIN5通知${suffix}`, expertId: admin.user.id, scheduledPublishAt: new Date(`${targetDate}T09:00:00+09:00`), confidence: 'A', summary: '5レース全体の展開と評価を確認します。', updatedBy: admin.user.id } });
    for (let legNumber = 1; legNumber <= 5; legNumber += 1) {
      const legRace = legNumber === 1 ? race : await db.race.create({ data: { raceDate: targetDate, venue: `通知${suffix}`, number: legNumber, name: `WIN5第${legNumber}対象${suffix}`, startsAt: new Date(`${targetDate}T${10 + legNumber}:00:00+09:00`) } });
      await db.predictionProductRace.create({ data: { productId: product.id, raceId: legRace.id, legNumber, confidence: 'A', paceView: '展開見解', shortComment: 'レース短評' } });
    }

    const startsAt = new Date(); const endsAt = new Date(startsAt.getTime() + 30 * 86400000);
    const entitlement = await db.entitlement.create({ data: { userId: member.user.id, planCode: 'STANDARD', startsAt, endsAt, reason: '通知テスト', grantedBy: admin.user.id } });
    const subscription = await db.subscription.create({ data: { userId: member.user.id, planCode: 'STANDARD', status: 'ACTIVE', priceYen: 2980, currentPeriodStartsAt: startsAt, currentPeriodEndsAt: endsAt, provider: 'LOCAL_TEST', providerSubscriptionId: `notification-test-${suffix}`, entitlementId: entitlement.id } });

    const options = await client.call('admin/notifications/test-options');
    expect(options.status).toBe(200);
    expect(options.body.races).toEqual(expect.arrayContaining([expect.objectContaining({ id: race.id })]));
    expect(options.body.products).toEqual(expect.arrayContaining([expect.objectContaining({ id: product.id })]));
    expect(options.body.subscriptions).toEqual(expect.arrayContaining([expect.objectContaining({ id: subscription.id })]));

    const beforeEvents = await db.notificationEvent.count();
    const cases = [
      { contentType: 'RACE_PREDICTION', raceId: race.id, label: 'パドック直前予想の公開通知' },
      { contentType: 'WIN5_PREDICTION', productId: product.id, label: 'WIN5紙面予想の公開通知' },
      { contentType: 'BILLING_PAYMENT_SUCCEEDED', subscriptionId: subscription.id, label: '支払成功通知' },
      { contentType: 'BILLING_PAYMENT_FAILED', subscriptionId: subscription.id, label: '支払失敗通知' },
      { contentType: 'BILLING_PAYMENT_RECOVERED', subscriptionId: subscription.id, label: '支払回復通知' },
      { contentType: 'BILLING_CANCELLATION_SCHEDULED', subscriptionId: subscription.id, label: '解約予約通知' },
      { contentType: 'BILLING_SUBSCRIPTION_ENDED', subscriptionId: subscription.id, label: '契約終了通知' }
    ];
    for (const item of cases) {
      const response = await client.call('admin/notifications/test-send', 'POST', { ...item, label: undefined, channel: 'EMAIL', reason: '管理者本人で通知文面を確認' }, undefined, { 'Idempotency-Key': randomUUID() });
      expect(response.status).toBe(201); expect(response.body).toMatchObject({ status: 'SIMULATED', contentLabel: item.label, channel: 'EMAIL', transport: 'TEST_ONLY' });
    }
    expect(await db.notificationEvent.count()).toBe(beforeEvents);
    expect(await db.notificationDelivery.count({ where: { userId: member.user.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { actorId: admin.user.id, action: 'NOTIFICATION_TEST_SENT' } })).toBeGreaterThanOrEqual(cases.length);
  });
});
