import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { emptyPredictionDraft } from '../packages/domain/src';
import { assessmentFixture } from './assessment-fixtures';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());
async function publishedRace() {
  const fixture = await assessmentFixture('ADMIN', 2, 2);
  const draft = { ...emptyPredictionDraft, visibility: 'FREE' as const, confidence: 'A' as const, stance: 'BET' as const, summary: '結果集計試験', marks: [{ entryId: fixture.entries[0].id, mark: 'HONMEI' as const, reason: '軸' }], bets: [{ type: 'EXACTA' as const, combinations: [[1, 2]], amountPerPointYen: 500 }] };
  const saved = await fixture.client.call(`expert/races/${fixture.race.id}/prediction/draft`, 'POST', { draft, revision: 0, raceRevision: fixture.race.revision, mutationId: randomUUID(), reason: '結果試験予想' });
  const preview = await fixture.client.call(`expert/races/${fixture.race.id}/prediction/preview`, 'POST', { predictionRevision: saved.body.revision, raceRevision: fixture.race.revision, correctionReason: '' });
  const published = await fixture.client.call(`expert/races/${fixture.race.id}/prediction/publish/${preview.body.previewId}`, 'POST');
  await db.race.update({ where: { id: fixture.race.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
  return { fixture, predictionVersionId: published.body.versionId as string };
}
function resultBody(entries: { id: string; number: number }[], revision = 0, payout = 640) { return { revision, raceCanceled: false, reason: '公式発表と照合済み', entries: entries.map(entry => ({ entryId: entry.id, status: 'FINISHED', finishPosition: entry.number, popularity: entry.number, finalOdds: `${entry.number + 1}.0` })), payouts: [{ betType: 'EXACTA', combination: [1, 2], payoutPer100Yen: payout, refund: false }] }; }

describe('immutable race results and version-level performance', () => {
  it('authorizes result operations, settles frozen bets, supports corrections and preserves history', async () => {
    const { fixture, predictionVersionId } = await publishedRace();
    const member = new Client(); await member.login(await account());
    expect((await member.call(`admin/results/races/${fixture.race.id}`)).status).toBe(403);
    const adminWithoutMfa = new Client(); await adminWithoutMfa.login(await account('ADMIN'));
    expect((await adminWithoutMfa.call(`admin/results/races/${fixture.race.id}`)).body.code).toBe('MFA_REQUIRED');
    const operator = new Client(); await operator.login(await account('OPERATOR'));
    const resultList = await operator.call('admin/results/races'); expect(resultList.status).toBe(200); expect(resultList.body.items.some((item: { id: string }) => item.id === fixture.race.id)).toBe(true);

    expect((await operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', { ...resultBody(fixture.entries), entries: resultBody(fixture.entries).entries.slice(0, 1) })).body.code).toBe('RESULT_ENTRIES_INCOMPLETE');
    const saved = await operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', resultBody(fixture.entries)); expect(saved.status).toBe(200); expect(saved.body.revision).toBe(1);
    const conflict = await Promise.all([operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', resultBody(fixture.entries, 1, 650)), operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', resultBody(fixture.entries, 1, 660))]);
    expect(conflict.map(item => item.status).sort()).toEqual([200, 409]);
    const current = await db.raceResultDraft.findUniqueOrThrow({ where: { raceId: fixture.race.id } });
    const confirmed = await operator.call(`admin/results/races/${fixture.race.id}/confirm`, 'POST', { revision: current.revision, reason: '確定結果の初回確認' });
    expect(confirmed.status).toBe(201); expect(confirmed.body).toMatchObject({ version: 1, alreadyConfirmed: false });
    expect((await operator.call(`admin/results/races/${fixture.race.id}/confirm`, 'POST', { revision: current.revision, reason: '再送' })).body).toMatchObject({ version: 1, alreadyConfirmed: true });
    const performance = await db.predictionPerformance.findFirstOrThrow({ where: { resultVersion: { raceId: fixture.race.id, version: 1 }, predictionVersionId }, include: { betPerformances: true } });
    expect(performance).toMatchObject({ excluded: false, hit: true, stakeYen: 500, refundYen: 0, honmeiPosition: 1 });
    expect(performance.returnYen).toBeGreaterThan(0); expect(performance.betPerformances).toHaveLength(1);
    const version = await db.raceResultVersion.findUniqueOrThrow({ where: { id: confirmed.body.versionId } });
    await expect(db.raceResultVersion.update({ where: { id: version.id }, data: { reason: '改変' } })).rejects.toThrow();
    await expect(db.predictionPerformance.delete({ where: { id: performance.id } })).rejects.toThrow();
    await expect(db.betPerformance.update({ where: { id: performance.betPerformances[0].id }, data: { hit: false } })).rejects.toThrow();
    await expect(db.predictionPerformance.create({ data: { resultVersionId: version.id, predictionVersionId, excluded: false, hit: false, stakeYen: 0, refundYen: 0, payoutYen: 0, returnYen: 0 } })).rejects.toThrow();

    const correctionDraft = await operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', resultBody(fixture.entries, current.revision, 700));
    const correction = await operator.call(`admin/results/races/${fixture.race.id}/confirm`, 'POST', { revision: correctionDraft.body.revision, reason: '公式払戻訂正を反映' });
    expect(correction.body.version).toBe(2);
    expect(await db.raceResultVersion.count({ where: { raceId: fixture.race.id } })).toBe(2);
    const publicResult = await new Client().call(`races/${fixture.race.id}/result`); expect(publicResult.status).toBe(200); expect(publicResult.body.version).toBe(2); expect(publicResult.body.performances[0].hit).toBe(true);
    const stats = await new Client().call('results/stats'); expect(stats.status).toBe(200); expect(stats.body.ruleVersion).toBe('VERSION_AUDIT_V1');
    expect(await db.auditLog.count({ where: { targetId: fixture.race.id, action: 'RACE_RESULT_CONFIRM' } })).toBe(2);
  });

  it('requires explicit refund rows for bets containing withdrawn runners', async () => {
    const { fixture } = await publishedRace(); const operator = new Client(); await operator.login(await account('OPERATOR'));
    const body = resultBody(fixture.entries); body.entries[0] = { ...body.entries[0], status: 'WITHDRAWN', finishPosition: null } as typeof body.entries[number]; body.payouts = [];
    const saved = await operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', body);
    const rejected = await operator.call(`admin/results/races/${fixture.race.id}/confirm`, 'POST', { revision: saved.body.revision, reason: '返還確認' });
    expect(rejected.status).toBe(400); expect(rejected.body.code).toBe('REFUND_REQUIRED');
  });
});
