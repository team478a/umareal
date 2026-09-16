import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assessmentFixture } from './assessment-fixtures';
import { account, Client, db } from './helpers';
import type { NotificationTransport } from '../apps/worker/src/notification-runner';
import { runEmailNotificationBatch, runNotificationBatch } from '../apps/worker/src/notification-runner';

afterAll(() => db.$disconnect());

async function makeRace(expertId: string, number: number, targetDate: string) {
  const race = await db.race.create({ data: { raceDate: targetDate, venue: `WIN5-${randomUUID().slice(0, 8)}`, number, name: `WIN5結合試験${number}`, startsAt: new Date(`${targetDate}T${String(number + 5).padStart(2, '0')}:00:00Z`), assignments: { create: { userId: expertId } } } });
  const entries = [];
  for (let horseNumber = 1; horseNumber <= 2; horseNumber++) entries.push(await db.raceEntry.create({ data: { race: { connect: { id: race.id } }, horse: { create: { id: randomUUID(), name: `WIN5試験馬${number}-${horseNumber}` } }, number: horseNumber, gate: horseNumber, horseName: `WIN5試験馬${number}-${horseNumber}`, sex: 'MALE', age: 3, carriedWeight: 57, jockey: '試験騎手', trainer: '試験調教師' } }));
  return { race, entries };
}

async function unusedWin5TargetDate() {
  let day = Math.floor(Date.UTC(2200, 0, 1) / 86400000) + (parseInt(randomUUID().slice(0, 8), 16) % 30000);
  while (true) {
    const targetDate = new Date(day * 86400000).toISOString().slice(0, 10);
    const existing = await db.predictionProduct.findUnique({ where: { type_targetDate: { type: 'WIN5_PREVIEW', targetDate } }, select: { id: true } });
    if (!existing) return targetDate;
    day += 1;
  }
}

