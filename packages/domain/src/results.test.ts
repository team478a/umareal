import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aggregatePerformances, getResultDataProvider, legacyRaceResultInputSchema, parseBatchResultCsv, parseResultCsv, resultDataProviderCatalog, settlePrediction, verifyJraVanResultBundle } from './results';

const entry = (entryId: string, finishPosition: number) => ({ entryId, status: 'FINISHED' as const, finishPosition, popularity: finishPosition, finalOdds: '2.5' });
describe('dormant legacy result settlement', () => {
  it('still verifies frozen historical bets and refunds', () => {
    const one = crypto.randomUUID(), two = crypto.randomUUID();
    const result = legacyRaceResultInputSchema.parse({ revision: 1, raceCanceled: false, reason: '公式結果を確認', entries: [entry(one, 1), entry(two, 2)], payouts: [
      { betType: 'EXACTA', combination: [1, 2], payoutPer100Yen: 640, refund: false }, { betType: 'WIN', combination: [2], payoutPer100Yen: 100, refund: true }
    ] });
    const settled = settlePrediction({ stance: 'BET', marks: [{ mark: 'HONMEI', entryId: one }], bets: [
      { id: crypto.randomUUID(), betType: 'EXACTA', combination: [[1, 2], [2, 1]], amountPerPointYen: 500, totalYen: 1000 },
      { id: crypto.randomUUID(), betType: 'WIN', combination: [[2]], amountPerPointYen: 300, totalYen: 300 }
    ], result });
    expect(settled).toMatchObject({ excluded: false, hit: true, stakeYen: 1300, payoutYen: 3200, refundYen: 300, returnYen: 3500, honmeiPosition: 1 });
  });
  it('excludes skips and canceled races from rates while retaining version counts', () => {
    expect(aggregatePerformances([{ excluded: false, hit: false, stakeYen: 1000, returnYen: 0, honmeiPosition: 4 }, { excluded: true, hit: false, stakeYen: 0, returnYen: 0, honmeiPosition: null }])).toMatchObject({ publishedVersions: 2, skippedOrCanceled: 1, eligiblePredictions: 1, hits: 0, hitRatePercent: 0, recoveryRatePercent: 0, honmeiPlaceRatePercent: 0 });
  });
});

