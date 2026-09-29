import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminResultBatchImportConfirmResponseSchema, adminResultBatchImportPreviewResponseSchema, adminResultConfirmResponseSchema, adminResultDataProvidersResponseSchema, adminResultDraftSaveResponseSchema, adminResultImportHistoryResponseSchema, adminResultRaceDetailResponseSchema, adminResultRaceImportConfirmResponseSchema, adminResultRaceImportPreviewResponseSchema, adminResultRacesResponseSchema, aggregatePerformances, getResultDataProvider, legacyRaceResultInputSchema, parseBatchResultCsv, parseResultCsv, publicPredictionStatsResponseSchema, publicRaceResultResponseSchema, resultDataProviderCatalog, settlePrediction, verifyJraVanResultBundle } from './results';

const entry = (entryId: string, finishPosition: number) => ({ entryId, status: 'FINISHED' as const, finishPosition, popularity: finishPosition, finalOdds: '2.5' });

describe('public race result contract', () => {
  it('distinguishes an unconfirmed race without exposing internal fields', () => {
    expect(publicRaceResultResponseSchema.parse({ confirmed: false })).toEqual({ confirmed: false });
    expect(() => publicRaceResultResponseSchema.parse({ confirmed: false, reason: '内部確認理由' })).toThrow();
  });

  it('normalizes dates and rejects internal result-version data', () => {
    const entryId = crypto.randomUUID();
    const value = {
      confirmed: true as const,
      version: 2,
      ruleVersion: 'HORSE_EVALUATION_V1',
      raceCanceled: false,
      confirmedAt: new Date('2026-09-27T03:00:00.000Z'),
      entries: [{ ...entry(entryId, 1), number: 6, horseName: 'テストホース' }],
      evaluations: [{
        status: 'PRIMARY_WIN', primaryFinishedFirst: true, primaryFinishedTop2: true, primaryFinishedTop3: true, winnerInRecommended: true,
        predictionVersion: { version: 1, confidence: 'A', publishedAt: new Date('2026-09-26T08:00:00.000Z') }
      }]
    };
    expect(publicRaceResultResponseSchema.parse(value)).toMatchObject({ confirmed: true, confirmedAt: '2026-09-27T03:00:00.000Z' });
    expect(() => publicRaceResultResponseSchema.parse({ ...value, confirmedBy: crypto.randomUUID() })).toThrow();
    expect(() => publicRaceResultResponseSchema.parse({ ...value, payoutsSnapshot: [] })).toThrow();
    expect(() => publicRaceResultResponseSchema.parse({ ...value, evaluations: [{ ...value.evaluations[0], calculationRuleVersion: 'HORSE_EVALUATION_V1' }] })).toThrow();
  });
});