describe('WIN5 product drafting and publication', () => {
  it('authorizes assigned editors, calculates five legs, appends corrections and protects versions in PostgreSQL', async () => {
    const expert = await assessmentFixture('EXPERT', 2, 2);
    const admin = await assessmentFixture('ADMIN', 2);
    const aal1 = await assessmentFixture('ADMIN', 1);
    const targetDate = await unusedWin5TargetDate();
    await db.race.update({ where: { id: expert.race.id }, data: { raceDate: targetDate, startsAt: new Date(`${targetDate}T06:00:00Z`) } });
    const races = [{ race: expert.race, entries: expert.entries }];
    for (let number = 2; number <= 5; number++) races.push(await makeRace(expert.owner.user.id, number, targetDate));

    expect((await aal1.client.call('admin/win5')).body.code).toBe('MFA_REQUIRED');
    const scheduledPublishAt = `${targetDate}T05:00:00+09:00`;
    const created = await admin.client.call('admin/win5', 'POST', { type: 'WIN5_PREVIEW', targetDate, title: `WIN5試験-${randomUUID().slice(0, 6)}`, expertId: expert.owner.user.id, scheduledPublishAt, accessScope: 'PAID', confidence: 'A', summary: '', showFreeConfidence: false, reason: 'WIN5結合試験の準備' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    let revision = created.body.revision as number;

    const updated = await admin.client.call(`admin/win5/${created.body.id}`, 'PATCH', { revision, title: created.body.title, expertId: expert.owner.user.id, scheduledPublishAt, accessScope: 'PAID', confidence: 'A', summary: '5レースを通した全体総評', showFreeConfidence: true, reason: '全体総評の入力' });
    expect(updated.status).toBe(200); revision = updated.body.revision;

    const dayMember = await account(); const dayClient = new Client(); await dayClient.login(dayMember);
    await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: true } });
    const dayPurchase = await dayClient.call('billing/day-pass', 'POST', { raceDate: targetDate }, undefined, { 'Idempotency-Key': randomUUID() });
    await db.systemSetting.update({ where: { id: 'global' }, data: { newPurchasesEnabled: false } });
    expect(dayPurchase.status, JSON.stringify(dayPurchase.body)).toBe(201);
    expect(dayPurchase.body.status).toBe('PENDING'); expect(dayPurchase.body.startsAt).toBeNull(); expect(dayPurchase.body.waitingForPublication).toBe(true);
    const pendingPass = await db.dayPass.findUniqueOrThrow({ where: { id: dayPurchase.body.dayPassId } });
    expect(pendingPass.entitlementId).toBeNull();

    for (let index = 0; index < races.length; index++) {
      const item = races[index];
      const saved = await expert.client.call(`expert/win5/${created.body.id}/races/${index + 1}`, 'PUT', { productRevision: revision, raceId: item.race.id, confidence: index === 0 ? 'S' : 'A', paceView: `第${index + 1}レースの展開見解`, shortComment: `第${index + 1}レースの短評`, evaluations: [{ entryId: item.entries[0].id, evaluationType: 'PRIMARY', reason: '中心馬の選定理由', displayOrder: 1 }, { entryId: item.entries[1].id, evaluationType: 'SECONDARY', reason: '相手候補の選定理由', displayOrder: 1 }], reason: '評価馬の結合試験' });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200); revision = saved.body.productRevision;
    }

    const checked = await expert.client.call(`expert/win5/${created.body.id}/preview`, 'POST', { productRevision: revision, correctionReason: '' });
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
    expect(checked.body.combinationCount).toBeUndefined(); expect(checked.body.assumedPurchaseAmountYen).toBeUndefined(); expect(checked.body.content.races[0].evaluations).toHaveLength(2);
    const published = await expert.client.call(`expert/win5/${created.body.id}/publish/${checked.body.previewId}`, 'POST');
    expect(published.status).toBe(201); expect(published.body.version).toBe(1);
    expect((await expert.client.call(`expert/win5/${created.body.id}/publish/${checked.body.previewId}`, 'POST')).body.alreadyPublished).toBe(true);
    const initialEvent = await db.notificationEvent.findUniqueOrThrow({ where: { productVersionId: published.body.versionId } });
    expect(initialEvent).toMatchObject({ eventType: 'WIN5_PREVIEW_PUBLISHED', status: 'QUEUED' });
    expect(JSON.stringify(initialEvent.payload)).not.toMatch(/contentSnapshot|evaluation|horse|amount|summary|reason/i);

    const activePass = await db.dayPass.findUniqueOrThrow({ where: { id: pendingPass.id }, include: { entitlement: true } });
    expect(activePass.status).toBe('ACTIVE'); expect(activePass.startsAt?.toISOString()).toBe(new Date(published.body.publishedAt).toISOString());
    expect(activePass.entitlement?.startsAt.toISOString()).toBe(new Date(published.body.publishedAt).toISOString());
    const paidPaper = await dayClient.call(`win5/${created.body.id}`);
    expect(paidPaper.status).toBe(200); expect(paidPaper.body.access).toBe('FULL'); expect(paidPaper.body.version.contentSnapshot.races).toHaveLength(5);

    const freeMember = await account(); const freeClient = new Client(); await freeClient.login(freeMember);
    const freeLineSubject = `test:win5-result:${randomUUID()}`;
    await db.lineAccount.create({ data: { userId: freeMember.user.id, subject: freeLineSubject } });
    const freePaper = await freeClient.call(`win5/${created.body.id}`);
    expect(freePaper.status).toBe(200); expect(freePaper.body.access).toBe('METADATA'); expect(freePaper.body.locked).toBe(true); expect(freePaper.body.product.confidence).toBe('A');
    const freeJson = JSON.stringify(freePaper.body);
    for (const forbidden of ['contentSnapshot', 'evaluations', 'evaluationType', 'horseName', 'summary', 'amountPerPointYen', 'assumedPurchaseAmountYen', 'correctionReason']) expect(freeJson).not.toContain(forbidden);
    expect(freePaper.body.product.races).toHaveLength(5);

    const monthlyMember = await account(); const monthlyClient = new Client(); await monthlyClient.login(monthlyMember);
    await db.entitlement.create({ data: { userId: monthlyMember.user.id, planCode: 'STANDARD', startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 3600000), reason: 'WIN5_MONTHLY_ACCESS_TEST', grantedBy: monthlyMember.user.id } });
    expect((await monthlyClient.call(`win5/${created.body.id}`)).body.access).toBe('FULL');
    const anonymousList = await new Client().call(`win5?targetDate=${targetDate}`);
    expect(anonymousList.status).toBe(200); expect(JSON.stringify(anonymousList.body)).not.toContain('contentSnapshot');
    expect((await aal1.client.call(`admin/win5/${created.body.id}/result`)).body.code).toBe('MFA_REQUIRED');

    const first = await db.predictionProductVersion.findUniqueOrThrow({ where: { id: published.body.versionId } });
    await expect(db.predictionProductVersion.update({ where: { id: first.id }, data: { confidence: 'C' } })).rejects.toThrow();
    await expect(db.predictionProductVersion.delete({ where: { id: first.id } })).rejects.toThrow();

    const detail = await admin.client.call(`admin/win5/${created.body.id}`); expect(detail.status, JSON.stringify(detail.body)).toBe(200); revision = detail.body.revision;
    const correctionDraft = await admin.client.call(`admin/win5/${created.body.id}`, 'PATCH', { revision, title: detail.body.title, expertId: expert.owner.user.id, scheduledPublishAt, accessScope: 'PAID', confidence: 'B', summary: '訂正版の全体総評', showFreeConfidence: true, reason: '総評を訂正' });
    expect(correctionDraft.status, JSON.stringify(correctionDraft.body)).toBe(200); revision = correctionDraft.body.revision;
    const narrowed = await admin.client.call(`admin/win5/${created.body.id}/races/1`, 'PUT', { productRevision: revision, raceId: races[0].race.id, confidence: 'S', paceView: '訂正版の展開見解', shortComment: '訂正版では中心馬のみ', evaluations: [{ entryId: races[0].entries[0].id, evaluationType: 'PRIMARY', reason: '中心馬の訂正理由', displayOrder: 1 }], reason: '訂正版の評価馬変更' });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200); revision = narrowed.body.productRevision;
    expect((await expert.client.call(`expert/win5/${created.body.id}/preview`, 'POST', { productRevision: revision, correctionReason: '訂正試験' })).body.code).toBe('CORRECTION_APPROVAL_REQUIRED');
    const correctionPreview = await admin.client.call(`admin/win5/${created.body.id}/preview`, 'POST', { productRevision: revision, correctionReason: '全体信頼度と総評を訂正' });
    expect(correctionPreview.status).toBe(201);
    const corrected = await admin.client.call(`admin/win5/${created.body.id}/publish/${correctionPreview.body.previewId}`, 'POST');
    expect(corrected.body.version).toBe(2);
    const correctionEvent = await db.notificationEvent.findUniqueOrThrow({ where: { productVersionId: corrected.body.versionId } });
    expect(correctionEvent).toMatchObject({ eventType: 'WIN5_PREVIEW_CORRECTED', status: 'QUEUED' });
    const versions = await db.predictionProductVersion.findMany({ where: { productId: created.body.id }, orderBy: { version: 'asc' } });
    expect(versions).toHaveLength(2); expect(versions[1].previousVersionId).toBe(versions[0].id); expect(versions[1].correctionReason).toBe('全体信頼度と総評を訂正');
    const correctedPaper = await dayClient.call(`win5/${created.body.id}`); expect(correctedPaper.body.version.version).toBe(2);
    const oldPaper = await dayClient.call(`win5/${created.body.id}?version=1`); expect(oldPaper.body.version.version).toBe(1); expect(oldPaper.body.versions).toHaveLength(2);

    await db.race.update({ where: { id: races[0].race.id }, data: { startsAt: new Date(Date.now() - 1000) } });
    await expect(db.predictionProductVersion.create({ data: { productId: created.body.id, version: 3, status: 'CORRECTED', accessScope: 'PAID', confidence: 'B', combinationCount: null, amountPerPointYen: null, assumedPurchaseAmountYen: null, formatVersion: 'HORSE_EVALUATION_V1', contentSnapshot: {}, publisherId: admin.owner.user.id, deadlineAt: new Date(Date.now() + 3600000), correctionReason: 'DB締切保護試験', previousVersionId: versions[1].id } })).rejects.toThrow();
    expect(versions[0].formatVersion).toBe('HORSE_EVALUATION_V1'); expect(versions[0].combinationCount).toBeNull(); expect(versions[0].assumedPurchaseAmountYen).toBeNull();
    for (const item of races) {
      await db.race.update({ where: { id: item.race.id }, data: { startsAt: new Date(Date.now() - 1000), status: 'FINISHED' } });
      await db.raceResultVersion.create({ data: { raceId: item.race.id, version: 1, sourceRevision: 1, ruleVersion: 'HORSE_EVALUATION_V1', raceCanceled: false, entriesSnapshot: item.entries.map((entry, index) => ({ entryId: entry.id, status: 'FINISHED', finishPosition: index + 1, popularity: index + 1, finalOdds: `${index + 2}.0` })), payoutsSnapshot: [], reason: 'WIN5評価結果試験', confirmedBy: admin.owner.user.id } });
    }
    const imported = await admin.client.call(`admin/win5/${created.body.id}/results/import`, 'POST', { revision: 0, reason: '5レースの評価結果を取込' });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201); expect(imported.body.summary).toMatchObject({ status: 'WIN5_ALL_WINNERS_RECOMMENDED', recommendedLegs: 5, allWinnersRecommended: true });
    expect(JSON.stringify(imported.body)).not.toMatch(/officialPayout|purchase|recoveryRate|combinationCount/);
    const confirmedEvaluation = await admin.client.call(`admin/win5/${created.body.id}/results/confirm`, 'POST', { revision: imported.body.revision, reason: 'WIN5評価結果を確定' });
    expect(confirmedEvaluation.status).toBe(201); expect(confirmedEvaluation.body).toMatchObject({ status: 'WIN5_ALL_WINNERS_RECOMMENDED', recommendedLegs: 5, allWinnersRecommended: true });
    const resultEvent = await db.notificationEvent.findUniqueOrThrow({ where: { win5EvaluationVersionId: confirmedEvaluation.body.versionId } });
    expect(resultEvent).toMatchObject({ eventType: 'WIN5_EVALUATION_CONFIRMED', status: 'QUEUED' }); expect(JSON.stringify(resultEvent.payload)).not.toMatch(/horse|entry|selection|reason|amount|payout|return|recovery/i);
    const notificationSettings = await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineNotificationsEnabled: true, emailNotificationsEnabled: true, lineChannelId: true, lineChannelSecretEncrypted: true, lineAccessTokenEncrypted: true } });
    const resultMessages: Array<{ recipient: string; targetId: string; text: string }> = [];
    const resultTransport: NotificationTransport = { async send(input) { if ([freeLineSubject, freeMember.user.email].includes(input.recipient)) resultMessages.push({ recipient: input.recipient, targetId: input.targetId, text: input.message.text }); return { kind: 'SENT', providerMessageId: `win5-result-${input.retryKey}` }; } };
    try {
      await db.systemSetting.update({ where: { id: 'global' }, data: { lineNotificationsEnabled: true, emailNotificationsEnabled: true, lineChannelId: 'win5-test', lineChannelSecretEncrypted: 'test-encrypted', lineAccessTokenEncrypted: 'test-encrypted' } });
      await db.$transaction([
        db.notificationEvent.updateMany({ where: { id: { in: [initialEvent.id, correctionEvent.id, resultEvent.id] } }, data: { expandedAt: new Date(), emailExpandedAt: new Date() } }),
        db.notificationDelivery.create({ data: { eventId: resultEvent.id, userId: freeMember.user.id, channel: 'LINE', idempotencyKey: `win5-result-line:${randomUUID()}`, nextAttemptAt: new Date('0001-01-01T00:00:00Z') } }),
        db.notificationDelivery.create({ data: { eventId: resultEvent.id, userId: freeMember.user.id, channel: 'EMAIL', idempotencyKey: `win5-result-email:${randomUUID()}`, nextAttemptAt: new Date('0001-01-01T00:00:00Z') } })
      ]);
      await runNotificationBatch({ db, transport: resultTransport, limit: 1 });
      await runEmailNotificationBatch({ db, transport: resultTransport, limit: 1 });
    } finally {
      await db.systemSetting.update({ where: { id: 'global' }, data: notificationSettings });
    }
    const deliveredResult = await db.notificationDelivery.findMany({ where: { eventId: resultEvent.id, userId: freeMember.user.id }, select: { channel: true, status: true } });
    expect(deliveredResult).toEqual(expect.arrayContaining([{ channel: 'LINE', status: 'SENT' }, { channel: 'EMAIL', status: 'SENT' }]));
    const matchingResultMessages = resultMessages.filter(item => item.targetId === confirmedEvaluation.body.versionId);
    expect(matchingResultMessages).toHaveLength(2);
    expect(matchingResultMessages.every(item => item.text.includes('WIN5紙面予想の評価結果') && item.text.includes('対象5レースすべてで勝ち馬を候補内に選出') && item.text.includes(`/win5/${created.body.id}`))).toBe(true);
    expect(matchingResultMessages.map(item => item.text).join('\n')).not.toMatch(/WIN5試験馬|中心馬の選定理由|馬番|買い目|組み合わせ|購入|払戻|回収率|収支|利益|的中/);
    const storedEvaluation = await db.win5EvaluationVersion.findUniqueOrThrow({ where: { id: confirmedEvaluation.body.versionId }, include: { legs: true } });
    expect(storedEvaluation.legs).toHaveLength(5); expect(storedEvaluation.legs.every(leg => leg.winnerInRecommended)).toBe(true);
    await expect(db.win5EvaluationVersion.update({ where: { id: storedEvaluation.id }, data: { status: 'WIN5_MISSED' } })).rejects.toThrow();
    const shares = await admin.client.call('admin/social-shares'); expect(shares.status).toBe(200);
    const win5Share = shares.body.items.find((item: { path: string }) => item.path === `/win5/${created.body.id}`);
    expect(win5Share).toMatchObject({ kind: 'WIN5', status: 'WIN5_ALL_WINNERS_RECOMMENDED', shareable: true, headline: 'WIN5対象5レース 勝ち馬をすべて候補内に選出' });
    expect(JSON.stringify(win5Share)).not.toMatch(/買い目|組み合わせ|購入|払戻|回収率|収支|利益|的中/);
    const memberNotices = await freeClient.call('me/notifications');
    expect(memberNotices.body.items.some((item: { eventType: string; href: string }) => item.eventType === 'WIN5_EVALUATION_CONFIRMED' && item.href === `/win5/${created.body.id}`)).toBe(true);
    const performance = await new Client().call('win5/performance'); expect(performance.status).toBe(200); expect(performance.body.overall.allWinnersRecommended).toBeGreaterThanOrEqual(1);
  });
});
