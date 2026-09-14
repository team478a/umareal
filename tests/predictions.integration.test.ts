import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { emptyPredictionDraft } from '../packages/domain/src';
import type { PredictionDraft } from '../packages/domain/src';
import { assessmentFixture } from './assessment-fixtures';
import { Client, db } from './helpers';
afterAll(() => db.$disconnect());
const draftFor = (entryId: string, visibility: 'FREE' | 'PAID' = 'FREE'): PredictionDraft => ({ ...emptyPredictionDraft, visibility, confidence: 'A', stance: 'NORMAL', summary: '結合試験の最終予想', marks: [{ entryId, mark: 'HONMEI', reason: '総合評価' }], bets: [{ type: 'EXACTA', combinations: [[1, 2]], amountPerPointYen: 500 }] });
async function save(fixture: Awaited<ReturnType<typeof assessmentFixture>>, draft = draftFor(fixture.entries[0].id), revision = 0, mutationId = randomUUID()) {
  const body = { draft, revision, raceRevision: fixture.race.revision, mutationId, reason: '最終予想の保存試験' };
  return { body, result: await fixture.client.call(`expert/races/${fixture.race.id}/prediction/draft`, 'POST', body) };
}
async function preview(fixture: Awaited<ReturnType<typeof assessmentFixture>>, predictionRevision: number, correctionReason = '', client = fixture.client) {
  return client.call(`expert/races/${fixture.race.id}/prediction/preview`, 'POST', { predictionRevision, raceRevision: fixture.race.revision, correctionReason });
}
describe('prediction drafts, publication and immutable versions', () => {
  it('authorizes drafts, makes retries idempotent and detects concurrent edits', async () => {
    const fixture = await assessmentFixture(); const member = await assessmentFixture('MEMBER');
    expect((await member.client.call(`expert/races/${fixture.race.id}/prediction`)).status).toBe(403);
    expect((await member.client.call(`expert/races/${fixture.race.id}/prediction/draft`, 'POST', { ...(await save(fixture)).body, role: 'EXPERT' })).status).toBe(400);
    const mutationId = randomUUID(); const first = await save(fixture, undefined, 1, mutationId);
    // The helper call used above created revision 1; this call creates revision 2.
    expect(first.result.status).toBe(201); expect(first.result.body.revision).toBe(2);
    expect((await fixture.client.call(`expert/races/${fixture.race.id}/prediction/draft`, 'POST', first.body)).body.revision).toBe(2);
    expect((await fixture.client.call(`expert/races/${fixture.race.id}/prediction/draft`, 'POST', { ...first.body, draft: { ...first.body.draft, summary: 'changed' } })).status).toBe(409);
    const outcomes = await Promise.all([save(fixture, { ...first.body.draft, summary: '端末A' }, 2), save(fixture, { ...first.body.draft, summary: '端末B' }, 2)]);
    expect(outcomes.map(result => result.result.status).sort()).toEqual([201, 409]);
  });
  it('previews without mutation, publishes atomically, queues an event and exposes free history', async () => {
    const fixture = await assessmentFixture(); const saved = await save(fixture); expect(saved.result.status).toBe(201);
    const checked = await preview(fixture, 1); expect(checked.status).toBe(201); expect(checked.body.totalYen).toBe(500); expect(checked.body.points).toBe(1);
    expect(await db.predictionVersion.count({ where: { predictionId: saved.result.body.id } })).toBe(0);
    const path = `expert/races/${fixture.race.id}/prediction/publish/${checked.body.previewId}`;
    const published = await fixture.client.call(path, 'POST'); expect(published.status).toBe(201); expect(published.body.version).toBe(1);
    expect((await fixture.client.call(path, 'POST')).body.alreadyPublished).toBe(true);
    const version = await db.predictionVersion.findUniqueOrThrow({ where: { id: published.body.versionId }, include: { marks: true, bets: true, notificationEvent: true } });
    expect(version.marks).toHaveLength(1); expect(version.bets[0].totalYen).toBe(500); expect(version.notificationEvent?.status).toBe('QUEUED');
    const publicResult = await new Client().call(`races/${fixture.race.id}/prediction`); expect(publicResult.body.locked).toBe(false); expect(publicResult.body.latest.summary).toBe('結合試験の最終予想');
    await expect(db.predictionVersion.update({ where: { id: version.id }, data: { summary: 'rewrite' } })).rejects.toThrow();
    await expect(db.predictionVersion.delete({ where: { id: version.id } })).rejects.toThrow();
    await expect(db.predictionMark.create({ data: { versionId: version.id, entryId: randomUUID(), horseId: randomUUID(), horseNumber: 3, horseName: '後付け', mark: 'ANA', reason: '' } })).rejects.toThrow();
    await expect(db.predictionMark.update({ where: { id: version.marks[0].id }, data: { horseName: 'rewrite' } })).rejects.toThrow();
    await expect(db.predictionMark.delete({ where: { id: version.marks[0].id } })).rejects.toThrow();
    await expect(db.predictionBet.delete({ where: { id: version.bets[0].id } })).rejects.toThrow();
  });
  it('requires the configured correction approver and preserves every prior version', async () => {
    const fixture = await assessmentFixture(); const first = await save(fixture); const firstPreview = await preview(fixture, 1); await fixture.client.call(`expert/races/${fixture.race.id}/prediction/publish/${firstPreview.body.previewId}`, 'POST');
    const changed = await save(fixture, { ...draftFor(fixture.entries[0].id), summary: '訂正版の総評' }, 1); expect(changed.result.body.revision).toBe(2);
    expect((await preview(fixture, 2, '訂正理由')).body.code).toBe('CORRECTION_APPROVAL_REQUIRED');
    const admin = await assessmentFixture('ADMIN'); const adminPreview = await preview(fixture, 2, '騎手表記の訂正', admin.client); expect(adminPreview.status).toBe(201);
    const corrected = await admin.client.call(`expert/races/${fixture.race.id}/prediction/publish/${adminPreview.body.previewId}`, 'POST'); expect(corrected.body.version).toBe(2);
    const versions = await db.predictionVersion.findMany({ where: { predictionId: first.result.body.id }, orderBy: { version: 'asc' } });
    expect(versions).toHaveLength(2); expect(versions[0].status).toBe('PUBLISHED'); expect(versions[1].status).toBe('CORRECTED'); expect(versions[1].previousVersionId).toBe(versions[0].id); expect(versions[1].correctionReason).toBe('騎手表記の訂正');
    expect((await new Client().call(`races/${fixture.race.id}/prediction`)).body.versions).toHaveLength(2);
  });
  it('redacts paid content without entitlement and returns it only inside the active period', async () => {
    const fixture = await assessmentFixture(); const saved = await save(fixture, draftFor(fixture.entries[0].id, 'PAID')); const checked = await preview(fixture, saved.result.body.revision); await fixture.client.call(`expert/races/${fixture.race.id}/prediction/publish/${checked.body.previewId}`, 'POST');
    const anonymous = await new Client().call(`races/${fixture.race.id}/prediction`); expect(anonymous.body.locked).toBe(true); expect(anonymous.body.latest.summary).toBeUndefined(); expect(anonymous.body.latest.marks).toBeUndefined();
    const member = await assessmentFixture('MEMBER'); const now = new Date(); await db.entitlement.create({ data: { userId: member.owner.user.id, planCode: 'TEST', startsAt: new Date(now.getTime() - 1000), endsAt: new Date(now.getTime() + 3600000), raceDate: fixture.race.raceDate, reason: '閲覧結合試験', grantedBy: member.owner.user.id } });
    const allowed = await member.client.call(`races/${fixture.race.id}/prediction`); expect(allowed.body.locked).toBe(false); expect(allowed.body.latest.summary).toBe('結合試験の最終予想');
  });
  it('authorizes each historical version independently when visibility changes', async () => {
    const paidFirst = await assessmentFixture();
    const paidDraft = await save(paidFirst, draftFor(paidFirst.entries[0].id, 'PAID')); const paidPreview = await preview(paidFirst, paidDraft.result.body.revision); await paidFirst.client.call(`expert/races/${paidFirst.race.id}/prediction/publish/${paidPreview.body.previewId}`, 'POST');
    const freeDraft = await save(paidFirst, { ...draftFor(paidFirst.entries[0].id, 'FREE'), summary: '無料へ訂正' }, 1); const admin = await assessmentFixture('ADMIN'); const freePreview = await preview(paidFirst, freeDraft.result.body.revision, '公開範囲を訂正', admin.client); await admin.client.call(`expert/races/${paidFirst.race.id}/prediction/publish/${freePreview.body.previewId}`, 'POST');
    const anonymousPaidFirst = await new Client().call(`races/${paidFirst.race.id}/prediction`);
    expect(anonymousPaidFirst.body.latest.summary).toBe('無料へ訂正'); expect(anonymousPaidFirst.body.versions[0].locked).toBe(false); expect(anonymousPaidFirst.body.versions[1].locked).toBe(true); expect(anonymousPaidFirst.body.versions[1].summary).toBeUndefined(); expect(anonymousPaidFirst.body.versions[1].correctionReason).toBeUndefined();

    const freeFirst = await assessmentFixture();
    const initial = await save(freeFirst, draftFor(freeFirst.entries[0].id, 'FREE')); const initialPreview = await preview(freeFirst, initial.result.body.revision); await freeFirst.client.call(`expert/races/${freeFirst.race.id}/prediction/publish/${initialPreview.body.previewId}`, 'POST');
    const paidCorrection = await save(freeFirst, { ...draftFor(freeFirst.entries[0].id, 'PAID'), summary: '有料へ訂正' }, 1); const adminPreview = await preview(freeFirst, paidCorrection.result.body.revision, '公開範囲を訂正', admin.client); await admin.client.call(`expert/races/${freeFirst.race.id}/prediction/publish/${adminPreview.body.previewId}`, 'POST');
    const anonymousFreeFirst = await new Client().call(`races/${freeFirst.race.id}/prediction`);
    expect(anonymousFreeFirst.body.latest.locked).toBe(true); expect(anonymousFreeFirst.body.latest.summary).toBeUndefined(); expect(anonymousFreeFirst.body.versions[0].locked).toBe(true); expect(anonymousFreeFirst.body.versions[1].locked).toBe(false); expect(anonymousFreeFirst.body.versions[1].summary).toBe('結合試験の最終予想');
  });
  it('rejects stale previews and enforces the deadline inside PostgreSQL', async () => {
    const fixture = await assessmentFixture(); const saved = await save(fixture); const checked = await preview(fixture, saved.result.body.revision);
    await db.race.update({ where: { id: fixture.race.id }, data: { weather: '変更', revision: { increment: 1 } } });
    expect((await fixture.client.call(`expert/races/${fixture.race.id}/prediction/publish/${checked.body.previewId}`, 'POST')).body.code).toBe('STALE_PREVIEW');
    const late = await assessmentFixture(); await db.race.update({ where: { id: late.race.id }, data: { startsAt: new Date(Date.now() - 1000) } });
    const prediction = await db.prediction.create({ data: { raceId: late.race.id, draft: draftFor(late.entries[0].id), revision: 1, updatedBy: late.owner.user.id } });
    expect((await preview(late, 1)).body.code).toBe('PUBLICATION_CLOSED');
    await expect(db.predictionVersion.create({ data: { predictionId: prediction.id, version: 1, status: 'PUBLISHED', visibility: 'FREE', confidence: 'A', stance: 'NORMAL', summary: 'deadline bypass', estimatedTotalYen: 0, contentSnapshot: {}, assessmentSnapshot: [], publisherId: late.owner.user.id, deadlineAt: new Date(Date.now() + 3600000) } })).rejects.toThrow();
    const delayed = await assessmentFixture(); const delayedSaved = await save(delayed); await db.race.update({ where: { id: delayed.race.id }, data: { status: 'DELAYED' } });
    expect((await preview(delayed, delayedSaved.result.body.revision)).body.code).toBe('DELAYED_PUBLICATION_CLOSED');
  });
});
