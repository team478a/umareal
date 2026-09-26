import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NotificationTransport } from '../apps/worker/src/notification-runner';
import { runEmailNotificationBatch, runNotificationBatch, skipPendingNotificationEvents, TestNotificationTransport } from '../apps/worker/src/notification-runner';
import { account, Client, db } from './helpers';

let settingsBefore: Awaited<ReturnType<typeof db.systemSetting.findUniqueOrThrow>>;
beforeAll(async () => {
  settingsBefore = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
  await db.systemSetting.update({ where: { id: 'global' }, data: { emailNotificationsEnabled: true, lineNotificationsEnabled: true, lineChannelId: 'notification-test', lineChannelSecretEncrypted: 'test-encrypted', lineAccessTokenEncrypted: 'test-encrypted', notificationMaxAttempts: 3, notificationBaseDelaySeconds: 10 } });
  // A developer database can contain pending events from an interrupted earlier run. Never turn those into email during this test run.
  await db.notificationEvent.updateMany({ where: { emailExpandedAt: null }, data: { emailExpandedAt: new Date(), updatedAt: new Date() } });
  // Isolate the suite from due work left by interrupted local runs.
  await db.notificationDelivery.updateMany({ where: { status: { in: ['PENDING', 'RETRY_WAIT'] } }, data: { status: 'SKIPPED', forceAttempt: false, lastErrorCode: 'TEST_SETUP_CLEANUP', lockedAt: null, leaseToken: null, updatedAt: new Date() } });
  await db.notificationEvent.updateMany({ where: { expandedAt: null }, data: { expandedAt: new Date(), status: 'SKIPPED', updatedAt: new Date() } });
}, 120000);
afterAll(async () => {
  await db.systemSetting.update({ where: { id: 'global' }, data: { emailNotificationsEnabled: settingsBefore.emailNotificationsEnabled, lineNotificationsEnabled: settingsBefore.lineNotificationsEnabled, lineChannelId: settingsBefore.lineChannelId, lineChannelSecretEncrypted: settingsBefore.lineChannelSecretEncrypted, lineAccessTokenEncrypted: settingsBefore.lineAccessTokenEncrypted, notificationMaxAttempts: settingsBefore.notificationMaxAttempts, notificationBaseDelaySeconds: settingsBefore.notificationBaseDelaySeconds } });
  await db.$disconnect();
});