describe('result CSV', () => {
  it('parses canonical result values without betting or payout fields', () => {
    const parsed = parseResultCsv('\uFEFFnumber,status,finishPosition,popularity,finalOdds\r\n1,FINISHED,1,2,3.4\r\n2,WITHDRAWN,,,');
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { number: 1, status: 'FINISHED', finishPosition: 1, popularity: 2, finalOdds: '3.4' },
      { number: 2, status: 'WITHDRAWN', finishPosition: null, popularity: null, finalOdds: null }
    ]);
  });

  it('rejects duplicate numbers, invalid status combinations and extra payout columns', () => {
    const invalid = parseResultCsv('number,status,finishPosition,popularity,finalOdds\n1,FINISHED,,1,2.0\n1,DNF,2,,');
    expect(invalid.errors.map(issue => issue.field)).toEqual(['finishPosition', 'finishPosition']);
    const duplicate = parseResultCsv('number,status,finishPosition,popularity,finalOdds\n1,FINISHED,1,1,2.0\n1,FINISHED,2,2,3.0');
    expect(duplicate.errors).toContainEqual({ row: 3, field: 'number', message: 'CSV内で馬番が重複しています。' });
    const payout = parseResultCsv('number,status,finishPosition,popularity,finalOdds,payout\n1,FINISHED,1,1,2.0,500');
    expect(payout.errors).toEqual([{ row: 1, field: 'header', message: expect.stringContaining('number,status,finishPosition,popularity,finalOdds') }]);
  });

  it('parses multiple races and rejects duplicate race and horse keys', () => {
    const header = 'raceDate,venue,raceNumber,horseNumber,status,finishPosition,popularity,finalOdds';
    const parsed = parseBatchResultCsv(`${header}\n2099-09-12,東京,10,1,FINISHED,1,2,3.4\n2099-09-12,東京,11,1,WITHDRAWN,,,`);
    expect(parsed.errors).toEqual([]); expect(parsed.rows).toHaveLength(2);
    const duplicate = parseBatchResultCsv(`${header}\n2099-09-12,東京,10,1,FINISHED,1,2,3.4\n2099-09-12,東京,10,1,FINISHED,2,1,2.0`);
    expect(duplicate.errors).toContainEqual({ row: 3, field: 'horseNumber', message: 'CSV内で同じレースの馬番が重複しています。' });
  });

  it('normalizes JRA-VAN bridge codes into the internal result format', () => {
    const header = 'recordType,raceDate,venueCode,raceNumber,horseNumber,abnormalCode,finishPosition,popularity,finalOdds,raceCanceled';
    const parsed = getResultDataProvider('JRA_VAN_BRIDGE_V1').parse(`${header}\nSE,2099-09-12,05,10,1,0,1,2,3.4,false\nSE,2099-09-12,05,10,2,1,,,,false\nSE,2099-09-12,05,10,3,4,,,,false`);
    expect(parsed.provider).toMatchObject({ id: 'JRA_VAN_BRIDGE_V1', formatVersion: 'UMAREAL_JRA_VAN_BRIDGE_V1' });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { raceDate: '2099-09-12', venue: '東京', raceNumber: 10, horseNumber: 1, status: 'FINISHED', finishPosition: 1, popularity: 2, finalOdds: '3.4' },
      { raceDate: '2099-09-12', venue: '東京', raceNumber: 10, horseNumber: 2, status: 'WITHDRAWN', finishPosition: null, popularity: null, finalOdds: null },
      { raceDate: '2099-09-12', venue: '東京', raceNumber: 10, horseNumber: 3, status: 'DNF', finishPosition: null, popularity: null, finalOdds: null }
    ]);
    expect(resultDataProviderCatalog.map(item => item.id)).toEqual(['CANONICAL_CSV', 'JRA_VAN_BRIDGE_V1']);
  });

  it('accepts the checked-in Windows bridge golden output', () => {
    const csv = readFileSync('tools/jra_van_bridge/samples/expected-results.csv', 'utf8');
    const parsed = getResultDataProvider('JRA_VAN_BRIDGE_V1').parse(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { raceDate: '2026-09-13', venue: '東京', raceNumber: 10, horseNumber: 1, status: 'FINISHED', finishPosition: 1, popularity: 2, finalOdds: '3.4' },
      { raceDate: '2026-09-13', venue: '東京', raceNumber: 10, horseNumber: 2, status: 'WITHDRAWN', finishPosition: null, popularity: null, finalOdds: null },
      { raceDate: '2026-09-13', venue: '中山', raceNumber: 11, horseNumber: 1, status: 'FINISHED', finishPosition: 1, popularity: 1, finalOdds: '2.0' }
    ]);
  });

  it('verifies bundle provenance before accepting its results CSV', () => {
    const csv = readFileSync('tools/jra_van_bridge/samples/expected-results.csv', 'utf8');
    const rows = getResultDataProvider('JRA_VAN_BRIDGE_V1').parse(csv).rows;
    const checksum = (value: string) => createHash('sha256').update(value).digest('hex');
    const manifest = JSON.stringify({
      formatVersion: 'UMAREAL_JRA_VAN_BUNDLE_V1', targetDate: '2026-09-13', raceCount: 2, entryRaceCount: 2, entryCount: 3,
      finalizedRaceCount: 2, resultsIncluded: true,
      source: { raRecordCount: 2, raSha256: 'a'.repeat(64), seRecordCount: 3, seSha256: 'b'.repeat(64) },
      files: [
        { kind: 'RACES', path: 'races.csv', rowCount: 2, sha256: 'c'.repeat(64) },
        { kind: 'ENTRIES', path: 'entries/2026-09-13-05-10R.csv', rowCount: 2, sha256: 'd'.repeat(64) },
        { kind: 'ENTRIES', path: 'entries/2026-09-13-06-11R.csv', rowCount: 1, sha256: 'e'.repeat(64) },
        { kind: 'RESULTS', path: 'results.csv', rowCount: 3, sha256: checksum(csv) }
      ]
    });
    expect(verifyJraVanResultBundle(manifest, csv, rows, checksum).errors).toEqual([]);
    expect(verifyJraVanResultBundle(manifest, csv.replace('3.4', '9.9'), rows, checksum).errors).toContainEqual(expect.objectContaining({ field: 'results.csv', message: expect.stringContaining('SHA-256') }));
    expect(verifyJraVanResultBundle(JSON.stringify({ ...JSON.parse(manifest), sampleData: true }), csv, rows, checksum).errors).toContainEqual(expect.objectContaining({ field: 'bundleManifest.sampleData', message: expect.stringContaining('合成データ') }));
  });

  it('rejects unsupported JRA-VAN bridge records, codes and contradictory canceled rows', () => {
    const header = 'recordType,raceDate,venueCode,raceNumber,horseNumber,abnormalCode,finishPosition,popularity,finalOdds,raceCanceled';
    const parsed = getResultDataProvider('JRA_VAN_BRIDGE_V1').parse(`${header}\nHR,2099-09-12,05,10,1,0,1,1,2.0,false\nSE,2099-09-12,99,10,2,9,,,,false\nSE,2099-09-12,05,10,3,0,1,,,true`);
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors.map(issue => issue.field)).toEqual(expect.arrayContaining(['recordType', 'venueCode', 'abnormalCode', 'raceCanceled']));
  });
});