describe('public prediction statistics contract', () => {
  const metric = {
    publishedRaces: 4, primaryWins: 2, primaryWinRatePercent: 50, primaryTop2RatePercent: 75, primaryTop3RatePercent: 75,
    upHorseSuccessRatePercent: null, downHorseFailureRatePercent: null, riskHorseFailureRatePercent: null, skipped: 1, skipRatePercent: 25
  };
  const response = {
    ruleVersion: 'HORSE_EVALUATION_V1' as const,
    scope: '公開版別の馬評価集計' as const,
    overall: metric,
    byConfidence: [{ value: 'A', ...metric }],
    byVenue: [{ value: '東京', ...metric }],
    bySurface: [{ value: 'TURF', ...metric }],
    byMonth: [{ value: '2026-09', ...metric }]
  };

  it('accepts the existing public aggregation shape', () => {
    expect(publicPredictionStatsResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects betting, identity and internal result-version fields', () => {
    expect(() => publicPredictionStatsResponseSchema.parse({ ...response, returnRate: 120 })).toThrow();
    expect(() => publicPredictionStatsResponseSchema.parse({ ...response, userId: crypto.randomUUID() })).toThrow();
    expect(() => publicPredictionStatsResponseSchema.parse({ ...response, overall: { ...metric, confirmedBy: crypto.randomUUID() } })).toThrow();
  });
});

describe('admin result data provider contract', () => {
  const response = {
    items: resultDataProviderCatalog.map(provider => ({
      id: provider.id,
      label: provider.label,
      formatVersion: provider.formatVersion,
      headers: provider.headers
    }))
  };

  it('accepts every existing provider without changing the response shape', () => {
    expect(adminResultDataProvidersResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects internal configuration, missing providers and duplicate IDs', () => {
    expect(adminResultDataProvidersResponseSchema.safeParse({ ...response, databaseUrl: 'postgresql://private' }).success).toBe(false);
    expect(adminResultDataProvidersResponseSchema.safeParse({
      items: response.items.map((provider, index) => index === 0 ? { ...provider, accessToken: 'secret' } : provider)
    }).success).toBe(false);
    expect(adminResultDataProvidersResponseSchema.safeParse({ items: response.items.slice(0, 1) }).success).toBe(false);
    expect(adminResultDataProvidersResponseSchema.safeParse({ items: [response.items[0], response.items[0]] }).success).toBe(false);
  });
});

describe('admin result import history contract', () => {
  const previousImportBatchId = crypto.randomUUID();
  const response = {
    items: [{
      batchId: crypto.randomUUID(),
      provider: { id: 'JRA_VAN_BRIDGE_V1' as const, label: 'JRA-VAN連携ブリッジ', formatVersion: 'UMAREAL_JRA_VAN_BRIDGE_V1' },
      sourceChecksum: 'a'.repeat(64),
      sourceDisposition: 'CORRECTION' as const,
      previousImportBatchId,
      bundle: { formatVersion: 'UMAREAL_JRA_VAN_BUNDLE_V1' as const, targetDate: '2026-09-27', manifestChecksum: 'b'.repeat(64) },
      actorDisplayName: '運営担当者',
      confirmedAt: new Date('2026-09-27T03:00:00.000Z'),
      races: [{ raceId: crypto.randomUUID(), label: '2026-09-27 東京 10R テストレース', revision: 2 }]
    }]
  };

  it('normalizes dates while preserving the existing history response', () => {
    expect(adminResultImportHistoryResponseSchema.parse(response)).toMatchObject({
      items: [{ confirmedAt: '2026-09-27T03:00:00.000Z', previousImportBatchId }]
    });
  });

  it('rejects internal data and inconsistent correction provenance', () => {
    expect(adminResultImportHistoryResponseSchema.safeParse({
      items: [{ ...response.items[0], actorId: crypto.randomUUID() }]
    }).success).toBe(false);
    expect(adminResultImportHistoryResponseSchema.safeParse({
      items: [{ ...response.items[0], provider: { ...response.items[0].provider, accessToken: 'secret' } }]
    }).success).toBe(false);
    expect(adminResultImportHistoryResponseSchema.safeParse({
      items: [{ ...response.items[0], sourceDisposition: 'CORRECTION', previousImportBatchId: null }]
    }).success).toBe(false);
    expect(adminResultImportHistoryResponseSchema.safeParse({
      items: [{ ...response.items[0], sourceDisposition: 'NEW', previousImportBatchId }]
    }).success).toBe(false);
  });
});

describe('admin result race list contract', () => {
  const response = {
    items: [{
      id: crypto.randomUUID(),
      raceDate: '2026-09-27',
      venue: '東京' as const,
      number: 10,
      name: 'テストレース',
      startsAt: new Date('2026-09-27T06:00:00.000Z'),
      status: 'FINISHED' as const,
      draftRevision: 2,
      draftSource: 'CSV_BATCH' as const,
      draftProvider: 'JRA_VAN_BRIDGE_V1' as const,
      latestResult: { version: 1, sourceRevision: 2, confirmedAt: new Date('2026-09-27T07:00:00.000Z'), raceCanceled: false }
    }]
  };

  it('normalizes dates while preserving the existing list response', () => {
    expect(adminResultRacesResponseSchema.parse(response)).toMatchObject({
      items: [{ startsAt: '2026-09-27T06:00:00.000Z', latestResult: { confirmedAt: '2026-09-27T07:00:00.000Z' } }]
    });
  });

  it('rejects result drafts, staff identity and invalid provider data', () => {
    expect(adminResultRacesResponseSchema.safeParse({
      items: [{ ...response.items[0], resultDraft: { content: { reason: '内部情報' } } }]
    }).success).toBe(false);
    expect(adminResultRacesResponseSchema.safeParse({
      items: [{ ...response.items[0], latestResult: { ...response.items[0].latestResult, confirmedBy: crypto.randomUUID() } }]
    }).success).toBe(false);
    expect(adminResultRacesResponseSchema.safeParse({
      items: [{ ...response.items[0], draftProvider: 'PRIVATE_PROVIDER' }]
    }).success).toBe(false);
  });
});

describe('admin result race detail contract', () => {
  const entryId = crypto.randomUUID();
  const response = {
    race: {
      id: crypto.randomUUID(), raceDate: '2026-09-27', venue: '東京', number: 10, name: 'テストレース',
      startsAt: new Date('2026-09-27T06:00:00.000Z'), status: 'FINISHED'
    },
    entries: [{ id: entryId, number: 6, horseName: 'テストホース' }],
    draft: {
      revision: 0, raceCanceled: false, reason: '',
      entries: [{ entryId, status: 'FINISHED' as const, finishPosition: null, popularity: null, finalOdds: null }]
    },
    versions: [{
      id: crypto.randomUUID(), version: 1, sourceRevision: 1, ruleVersion: 'HORSE_EVALUATION_V1', raceCanceled: false,
      reason: '公式結果を確認', confirmedAt: new Date('2026-09-27T07:00:00.000Z')
    }]
  };

  it('preserves an editable incomplete draft and normalizes response dates', () => {
    expect(adminResultRaceDetailResponseSchema.parse(response)).toMatchObject({
      race: { startsAt: '2026-09-27T06:00:00.000Z' },
      draft: { revision: 0, reason: '', entries: [{ finishPosition: null }] },
      versions: [{ confirmedAt: '2026-09-27T07:00:00.000Z' }]
    });
  });

  it('rejects staff identity and unselected race or entry data', () => {
    expect(adminResultRaceDetailResponseSchema.safeParse({
      ...response, race: { ...response.race, expertId: crypto.randomUUID() }
    }).success).toBe(false);
    expect(adminResultRaceDetailResponseSchema.safeParse({
      ...response, entries: [{ ...response.entries[0], jockey: '内部取得対象外' }]
    }).success).toBe(false);
    expect(adminResultRaceDetailResponseSchema.safeParse({
      ...response, versions: [{ ...response.versions[0], confirmedBy: crypto.randomUUID() }]
    }).success).toBe(false);
  });
});

describe('admin result mutation response contracts', () => {
  it('keeps the draft save response limited to its new revision', () => {
    expect(adminResultDraftSaveResponseSchema.parse({ revision: 2 })).toEqual({ revision: 2 });
    expect(adminResultDraftSaveResponseSchema.safeParse({ revision: 2, updatedBy: crypto.randomUUID() }).success).toBe(false);
  });

  it('preserves first confirmation and idempotent replay without internal fields', () => {
    const versionId = crypto.randomUUID();
    expect(adminResultConfirmResponseSchema.parse({ versionId, version: 2, alreadyConfirmed: false })).toEqual({ versionId, version: 2, alreadyConfirmed: false });
    expect(adminResultConfirmResponseSchema.parse({ versionId, version: 2, alreadyConfirmed: true })).toEqual({ versionId, version: 2, alreadyConfirmed: true });
    expect(adminResultConfirmResponseSchema.safeParse({ versionId, version: 2, alreadyConfirmed: false, confirmedBy: crypto.randomUUID() }).success).toBe(false);
  });
});

describe('admin result CSV import response contracts', () => {
  const issue = { row: 2, field: 'finishPosition', message: '着順を確認してください。' };
  const change = {
    key: '1番 テストホース', action: '変更' as const,
    fields: [{ field: 'finishPosition' as const, before: null, after: 1 }]
  };

  it('distinguishes rejected and accepted single-race previews', () => {
    expect(adminResultRaceImportPreviewResponseSchema.parse({ batchId: null, errors: [issue], changes: [] })).toEqual({ batchId: null, errors: [issue], changes: [] });
    const batchId = crypto.randomUUID();
    expect(adminResultRaceImportPreviewResponseSchema.parse({ batchId, expiresAt: new Date('2026-09-27T03:15:00.000Z'), errors: [], changes: [change] })).toMatchObject({ batchId, expiresAt: '2026-09-27T03:15:00.000Z' });
    expect(adminResultRaceImportPreviewResponseSchema.safeParse({ batchId, expiresAt: new Date(), errors: [], changes: [change], actorId: crypto.randomUUID() }).success).toBe(false);
  });

  it('preserves batch provenance without exposing stored rows or credentials', () => {
    const response = {
      provider: { id: 'JRA_VAN_BRIDGE_V1' as const, label: 'JRA-VAN連携ブリッジ', formatVersion: 'UMAREAL_JRA_VAN_BRIDGE_V1' },
      sourceChecksum: 'a'.repeat(64), bundle: null, sourceDisposition: 'NEW' as const, previousImport: null,
      batchId: crypto.randomUUID(), expiresAt: new Date('2026-09-27T03:15:00.000Z'), errors: [],
      races: [{ raceId: crypto.randomUUID(), key: '2026-09-27 東京 10R テストレース', targetRevision: 1, changes: [change] }]
    };
    expect(adminResultBatchImportPreviewResponseSchema.parse(response)).toMatchObject({ expiresAt: '2026-09-27T03:15:00.000Z', sourceDisposition: 'NEW' });
    expect(adminResultBatchImportPreviewResponseSchema.safeParse({ ...response, rows: [{ private: true }] }).success).toBe(false);
    expect(adminResultBatchImportPreviewResponseSchema.safeParse({ ...response, provider: { ...response.provider, accessToken: 'secret' } }).success).toBe(false);
  });

  it('preserves first confirmation and idempotent replay for both import scopes', () => {
    const batchId = crypto.randomUUID(), raceId = crypto.randomUUID();
    expect(adminResultRaceImportConfirmResponseSchema.parse({ imported: true, revision: 2, batchId, alreadyConfirmed: false })).toMatchObject({ revision: 2, alreadyConfirmed: false });
    expect(adminResultRaceImportConfirmResponseSchema.parse({ imported: true, revision: 2, batchId, alreadyConfirmed: true })).toMatchObject({ revision: 2, alreadyConfirmed: true });
    const batch = { imported: true as const, count: 1, races: [{ raceId, revision: 2 }], batchId, providerId: 'CANONICAL_CSV' as const, sourceChecksum: 'b'.repeat(64), alreadyConfirmed: false };
    expect(adminResultBatchImportConfirmResponseSchema.parse(batch)).toEqual(batch);
    expect(adminResultBatchImportConfirmResponseSchema.safeParse({ ...batch, count: 2 }).success).toBe(false);
    expect(adminResultBatchImportConfirmResponseSchema.safeParse({ ...batch, actorId: crypto.randomUUID() }).success).toBe(false);
  });
});

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