async function publication(visibility: 'FREE' | 'PAID' = 'FREE') {
  const publisher = await account('ADMIN');
  const suffix = randomUUID().slice(0, 8);
  return db.$transaction(async tx => {
    const race = await tx.race.create({ data: { raceDate: '2098-06-01', venue: `通知${suffix}`, number: 1, name: `通知試験${suffix}`, startsAt: new Date('2098-06-01T10:00:00+09:00') } });
    const prediction = await tx.prediction.create({ data: { raceId: race.id, draft: {}, revision: 1, updatedBy: publisher.user.id } });
    const version = await tx.predictionVersion.create({ data: { predictionId: prediction.id, version: 1, status: 'PUBLISHED', visibility, confidence: 'A', stance: 'SKIP', summary: '通知試験', estimatedTotalYen: 0, contentSnapshot: {}, assessmentSnapshot: {}, publisherId: publisher.user.id, deadlineAt: race.startsAt } });
    const event = await tx.notificationEvent.create({ data: { versionId: version.id, eventType: 'PREDICTION_PUBLISHED', status: 'QUEUED', payload: { versionId: version.id, raceId: race.id, visibility } } });
    return { race, version, event };
  });
}
async function win5Publication() {
  const publisher = await account('ADMIN');
  const suffix = randomUUID().slice(0, 8);
  const targetDate = new Date(Date.UTC(2090, 0, 1) + (parseInt(suffix, 16) % 10000) * 86400000).toISOString().slice(0, 10);
  return db.$transaction(async tx => {
    const races = [];
    for (let index = 0; index < 5; index += 1) races.push(await tx.race.create({ data: { raceDate: targetDate, venue: `通知W${suffix}${index}`, number: index + 1, name: `WIN5通知${index + 1}`, startsAt: new Date(`${targetDate}T${10 + index}:00:00Z`) } }));
    const product = await tx.predictionProduct.create({ data: { targetDate, title: `日曜WIN5紙面 ${suffix}`, expertId: publisher.user.id, status: 'PUBLISHED', accessScope: 'PAID', scheduledPublishAt: new Date(`${targetDate}T00:00:00Z`), publishedAt: new Date(), confidence: 'A', updatedBy: publisher.user.id, races: { create: races.map((race, index) => ({ raceId: race.id, legNumber: index + 1, confidence: 'A', strategyType: 'NORMAL', comment: '通知テスト' })) } } });
    const version = await tx.predictionProductVersion.create({ data: { productId: product.id, version: 1, status: 'PUBLISHED', accessScope: 'PAID', confidence: 'A', combinationCount: 2, amountPerPointYen: 100, assumedPurchaseAmountYen: 200, contentSnapshot: { secretHorse: '通知へ出してはいけない選択馬' }, publisherId: publisher.user.id, deadlineAt: races[0].startsAt } });
    const event = await tx.notificationEvent.create({ data: { productVersionId: version.id, eventType: 'WIN5_PREVIEW_PUBLISHED', status: 'QUEUED', payload: { productVersionId: version.id, productId: product.id, targetDate } } });
    return { product, version, event, firstRaceId: races[0].id };
  });
}
async function raceEvaluationResult(status: 'PRIMARY_WIN' | 'REVIEW_REQUIRED' = 'PRIMARY_WIN') {
  const publisher = await account('ADMIN');
  const suffix = randomUUID().slice(0, 8);
  return db.$transaction(async tx => {
    const race = await tx.race.create({ data: { raceDate: '2098-07-01', venue: `結果${suffix}`, number: 6, name: `評価通知試験${suffix}`, startsAt: new Date('2098-07-01T15:00:00+09:00') } });
    const prediction = await tx.prediction.create({ data: { raceId: race.id, draft: {}, revision: 1, updatedBy: publisher.user.id } });
    const predictionVersion = await tx.predictionVersion.create({ data: { predictionId: prediction.id, version: 1, status: 'PUBLISHED', visibility: 'PAID', confidence: 'A', stance: null, summary: '会員限定の選定理由', estimatedTotalYen: null, contentSnapshot: { privateHorseNumber: 6 }, assessmentSnapshot: {}, publisherId: publisher.user.id, deadlineAt: race.startsAt, formatVersion: 'HORSE_EVALUATION_V1' } });
    const resultVersion = await tx.raceResultVersion.create({ data: { raceId: race.id, version: 1, sourceRevision: 1, ruleVersion: 'HORSE_EVALUATION_V1', entriesSnapshot: [{ number: 6, horseName: '非公開馬名' }], payoutsSnapshot: [], reason: '公式結果確認', confirmedBy: publisher.user.id } });
    const successful = status === 'PRIMARY_WIN';
    await tx.predictionEvaluation.create({ data: { predictionVersionId: predictionVersion.id, resultVersionId: resultVersion.id, raceId: race.id, primaryFinishedFirst: successful, primaryFinishedTop2: successful, primaryFinishedTop3: successful, winnerInRecommended: successful, status, confirmedBy: publisher.user.id, calculationRuleVersion: 'HORSE_EVALUATION_V1' } });
    const event = await tx.notificationEvent.create({ data: { raceResultVersionId: resultVersion.id, eventType: 'RACE_EVALUATION_CONFIRMED', status: 'QUEUED', payload: { raceResultVersionId: resultVersion.id, raceId: race.id } } });
    return { race, resultVersion, event };
  });
}
async function recipient(subject = `test:sent:${randomUUID()}`, entitled = false) {
  const member = await account();
  await db.lineAccount.create({ data: { userId: member.user.id, subject } });
  if (entitled) await db.entitlement.create({ data: { userId: member.user.id, planCode: 'MANUAL', startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2099-01-01T00:00:00Z'), reason: '通知権限試験', grantedBy: member.user.id } });
  return member.user;
}
async function processFirstAttempt(eventId: string, userId: string, transport: NotificationTransport, limit = 200) {
  for (let index = 0; index < 20; index += 1) {
    const delivery = await db.notificationDelivery.findFirst({ where: { eventId, userId, channel: 'LINE' } });
    if (delivery?.attemptCount) return delivery;
    if (delivery?.status === 'QUEUED') await db.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
    await runNotificationBatch({ db, transport, limit, eventId });
  }
  throw new Error(`Target notification delivery was not attempted for event ${eventId}`);
}
async function processFirstEmailAttempt(eventId: string, userId: string, transport: NotificationTransport, limit = 200) {
  for (let index = 0; index < 20; index += 1) {
    const delivery = await db.notificationDelivery.findFirst({ where: { eventId, userId, channel: 'EMAIL' } });
    if (delivery?.attemptCount) return delivery;
    if (delivery?.status === 'QUEUED') await db.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
    await runEmailNotificationBatch({ db, transport, limit, eventId });
  }
  throw new Error(`Target email delivery was not attempted for event ${eventId}`);
}

describe('notification worker and administration', () => {
  it('sends a billing notice only to the affected member without provider secrets', async () => {
    const subject = `test:billing-target:${randomUUID()}`; const member = await recipient(subject); const unrelated = await recipient();
    const target = await db.$transaction(async tx => {
      const pass = await tx.dayPass.create({ data: { userId: member.id, raceDate: '2098-05-31', status: 'PENDING', priceYen: 980, startsAt: null, endsAt: new Date('2098-05-31T15:00:00Z'), provider: 'STRIPE', source: 'PURCHASE', providerPassId: `cs_secret_${randomUUID()}`, entitlementId: null } });
      const billingEvent = await tx.billingEvent.create({ data: { userId: member.id, eventType: 'DAY_PASS_PENDING', dayPassId: pass.id, actorId: member.id, details: { providerPaymentId: 'pi_secret_value', amountYen: 980 } } });
      const event = await tx.notificationEvent.create({ data: { billingEventId: billingEvent.id, eventType: 'BILLING_PAYMENT_SUCCEEDED', status: 'QUEUED', payload: { billingEventId: billingEvent.id } } });
      return { billingEvent, event };
    });
    const messages: string[] = [];
    const transport: NotificationTransport = { async send(input) { if (input.recipient === subject) messages.push(input.message.text); return { kind: 'SENT', providerMessageId: `billing-${input.retryKey}` }; } };
    expect(await processFirstAttempt(target.event.id, member.id, transport)).toMatchObject({ status: 'SENT', channel: 'LINE' });
    expect(messages).toHaveLength(1); expect(messages[0]).toContain('お支払いを確認しました'); expect(messages[0]).toContain('1日利用'); expect(messages[0]).toContain('/account');
    expect(messages[0]).not.toMatch(/pi_secret|cs_secret|980|provider/i);
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: unrelated.id } })).toBe(0);
  });

  it('sends a verified horse-evaluation result fact to free members on LINE and email', async () => {
    const subject = `test:result-target:${randomUUID()}`;
    const member = await recipient(subject);
    const target = await raceEvaluationResult();
    await db.$transaction([
      db.notificationEvent.update({ where: { id: target.event.id }, data: { expandedAt: new Date(), emailExpandedAt: new Date() } }),
      db.notificationDelivery.create({ data: { eventId: target.event.id, userId: member.id, channel: 'LINE', idempotencyKey: `result-line:${randomUUID()}`, nextAttemptAt: new Date(0) } }),
      db.notificationDelivery.create({ data: { eventId: target.event.id, userId: member.id, channel: 'EMAIL', idempotencyKey: `result-email:${randomUUID()}`, nextAttemptAt: new Date(0) } })
    ]);
    const sent: Array<{ recipient: string; targetId: string; text: string }> = [];
    const transport: NotificationTransport = { async send(input) { if ([subject, member.email].includes(input.recipient)) sent.push({ recipient: input.recipient, targetId: input.targetId, text: input.message.text }); return { kind: 'SENT', providerMessageId: `result-${input.retryKey}` }; } };
    expect(await processFirstAttempt(target.event.id, member.id, transport, 1)).toMatchObject({ channel: 'LINE', status: 'SENT' });
    expect(await processFirstEmailAttempt(target.event.id, member.id, transport, 1)).toMatchObject({ channel: 'EMAIL', status: 'SENT' });
    const targetMessages = sent.filter(item => item.targetId === target.resultVersion.id);
    expect(targetMessages).toHaveLength(2);
    expect(targetMessages.every(item => item.text.includes('パドック直前予想の評価結果') && item.text.includes('本命馬が1着') && item.text.includes(`/races/${target.race.id}`))).toBe(true);
    expect(targetMessages.map(item => item.text).join('\n')).not.toMatch(/非公開馬名|privateHorseNumber|会員限定の選定理由|馬番|買い目|組み合わせ|購入|払戻|回収率|収支|利益|的中/);
  }, 120000);

  it('refuses a result notification when the latest evaluation still requires review', async () => {
    await expect(raceEvaluationResult('REVIEW_REQUIRED')).rejects.toThrow(/requires a confirmed evaluation/);
  });

  it('sends a metadata-only WIN5 notice to free members on LINE and email', async () => {
    const target = await win5Publication();
    const subject = `test:win5-target:${randomUUID()}`;
    const member = await recipient(subject);
    const sent: Array<{ recipient: string; targetId: string; text: string }> = [];
    const transport: NotificationTransport = { async send(input) { if ([subject, member.email].includes(input.recipient)) sent.push({ recipient: input.recipient, targetId: input.targetId, text: input.message.text }); return { kind: 'SENT', providerMessageId: `win5-${input.retryKey}` }; } };
    expect(await processFirstAttempt(target.event.id, member.id, transport)).toMatchObject({ channel: 'LINE', status: 'SENT' });
    expect(await processFirstEmailAttempt(target.event.id, member.id, transport)).toMatchObject({ channel: 'EMAIL', status: 'SENT' });
    const targetMessages = sent.filter(item => item.targetId === target.version.id);
    expect(targetMessages).toHaveLength(2);
    expect(targetMessages.every(item => item.text.includes('WIN5紙面予想を公開しました') && item.text.includes(target.product.title) && item.text.includes(`/win5/${target.product.id}`))).toBe(true);
    expect(targetMessages.map(item => item.text).join('\n')).not.toMatch(/通知へ出してはいけない選択馬|中心馬|馬番|買い目|円/);
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const listed = await admin.call(`admin/notifications?raceId=${target.firstRaceId}&limit=50`);
    expect(listed.status).toBe(200);
    expect(listed.body.items.some((item: { event: { productVersion: { id: string; product: { title: string } } | null } }) => item.event.productVersion?.id === target.version.id && item.event.productVersion.product.title === target.product.title)).toBe(true);
  }, 120000);

  it('sends safe publication email only to verified members who opted in', async () => {
    const target = await publication('FREE');
    const enabled = await account();
    const optedOut = await account();
    const unverified = await account();
    await db.notificationPreference.update({ where: { userId: optedOut.user.id }, data: { emailEnabled: false } });
    await db.user.update({ where: { id: unverified.user.id }, data: { emailVerifiedAt: null } });
    const sent: { recipient: string; text: string }[] = [];
    const transport: NotificationTransport = { async send(input) { sent.push({ recipient: input.recipient, text: input.message.text }); return { kind: 'SENT', providerMessageId: `email-${input.retryKey}` }; } };
    const delivery = await processFirstEmailAttempt(target.event.id, enabled.user.id, transport);
    expect(delivery).toMatchObject({ channel: 'EMAIL', status: 'SENT', attemptCount: 1 });
    expect(sent.some(item => item.recipient === enabled.user.email && item.text.includes(target.race.name))).toBe(true);
    expect(sent.find(item => item.recipient === enabled.user.email)?.text).not.toMatch(/買い目|本命|円/);
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: { in: [optedOut.user.id, unverified.user.id] }, channel: 'EMAIL' } })).toBe(0);
    expect(await db.notificationEvent.findUniqueOrThrow({ where: { id: target.event.id } })).toMatchObject({ emailExpandedAt: expect.any(Date) });
  });

  it('keeps email and LINE delivery expansion independent', async () => {
    const target = await publication('FREE'); const member = await recipient();
    await runNotificationBatch({ db, transport: new TestNotificationTransport(), limit: 200 });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: member.id, channel: 'LINE' } })).toBe(1);
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: member.id, channel: 'EMAIL' } })).toBe(0);
    await runEmailNotificationBatch({ db, transport: new TestNotificationTransport(), limit: 200 });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: member.id, channel: 'EMAIL' } })).toBe(1);
  });

  it('finalizes web-only events without creating delayed LINE deliveries', async () => {
    const target = await publication('FREE');
    const result = await skipPendingNotificationEvents(db, 200);
    expect(result).toMatchObject({ disabled: true, claimedDeliveries: 0, sent: 0 });
    expect(await db.notificationEvent.findUnique({ where: { id: target.event.id } })).toMatchObject({ status: 'SKIPPED', expandedAt: expect.any(Date) });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id } })).toBe(0);
    await runNotificationBatch({ db, transport: new TestNotificationTransport(), limit: 200 });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id } })).toBe(0);
  });

  it('publishes an append-only target-race announcement and sends it to free members', async () => {
    const admin = new Client(); await admin.login(await account('ADMIN')); await admin.mfa();
    const suffix = randomUUID().slice(0, 8);
    const race = await db.race.create({ data: { raceDate: '2098-08-01', venue: `告知${suffix}`, number: 3, name: `スマホ告知試験${suffix}`, startsAt: new Date('2098-08-01T15:00:00+09:00') } });
    const subject = `test:announcement-target:${randomUUID()}`; const member = await recipient(subject); const headers = { 'Idempotency-Key': randomUUID() };
    const first = await admin.call(`admin/races/${race.id}/announce`, 'POST', { reason: '対象レース決定の結合試験' }, undefined, headers);
    const repeated = await admin.call(`admin/races/${race.id}/announce`, 'POST', { reason: '対象レース決定の結合試験' }, undefined, headers);
    expect(first.status).toBe(201); expect(repeated.body).toEqual(first.body);
    expect(await db.raceAnnouncement.count({ where: { raceId: race.id } })).toBe(1);
    const announcement = await db.raceAnnouncement.findUniqueOrThrow({ where: { id: first.body.id } });
    await expect(db.raceAnnouncement.update({ where: { id: announcement.id }, data: { reason: '上書き' } })).rejects.toThrow();
    await expect(db.raceAnnouncement.delete({ where: { id: announcement.id } })).rejects.toThrow();
    const publicList = await new Client().call('announcements');
    expect(publicList.body.items.some((item: { id: string }) => item.id === announcement.id)).toBe(true);
    const messages: string[] = [];
    const event = await db.notificationEvent.findUniqueOrThrow({ where: { announcementId: announcement.id } });
    const transport: NotificationTransport = { async send(input) { if (input.recipient === subject && input.targetId === announcement.id) messages.push(input.message.text); return { kind: 'SENT', providerMessageId: `announcement-${input.retryKey}` }; } };
    expect(await processFirstAttempt(event.id, member.id, transport)).toMatchObject({ status: 'SENT', attemptCount: 1 });
    expect(messages.some(message => message.includes('予想対象レースのお知らせ') && message.includes(race.name))).toBe(true);
  });

  it('keeps the outbox untouched while the emergency stop is active', async () => {
    const target = await publication('FREE');
    await db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: false } });
    const result = await runNotificationBatch({ db, transport: new TestNotificationTransport(), limit: 200 });
    expect(result).toMatchObject({ disabled: true, expandedEvents: 0, claimedDeliveries: 0 });
    expect(await db.notificationEvent.findUnique({ where: { id: target.event.id } })).toMatchObject({ status: 'QUEUED', expandedAt: null });
    await db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: true } });
  });

  it('expands and claims idempotently across concurrent workers', async () => {
    const target = await publication('FREE'); const subject = `test:concurrent-target:${randomUUID()}`; const member = await recipient(subject); let sends = 0; let message = '';
    let retryKey = ''; const transport: NotificationTransport = { async send(input) { if (input.recipient === subject && input.targetId === target.version.id) { sends += 1; message = input.message.text; retryKey = input.retryKey; } return { kind: 'SENT', providerMessageId: `concurrent-${input.retryKey}` }; } };
    await Promise.all([runNotificationBatch({ db, transport, limit: 200 }), runNotificationBatch({ db, transport, limit: 200 })]);
    await processFirstAttempt(target.event.id, member.id, transport);
    const deliveries = await db.notificationDelivery.findMany({ where: { eventId: target.event.id }, include: { attempts: true } });
    expect(deliveries.filter(item => item.userId === member.id && item.channel === 'LINE')).toHaveLength(1);
    expect(deliveries.find(item => item.userId === member.id && item.channel === 'LINE')).toMatchObject({ status: 'SENT', attemptCount: 1 });
    expect(deliveries.find(item => item.userId === member.id && item.channel === 'LINE')?.attempts).toHaveLength(1);
    expect(sends).toBe(1);
    expect(message).toContain('内容は会員ページでご確認ください。');
    expect(message).not.toMatch(/買い目|本命|円/);
    expect(retryKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('filters paid recipients and rechecks preferences immediately before delivery', async () => {
    const target = await publication('PAID'); const entitled = await recipient(undefined, true); const excluded = await recipient();
    expect(await processFirstAttempt(target.event.id, entitled.id, new TestNotificationTransport())).toMatchObject({ status: 'SENT', attemptCount: 1 });
    expect(await db.notificationDelivery.count({ where: { eventId: target.event.id, userId: excluded.id } })).toBe(0);

    const recheck = await publication('FREE');
    await db.notificationEvent.update({ where: { id: recheck.event.id }, data: { expandedAt: new Date() } });
    await db.notificationDelivery.create({ data: { eventId: recheck.event.id, userId: entitled.id, idempotencyKey: `recheck:${randomUUID()}`, nextAttemptAt: new Date(0) } });
    await db.notificationPreference.update({ where: { userId: entitled.id }, data: { predictions: false } });
    expect(await processFirstAttempt(recheck.event.id, entitled.id, new TestNotificationTransport())).toMatchObject({ status: 'SKIPPED', lastErrorCode: 'PREFERENCE_DISABLED' });
  });

  it('records transient failure, schedules a retry, then sends once', async () => {
    const target = await publication('PAID'); const subject = `test:retry-target:${randomUUID()}`; const member = await recipient(subject, true); let attempt = 0;
    const transport: NotificationTransport = { async send(input) { if (input.recipient !== subject) return { kind: 'SENT', providerMessageId: 'unrelated-test' }; attempt += 1; return attempt === 1 ? { kind: 'TRANSIENT_FAILURE', errorCode: 'TEMPORARY_TEST' } : { kind: 'SENT', providerMessageId: 'recovered-test' }; } };
    const delivery = await processFirstAttempt(target.event.id, member.id, transport);
    expect(delivery).toMatchObject({ status: 'QUEUED', attemptCount: 1, lastErrorCode: 'TEMPORARY_TEST' });
    await db.notificationDelivery.update({ where: { id: delivery.id }, data: { nextAttemptAt: new Date(0) } });
    await runNotificationBatch({ db, transport, limit: 200 });
    expect(await db.notificationDelivery.findUnique({ where: { id: delivery.id } })).toMatchObject({ status: 'SENT', attemptCount: 2, lastErrorCode: null });
    expect(await db.notificationAttempt.count({ where: { deliveryId: delivery.id } })).toBe(2);
  });

  it('lets authorized staff requeue failed delivery with an audited reason and protects attempt history', async () => {
    const target = await publication('PAID'); const member = await recipient(undefined, true);
    const delivery = await processFirstAttempt(target.event.id, member.id, { async send() { return { kind: 'PERMANENT_FAILURE', errorCode: 'INVALID_TEST_TARGET' }; } });
    const attempt = await db.notificationAttempt.findFirstOrThrow({ where: { deliveryId: delivery.id } });
    await expect(db.notificationAttempt.update({ where: { id: attempt.id }, data: { errorCode: 'overwrite' } })).rejects.toThrow();
    await expect(db.notificationAttempt.delete({ where: { id: attempt.id } })).rejects.toThrow();

    const admin = new Client(); await admin.login(await account('ADMIN')); expect((await admin.call('admin/notifications')).body.code).toBe('MFA_REQUIRED'); await admin.mfa();
    const listed = await admin.call('admin/notifications?status=FAILED&limit=50'); expect(listed.status).toBe(200); expect(listed.body.total).toBeGreaterThan(0); expect(listed.body.items.every((item: { status: string }) => item.status === 'FAILED')).toBe(true);
    const emailListed = await admin.call('admin/notifications?channel=EMAIL&limit=50'); expect(emailListed.status).toBe(200); expect(emailListed.body.items.every((item: { channel: string }) => item.channel === 'EMAIL')).toBe(true);
    const retried = await admin.call(`admin/notifications/${delivery.id}/retry`, 'POST', { reason: '試験用配送先を修正したため' });
    expect(retried.status).toBe(201); expect(retried.body).toMatchObject({ status: 'QUEUED', manualRetryCount: 1 });
    const retryAudit = await db.auditLog.findFirstOrThrow({ where: { action: 'NOTIFICATION_RETRY_REQUEST', targetId: delivery.id, reason: '試験用配送先を修正したため' }, orderBy: { createdAt: 'desc' } });
    expect(retryAudit.details).toMatchObject({ channel: 'LINE' });

    const expiredTarget = await publication('PAID'); const expiredMember = await recipient(undefined, true); const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.notificationEvent.update({ where: { id: expiredTarget.event.id }, data: { expandedAt: new Date(), status: 'FAILED' } });
    const expired = await db.notificationDelivery.create({ data: { eventId: expiredTarget.event.id, userId: expiredMember.id, idempotencyKey: `expired:${randomUUID()}`, status: 'FAILED', attemptCount: 1, lastErrorCode: 'LINE_TIMEOUT' } });
    await db.notificationAttempt.create({ data: { deliveryId: expired.id, attemptNumber: 1, outcome: 'TRANSIENT_FAILURE', errorCode: 'LINE_TIMEOUT', startedAt: old, finishedAt: old } });
    const rejected = await admin.call(`admin/notifications/${expired.id}/retry`, 'POST', { reason: '24時間経過後の再送確認' });
    expect(rejected.status).toBe(400); expect(rejected.body.code).toBe('NOTIFICATION_RETRY_WINDOW_EXPIRED');
  });
});
