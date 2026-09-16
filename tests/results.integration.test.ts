import { afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { emptyPredictionDraft } from '../packages/domain/src';
import { assessmentFixture } from './assessment-fixtures';
import { account, Client, db } from './helpers';

afterAll(() => db.$disconnect());

async function publishedRace() {
  const fixture = await assessmentFixture('ADMIN', 2, 2);
  const draft = { ...emptyPredictionDraft, visibility: 'PAID' as const, confidence: 'A' as const, summary: '結果集計試験', marks: [{ entryId: fixture.entries[0].id, mark: 'HONMEI' as const, reason: '最終本命' }, { entryId: fixture.entries[1].id, mark: 'TAIKO' as const, reason: '相手候補' }] };
  const saved = await fixture.client.call(`expert/races/${fixture.race.id}/prediction/draft`, 'POST', { draft, revision: 0, raceRevision: fixture.race.revision, mutationId: randomUUID(), reason: '結果試験予想' });
  const preview = await fixture.client.call(`expert/races/${fixture.race.id}/prediction/preview`, 'POST', { predictionRevision: saved.body.revision, raceRevision: fixture.race.revision, correctionReason: '' });
  const published = await fixture.client.call(`expert/races/${fixture.race.id}/prediction/publish/${preview.body.previewId}`, 'POST');
  await db.race.update({ where: { id: fixture.race.id }, data: { startsAt: new Date(Date.now() - 60_000) } });
  return { fixture, predictionVersionId: published.body.versionId as string };
}

function resultBody(entries: { id: string; number: number }[], revision = 0) { return { revision, raceCanceled: false, reason: '公式発表と照合済み', entries: entries.map(entry => ({ entryId: entry.id, status: 'FINISHED', finishPosition: entry.number, popularity: entry.number, finalOdds: `${entry.number + 1}.0` })) }; }

describe('immutable results and horse-evaluation performance', () => {
  it('authorizes operations, evaluates frozen marks and preserves corrections', async () => {
    const { fixture, predictionVersionId } = await publishedRace();
    const member = new Client(); await member.login(await account());
    expect((await member.call(`admin/results/races/${fixture.race.id}`)).status).toBe(403);
    const adminWithoutMfa = new Client(); await adminWithoutMfa.login(await account('ADMIN'));
    expect((await adminWithoutMfa.call(`admin/results/races/${fixture.race.id}`)).body.code).toBe('MFA_REQUIRED');
    const operator = new Client(); await operator.login(await account('OPERATOR'));
    expect((await operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', { ...resultBody(fixture.entries), entries: resultBody(fixture.entries).entries.slice(0, 1) })).status).toBe(400);
    expect((await operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', { ...resultBody(fixture.entries), payouts: [] })).status).toBe(400);
    const saved = await operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', resultBody(fixture.entries));
    expect(saved.status).toBe(200); expect(saved.body.revision).toBe(1);
    const conflict = await Promise.all([operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', resultBody(fixture.entries, 1)), operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', { ...resultBody(fixture.entries, 1), reason: '別担当者の保存' })]);
    expect(conflict.map(item => item.status).sort()).toEqual([200, 409]);
    const current = await db.raceResultDraft.findUniqueOrThrow({ where: { raceId: fixture.race.id } });
    const confirmed = await operator.call(`admin/results/races/${fixture.race.id}/confirm`, 'POST', { revision: current.revision, reason: '確定結果の初回確認' });
    expect(confirmed.status).toBe(201); expect(confirmed.body).toMatchObject({ version: 1, alreadyConfirmed: false });
    expect((await operator.call(`admin/results/races/${fixture.race.id}/confirm`, 'POST', { revision: current.revision, reason: '再送' })).body).toMatchObject({ version: 1, alreadyConfirmed: true });
    const evaluation = await db.predictionEvaluation.findFirstOrThrow({ where: { resultVersion: { raceId: fixture.race.id, version: 1 }, predictionVersionId } });
    expect(evaluation).toMatchObject({ status: 'PRIMARY_WIN', primaryFinishedFirst: true, primaryFinishedTop2: true, primaryFinishedTop3: true, winnerInRecommended: true, calculationRuleVersion: 'HORSE_EVALUATION_V1' });
    const resultEvent = await db.notificationEvent.findUniqueOrThrow({ where: { raceResultVersionId: confirmed.body.versionId } });
    expect(resultEvent).toMatchObject({ eventType: 'RACE_EVALUATION_CONFIRMED', status: 'QUEUED' });
    expect(JSON.stringify(resultEvent.payload)).not.toMatch(/horse|entry|mark|reason|amount|payout|return|recovery/i);
    const version = await db.raceResultVersion.findUniqueOrThrow({ where: { id: confirmed.body.versionId } });
    expect(version.payoutsSnapshot).toEqual([]);
    await expect(db.raceResultVersion.update({ where: { id: version.id }, data: { reason: '改変' } })).rejects.toThrow();
    await expect(db.predictionEvaluation.delete({ where: { id: evaluation.id } })).rejects.toThrow();
    await expect(db.predictionEvaluation.update({ where: { id: evaluation.id }, data: { status: 'REVIEW_REQUIRED' } })).rejects.toThrow();

    const correctionDraft = await operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', { ...resultBody(fixture.entries, current.revision), reason: '着順訂正' });
    const correction = await operator.call(`admin/results/races/${fixture.race.id}/confirm`, 'POST', { revision: correctionDraft.body.revision, reason: '公式着順訂正を反映' });
    expect(correction.body.version).toBe(2);
    expect(await db.notificationEvent.count({ where: { raceResultVersion: { raceId: fixture.race.id } } })).toBe(2);
    await expect(db.notificationEvent.create({ data: { raceResultVersionId: confirmed.body.versionId, eventType: 'RACE_EVALUATION_CONFIRMED', status: 'QUEUED', payload: {} } })).rejects.toThrow();
    expect(await db.raceResultVersion.count({ where: { raceId: fixture.race.id } })).toBe(2);
    const publicResult = await new Client().call(`races/${fixture.race.id}/result`);
    expect(publicResult.status).toBe(200); expect(publicResult.body.version).toBe(2); expect(publicResult.body.evaluations[0].status).toBe('PRIMARY_WIN'); expect(JSON.stringify(publicResult.body)).not.toMatch(/payout|stakeYen|returnYen|recovery/);
    expect((await member.call('admin/social-shares')).status).toBe(403);
    expect((await adminWithoutMfa.call('admin/social-shares')).body.code).toBe('MFA_REQUIRED');
    const shares = await fixture.client.call('admin/social-shares');
    expect(shares.status).toBe(200);
    const raceShare = shares.body.items.find((item: { path: string }) => item.path === `/races/${fixture.race.id}`);
    expect(raceShare).toMatchObject({ kind: 'PADDOCK', status: 'PRIMARY_WIN', shareable: true });
    expect(raceShare.text).toContain('本命馬が1着');
    expect(JSON.stringify(raceShare)).not.toMatch(/買い目|組み合わせ|購入|払戻|回収率|収支|利益|的中/);
    const memberNotices = await member.call('me/notifications');
    expect(memberNotices.body.items.some((item: { eventType: string; href: string }) => item.eventType === 'RACE_EVALUATION_CONFIRMED' && item.href === `/races/${fixture.race.id}`)).toBe(true);
    const stats = await new Client().call('results/stats');
    expect(stats.status).toBe(200); expect(stats.body.ruleVersion).toBe('HORSE_EVALUATION_V1'); expect(stats.body.overall.primaryWins).toBeGreaterThanOrEqual(1); expect(stats.body.overall).toMatchObject({ primaryWinRatePercent: 100, primaryTop2RatePercent: 100, primaryTop3RatePercent: 100 });
    expect(await db.auditLog.count({ where: { targetId: fixture.race.id, action: 'RACE_RESULT_CONFIRM' } })).toBe(2);
  });

  it('previews a complete result CSV, rejects stale confirmation and imports only a draft', async () => {
    const { fixture } = await publishedRace();
    const operator = new Client(); await operator.login(await account('OPERATOR'));
    const header = 'number,status,finishPosition,popularity,finalOdds';
    const csv = `${header}\n${fixture.entries.map((entry, index) => `${entry.number},FINISHED,${index + 1},${index + 1},${index + 2}.5`).join('\n')}`;

    const incomplete = await operator.call(`admin/results/races/${fixture.race.id}/import/preview`, 'POST', { csv: `${header}\n${fixture.entries[0].number},FINISHED,1,1,2.5`, raceCanceled: false });
    expect(incomplete.status).toBe(201); expect(incomplete.body.batchId).toBeNull(); expect(incomplete.body.errors[0].message).toContain('結果がありません');

    const firstPreview = await operator.call(`admin/results/races/${fixture.race.id}/import/preview`, 'POST', { csv, raceCanceled: false });
    expect(firstPreview.status).toBe(201); expect(firstPreview.body.errors).toEqual([]); expect(firstPreview.body.changes.some((change: { action: string }) => change.action === '変更')).toBe(true);
    await operator.call(`admin/results/races/${fixture.race.id}`, 'PATCH', resultBody(fixture.entries));
    const stale = await operator.call(`admin/results/races/${fixture.race.id}/import/${firstPreview.body.batchId}/confirm`, 'POST', { reason: '公式結果CSVを照合' });
    expect(stale.status).toBe(409); expect(stale.body.code).toBe('STALE_PREVIEW');

    const revisedCsv = `${header}\n${fixture.entries.map((entry, index) => `${entry.number},FINISHED,${index + 1},${index + 1},${index + 4}.5`).join('\n')}`;
    const preview = await operator.call(`admin/results/races/${fixture.race.id}/import/preview`, 'POST', { csv: revisedCsv, raceCanceled: false });
    const imported = await operator.call(`admin/results/races/${fixture.race.id}/import/${preview.body.batchId}/confirm`, 'POST', { reason: '公式結果CSVを再照合' });
    expect(imported.status).toBe(201); expect(imported.body).toMatchObject({ imported: true, revision: 2, alreadyConfirmed: false });
    const repeated = await operator.call(`admin/results/races/${fixture.race.id}/import/${preview.body.batchId}/confirm`, 'POST', { reason: '通信再送' });
    expect(repeated.body).toMatchObject({ imported: true, revision: 2, alreadyConfirmed: true });
    const draft = await db.raceResultDraft.findUniqueOrThrow({ where: { raceId: fixture.race.id } });
    expect(draft).toMatchObject({ revision: 2, updatedBy: expect.any(String) });
    expect(JSON.stringify(draft.content)).not.toMatch(/payout|betType|purchase|returnRate/i);
    expect(await db.raceResultVersion.count({ where: { raceId: fixture.race.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { targetId: fixture.race.id, action: 'RACE_RESULT_CSV_IMPORT_CONFIRMED' } })).toBe(1);
  });

  it('imports multiple race drafts atomically and leaves every result unconfirmed', async () => {
    const first = (await publishedRace()).fixture, second = (await publishedRace()).fixture;
    const uniqueKey = () => { const value = Number.parseInt(randomUUID().slice(0, 8), 16); return { raceDate: `${2050 + value % 40}-${String(1 + Math.floor(value / 40) % 12).padStart(2, '0')}-${String(1 + Math.floor(value / 480) % 28).padStart(2, '0')}`, venue: ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'][Math.floor(value / 13440) % 10], number: 1 + Math.floor(value / 134400) % 12 }; };
    first.race = await db.race.update({ where: { id: first.race.id }, data: uniqueKey() });
    second.race = await db.race.update({ where: { id: second.race.id }, data: uniqueKey() });
    const operator = new Client(); await operator.login(await account('OPERATOR'));
    const providers = await operator.call('admin/results/import/providers');
    expect(providers.status).toBe(200); expect(providers.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'CANONICAL_CSV' }), expect.objectContaining({ id: 'JRA_VAN_BRIDGE_V1', formatVersion: 'UMAREAL_JRA_VAN_BRIDGE_V1' })]));
    const header = 'raceDate,venue,raceNumber,horseNumber,status,finishPosition,popularity,finalOdds';
    const row = (fixture: typeof first, entryIndex: number, oddsOffset = 0) => {
      const entry = fixture.entries[entryIndex]; return `${fixture.race.raceDate},${fixture.race.venue},${fixture.race.number},${entry.number},FINISHED,${entryIndex + 1},${entryIndex + 1},${entryIndex + 2 + oddsOffset}.5`;
    };
    const mixedCanceled = `${header}\n${first.race.raceDate},${first.race.venue},${first.race.number},${first.entries[0].number},CANCELED,,,\n${row(first, 1)}\n${row(second, 0)}\n${row(second, 1)}`;
    const rejected = await operator.call('admin/results/import/preview', 'POST', { csv: mixedCanceled });
    expect(rejected.status).toBe(201); expect(rejected.body.batchId).toBeNull(); expect(rejected.body.errors.some((issue: { message: string }) => issue.message.includes('混在'))).toBe(true);

    const csv = `${header}\n${row(first, 0)}\n${row(second, 0)}\n${row(first, 1)}\n${row(second, 1)}`;
    const stalePreview = await operator.call('admin/results/import/preview', 'POST', { csv });
    expect(stalePreview.body).toMatchObject({ errors: [], races: expect.arrayContaining([expect.objectContaining({ raceId: first.race.id }), expect.objectContaining({ raceId: second.race.id })]) });
    await operator.call(`admin/results/races/${first.race.id}`, 'PATCH', resultBody(first.entries));
    const stale = await operator.call(`admin/results/import/${stalePreview.body.batchId}/confirm`, 'POST', { reason: '一括結果を照合' });
    expect(stale.status).toBe(409); expect(stale.body.code).toBe('STALE_PREVIEW');
    expect(await db.raceResultDraft.findUnique({ where: { raceId: second.race.id } })).toBeNull();

    const venueCodes: Record<string, string> = { '札幌': '01', '函館': '02', '福島': '03', '新潟': '04', '東京': '05', '中山': '06', '中京': '07', '京都': '08', '阪神': '09', '小倉': '10' };
    const bridgeHeader = 'recordType,raceDate,venueCode,raceNumber,horseNumber,abnormalCode,finishPosition,popularity,finalOdds,raceCanceled';
    const bridgeRow = (fixture: typeof first, entryIndex: number, oddsOffset = 0) => { const entry = fixture.entries[entryIndex]; return `SE,${fixture.race.raceDate},${venueCodes[fixture.race.venue]},${fixture.race.number},${entry.number},0,${entryIndex + 1},${entryIndex + 1},${entryIndex + 4 + oddsOffset}.5,false`; };
    const revisedCsv = `${bridgeHeader}\n${bridgeRow(first, 0)}\n${bridgeRow(second, 0)}\n${bridgeRow(first, 1)}\n${bridgeRow(second, 1)}`;
    const preview = await operator.call('admin/results/import/preview', 'POST', { csv: revisedCsv, providerId: 'JRA_VAN_BRIDGE_V1' });
    expect(preview.body.races).toHaveLength(2); expect(preview.body).toMatchObject({ provider: { id: 'JRA_VAN_BRIDGE_V1', formatVersion: 'UMAREAL_JRA_VAN_BRIDGE_V1' }, sourceChecksum: expect.stringMatching(/^[a-f0-9]{64}$/), sourceDisposition: 'NEW', previousImport: null });
    const concurrentPreview = await operator.call('admin/results/import/preview', 'POST', { csv: revisedCsv, providerId: 'JRA_VAN_BRIDGE_V1' });
    expect(concurrentPreview.body.batchId).not.toBe(preview.body.batchId);
    const imported = await operator.call(`admin/results/import/${preview.body.batchId}/confirm`, 'POST', { reason: '開催日の公式結果を一括照合' });
    expect(imported.status).toBe(201); expect(imported.body).toMatchObject({ imported: true, count: 2, alreadyConfirmed: false });
    const repeated = await operator.call(`admin/results/import/${preview.body.batchId}/confirm`, 'POST', { reason: '通信再送' });
    expect(repeated.body).toMatchObject({ imported: true, count: 2, alreadyConfirmed: true });
    const concurrentRejected = await operator.call(`admin/results/import/${concurrentPreview.body.batchId}/confirm`, 'POST', { reason: '別プレビューからの重複確定' });
    expect(concurrentRejected.status).toBe(409); expect(concurrentRejected.body.code).toBe('DUPLICATE_RESULT_IMPORT');
    await expect(db.importBatch.update({ where: { id: concurrentPreview.body.batchId }, data: { confirmedAt: new Date() } })).rejects.toThrow();
    const duplicatePreview = await operator.call('admin/results/import/preview', 'POST', { csv: revisedCsv, providerId: 'JRA_VAN_BRIDGE_V1' });
    expect(duplicatePreview.body.batchId).toBeNull(); expect(duplicatePreview.body.duplicateOf.batchId).toBe(preview.body.batchId); expect(duplicatePreview.body.errors[0].field).toBe('sourceChecksum');

    const correctedCsv = `${bridgeHeader}\n${bridgeRow(first, 0, 1)}\n${bridgeRow(second, 0, 1)}\n${bridgeRow(first, 1, 1)}\n${bridgeRow(second, 1, 1)}`;
    const correctionPreview = await operator.call('admin/results/import/preview', 'POST', { csv: correctedCsv, providerId: 'JRA_VAN_BRIDGE_V1' });
    expect(correctionPreview.body).toMatchObject({ sourceDisposition: 'CORRECTION', previousImport: { batchId: preview.body.batchId, sourceChecksum: preview.body.sourceChecksum } });
    const correction = await operator.call(`admin/results/import/${correctionPreview.body.batchId}/confirm`, 'POST', { reason: '公式訂正データを照合' });
    expect(correction.status).toBe(201); expect(correction.body).toMatchObject({ imported: true, count: 2 });
    const firstDraft = await db.raceResultDraft.findUniqueOrThrow({ where: { raceId: first.race.id } });
    expect(firstDraft).toMatchObject({ revision: 3 }); expect(firstDraft.content).toMatchObject({ source: 'CSV_BATCH', sourceProvider: 'JRA_VAN_BRIDGE_V1', sourceFormatVersion: 'UMAREAL_JRA_VAN_BRIDGE_V1', sourceChecksum: correctionPreview.body.sourceChecksum, sourceDisposition: 'CORRECTION', sourceImportBatchId: correctionPreview.body.batchId, previousImportBatchId: preview.body.batchId });
    expect(await db.raceResultDraft.findUniqueOrThrow({ where: { raceId: second.race.id } })).toMatchObject({ revision: 2 });
    expect(await db.raceResultVersion.count({ where: { raceId: { in: [first.race.id, second.race.id] } } })).toBe(0);
    const audits = await db.auditLog.findMany({ where: { targetId: { in: [first.race.id, second.race.id] }, action: 'RACE_RESULT_BATCH_CSV_IMPORT_CONFIRMED' } });
    expect(audits).toHaveLength(4); expect(audits.some(audit => JSON.stringify(audit.details).includes(correctionPreview.body.sourceChecksum))).toBe(true);
    const history = await operator.call('admin/results/import/history');
    expect(history.status).toBe(200); expect(history.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ batchId: preview.body.batchId, sourceDisposition: 'NEW' }), expect.objectContaining({ batchId: correctionPreview.body.batchId, sourceDisposition: 'CORRECTION', previousImportBatchId: preview.body.batchId })]));
    const list = await operator.call('admin/results/races');
    expect(list.body.items.filter((item: { id: string }) => [first.race.id, second.race.id].includes(item.id)).every((item: { draftSource: string; draftProvider: string }) => item.draftSource === 'CSV_BATCH' && item.draftProvider === 'JRA_VAN_BRIDGE_V1')).toBe(true);
  });

  it('verifies JRA-VAN bundle provenance before creating result drafts', async () => {
    const fixture = (await publishedRace()).fixture;
    const discriminator = Number.parseInt(randomUUID().slice(0, 6), 16);
    const targetDate = `${2070 + discriminator % 20}-${String(1 + Math.floor(discriminator / 20) % 12).padStart(2, '0')}-${String(1 + Math.floor(discriminator / 240) % 28).padStart(2, '0')}`;
    fixture.race = await db.race.update({ where: { id: fixture.race.id }, data: { raceDate: targetDate, venue: '東京', number: 12 } });
    const csv = [
      'recordType,raceDate,venueCode,raceNumber,horseNumber,abnormalCode,finishPosition,popularity,finalOdds,raceCanceled',
      ...fixture.entries.map((entry, index) => `SE,${targetDate},05,12,${entry.number},0,${index + 1},${index + 1},${index + 2}.5,false`)
    ].join('\n');
    const checksum = (source: string) => createHash('sha256').update(source).digest('hex');
    const manifest = JSON.stringify({
      formatVersion: 'UMAREAL_JRA_VAN_BUNDLE_V1', targetDate, raceCount: 1, entryRaceCount: 1,
      entryCount: fixture.entries.length, finalizedRaceCount: 1, resultsIncluded: true,
      source: { raRecordCount: 1, raSha256: 'a'.repeat(64), seRecordCount: fixture.entries.length, seSha256: 'b'.repeat(64) },
      files: [
        { kind: 'RACES', path: 'races.csv', rowCount: 1, sha256: 'c'.repeat(64) },
        { kind: 'ENTRIES', path: `entries/${targetDate}-05-12R.csv`, rowCount: fixture.entries.length, sha256: 'd'.repeat(64) },
        { kind: 'RESULTS', path: 'results.csv', rowCount: fixture.entries.length, sha256: checksum(csv) }
      ]
    });
    const operator = new Client(); await operator.login(await account('OPERATOR'));
    const rejected = await operator.call('admin/results/import/preview', 'POST', { csv: csv.replace('2.5', '9.5'), providerId: 'JRA_VAN_BRIDGE_V1', bundleManifest: manifest });
    expect(rejected.body.batchId).toBeNull(); expect(rejected.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'results.csv', message: expect.stringContaining('SHA-256') })]));
    const rehearsal = await operator.call('admin/results/import/preview', 'POST', { csv, providerId: 'JRA_VAN_BRIDGE_V1', bundleManifest: JSON.stringify({ ...JSON.parse(manifest), sampleData: true }) });
    expect(rehearsal.body.batchId).toBeNull(); expect(rehearsal.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'bundleManifest.sampleData', message: expect.stringContaining('合成データ') })]));

    const preview = await operator.call('admin/results/import/preview', 'POST', { csv, providerId: 'JRA_VAN_BRIDGE_V1', bundleManifest: manifest });
    expect(preview.body).toMatchObject({ errors: [], bundle: { formatVersion: 'UMAREAL_JRA_VAN_BUNDLE_V1', targetDate, manifestChecksum: checksum(manifest) } });
    const confirmed = await operator.call(`admin/results/import/${preview.body.batchId}/confirm`, 'POST', { reason: 'JRA-VAN一括出力を照合' });
    expect(confirmed.status).toBe(201);
    const draft = await db.raceResultDraft.findUniqueOrThrow({ where: { raceId: fixture.race.id } });
    expect(draft.content).toMatchObject({ sourceBundle: { formatVersion: 'UMAREAL_JRA_VAN_BUNDLE_V1', targetDate, manifestChecksum: checksum(manifest) } });
    expect(await db.raceResultVersion.count({ where: { raceId: fixture.race.id } })).toBe(0);
    const history = await operator.call('admin/results/import/history');
    expect(history.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ batchId: preview.body.batchId, bundle: expect.objectContaining({ targetDate, manifestChecksum: checksum(manifest) }) })]));
  });
});
