import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assessmentFixture } from './assessment-fixtures';
import { db } from './helpers';

afterAll(() => db.$disconnect());

async function makeRace(expertId: string, number: number, targetDate: string) {
  const race = await db.race.create({ data: { raceDate: targetDate, venue: `WIN5-${randomUUID().slice(0, 8)}`, number, name: `WIN5結合試験${number}`, startsAt: new Date(`${targetDate}T${String(number + 5).padStart(2, '0')}:00:00Z`), assignments: { create: { userId: expertId } } } });
  const entries = [];
  for (let horseNumber = 1; horseNumber <= 2; horseNumber++) entries.push(await db.raceEntry.create({ data: { race: { connect: { id: race.id } }, horse: { create: { id: randomUUID(), name: `WIN5試験馬${number}-${horseNumber}` } }, number: horseNumber, gate: horseNumber, horseName: `WIN5試験馬${number}-${horseNumber}`, sex: 'MALE', age: 3, carriedWeight: 57, jockey: '試験騎手', trainer: '試験調教師' } }));
  return { race, entries };
}

describe('WIN5 product drafting and publication', () => {
  it('authorizes assigned editors, calculates five legs, appends corrections and protects versions in PostgreSQL', async () => {
    const expert = await assessmentFixture('EXPERT', 2, 2);
    const admin = await assessmentFixture('ADMIN', 2);
    const aal1 = await assessmentFixture('ADMIN', 1);
    const targetDate = new Date(Date.UTC(2090, 0, 1) + (parseInt(randomUUID().slice(0, 6), 16) % 3650) * 86400000).toISOString().slice(0, 10);
    await db.race.update({ where: { id: expert.race.id }, data: { raceDate: targetDate, startsAt: new Date(`${targetDate}T06:00:00Z`) } });
    const races = [{ race: expert.race, entries: expert.entries }];
    for (let number = 2; number <= 5; number++) races.push(await makeRace(expert.owner.user.id, number, targetDate));

    expect((await aal1.client.call('admin/win5')).body.code).toBe('MFA_REQUIRED');
    const scheduledPublishAt = `${targetDate}T05:00:00+09:00`;
    const created = await admin.client.call('admin/win5', 'POST', { type: 'WIN5_PREVIEW', targetDate, title: `WIN5試験-${randomUUID().slice(0, 6)}`, expertId: expert.owner.user.id, scheduledPublishAt, accessScope: 'PAID', confidence: 'A', summary: '', showFreeConfidence: false, reason: 'WIN5結合試験の準備' }, undefined, { 'Idempotency-Key': randomUUID() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    let revision = created.body.revision as number;

    const updated = await admin.client.call(`admin/win5/${created.body.id}`, 'PATCH', { revision, title: created.body.title, expertId: expert.owner.user.id, scheduledPublishAt, accessScope: 'PAID', confidence: 'A', summary: '5レースを通した全体総評', showFreeConfidence: true, amountPerPointYen: 100, reason: '全体総評の入力' });
    expect(updated.status).toBe(200); revision = updated.body.revision;

    for (let index = 0; index < races.length; index++) {
      const item = races[index];
      const saved = await expert.client.call(`expert/win5/${created.body.id}/races/${index + 1}`, 'PUT', { productRevision: revision, raceId: item.race.id, confidence: index === 0 ? 'S' : 'A', strategyType: index === 0 ? 'NARROW' : 'NORMAL', comment: `第${index + 1}レースの選択根拠`, selectionEntryIds: item.entries.map(entry => entry.id), centerEntryId: item.entries[0].id, reason: '選択馬の結合試験' });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200); revision = saved.body.productRevision;
    }

    const checked = await expert.client.call(`expert/win5/${created.body.id}/preview`, 'POST', { productRevision: revision, correctionReason: '' });
    expect(checked.status, JSON.stringify(checked.body)).toBe(201);
    expect(checked.body.combinationCount).toBe(32); expect(checked.body.assumedPurchaseAmountYen).toBe(3200);
    const published = await expert.client.call(`expert/win5/${created.body.id}/publish/${checked.body.previewId}`, 'POST');
    expect(published.status).toBe(201); expect(published.body.version).toBe(1);
    expect((await expert.client.call(`expert/win5/${created.body.id}/publish/${checked.body.previewId}`, 'POST')).body.alreadyPublished).toBe(true);

    const first = await db.predictionProductVersion.findUniqueOrThrow({ where: { id: published.body.versionId } });
    await expect(db.predictionProductVersion.update({ where: { id: first.id }, data: { confidence: 'C' } })).rejects.toThrow();
    await expect(db.predictionProductVersion.delete({ where: { id: first.id } })).rejects.toThrow();

    const detail = await admin.client.call(`admin/win5/${created.body.id}`); expect(detail.status, JSON.stringify(detail.body)).toBe(200); revision = detail.body.revision;
    const correctionDraft = await admin.client.call(`admin/win5/${created.body.id}`, 'PATCH', { revision, title: detail.body.title, expertId: expert.owner.user.id, scheduledPublishAt, accessScope: 'PAID', confidence: 'B', summary: '訂正版の全体総評', showFreeConfidence: true, amountPerPointYen: 100, reason: '総評を訂正' });
    expect(correctionDraft.status, JSON.stringify(correctionDraft.body)).toBe(200); revision = correctionDraft.body.revision;
    expect((await expert.client.call(`expert/win5/${created.body.id}/preview`, 'POST', { productRevision: revision, correctionReason: '訂正試験' })).body.code).toBe('CORRECTION_APPROVAL_REQUIRED');
    const correctionPreview = await admin.client.call(`admin/win5/${created.body.id}/preview`, 'POST', { productRevision: revision, correctionReason: '全体信頼度と総評を訂正' });
    expect(correctionPreview.status).toBe(201);
    const corrected = await admin.client.call(`admin/win5/${created.body.id}/publish/${correctionPreview.body.previewId}`, 'POST');
    expect(corrected.body.version).toBe(2);
    const versions = await db.predictionProductVersion.findMany({ where: { productId: created.body.id }, orderBy: { version: 'asc' } });
    expect(versions).toHaveLength(2); expect(versions[1].previousVersionId).toBe(versions[0].id); expect(versions[1].correctionReason).toBe('全体信頼度と総評を訂正');

    await db.race.update({ where: { id: races[0].race.id }, data: { startsAt: new Date(Date.now() - 1000) } });
    await expect(db.predictionProductVersion.create({ data: { productId: created.body.id, version: 3, status: 'CORRECTED', accessScope: 'PAID', confidence: 'B', combinationCount: 32, amountPerPointYen: 100, assumedPurchaseAmountYen: 3200, contentSnapshot: {}, publisherId: admin.owner.user.id, deadlineAt: new Date(Date.now() + 3600000), correctionReason: 'DB締切保護試験', previousVersionId: versions[1].id } })).rejects.toThrow();
  });
});
