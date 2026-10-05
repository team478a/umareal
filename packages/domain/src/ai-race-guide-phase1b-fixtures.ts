import type { AiDataLicensePolicy, AiRaceGuideFactBuilderInput, AiRaceGuideProvenance, HistoricalPerformance } from './ai-race-guide-facts';

const approvedLicense: AiDataLicensePolicy = {
  provider: 'synthetic', sourceKind: 'fixture', fieldName: '*', policyVersion: 'synthetic-license-v1',
  storageUse: 'APPROVED', derivationUse: 'APPROVED', memberDisplayUse: 'APPROVED', externalAiUse: 'PROHIBITED'
};
const reviewLicense: AiDataLicensePolicy = { ...approvedLicense, policyVersion: 'synthetic-review-v1', memberDisplayUse: 'LICENSE_REVIEW_REQUIRED' };

function provenance(reference: string, license = approvedLicense, observedAt = '2026-10-05T08:00:00Z'): AiRaceGuideProvenance {
  return { sourceProvider: 'synthetic', sourceKind: 'fixture', sourceVersion: 'phase1b-fixture-v1', sourceRecordReference: reference, observedAt, importedAt: observedAt, license };
}

const horses = Array.from({ length: 8 }, (_, index) => ({
  entryId: `10000000-0000-4000-8000-00000000000${index + 1}`,
  horseId: `20000000-0000-4000-8000-00000000000${index + 1}`,
  number: index + 1,
  horseName: index === 3 ? '同名候補' : `合成馬${index + 1}`,
  gate: index + 1,
  sex: index % 2 ? '牝' : '牡',
  age: 4,
  carriedWeight: 56,
  jockey: `騎手${index + 1}`,
  trainer: `調教師${index + 1}`,
  status: index === 4 ? 'WITHDRAWN' as const : 'ACTIVE' as const,
  provenance: provenance(`entry-${index + 1}`)
}));

function history(args: {
  horseIndex: number; raceNo: number; version?: number; confirmedAt?: string;
  status?: HistoricalPerformance['status']; finish?: number | null; license?: AiDataLicensePolicy;
}): HistoricalPerformance {
  const version = args.version ?? 1;
  const status = args.status ?? 'FINISHED';
  const suffix = String(args.raceNo).padStart(3, '0');
  const horse = horses[args.horseIndex];
  const confirmedAt = args.confirmedAt ?? '2026-10-05T08:00:00Z';
  return {
    resultVersionId: `30000000-0000-4000-800${version}-${suffix.padStart(12, '0')}`,
    resultVersion: version,
    resultConfirmedAt: confirmedAt,
    raceId: `40000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    raceEntryId: `50000000-0000-4000-800${args.horseIndex}-${suffix.padStart(12, '0')}`,
    horseId: horse.horseId,
    raceDate: `2026-09-${String(10 + args.raceNo).padStart(2, '0')}`,
    startsAt: `2026-09-${String(10 + args.raceNo).padStart(2, '0')}T06:00:00Z`,
    venue: '東京', raceClass: 'G3', surface: '芝', distance: 2000, going: '良', raceCanceled: false,
    status, finishPosition: status === 'FINISHED' ? (args.finish ?? args.raceNo) : null,
    popularity: status === 'FINISHED' ? args.raceNo : null,
    finalOdds: status === 'FINISHED' ? 2 + args.raceNo : null,
    provenance: provenance(`result-${args.horseIndex}-${args.raceNo}-v${version}`, args.license, confirmedAt)
  };
}

export function createAiRaceGuidePhase1BSyntheticFixtures(): {
  input: AiRaceGuideFactBuilderInput;
  cases: Record<'A_SUFFICIENT_HISTORY' | 'B_ONE_HISTORY' | 'C_NO_HISTORY' | 'D_SAME_NAME' | 'E_WITHDRAWN' | 'F_RESULT_CORRECTION' | 'G_FUTURE_RESULT' | 'H_LICENSE_REVIEW', string>;
  identity: { provider: string; externalKeyHash: string; observedName: string; identities: Array<{ provider: string; externalKeyHash: string; horseId: string | null }>; horses: Array<{ id: string; name: string }> };
} {
  const correctedBefore = history({ horseIndex: 5, raceNo: 4, version: 1, confirmedAt: '2026-10-05T08:00:00Z', finish: 4 });
  const correctedAfter = { ...history({ horseIndex: 5, raceNo: 4, version: 2, confirmedAt: '2026-10-05T09:30:00Z', finish: 1 }), raceId: correctedBefore.raceId, raceEntryId: correctedBefore.raceEntryId };
  const input: AiRaceGuideFactBuilderInput = {
    dataCutoffAt: '2026-10-05T09:00:00Z', logicVersion: 'phase1b-fact-rules-v1',
    targetRace: { raceId: '00000000-0000-4000-8000-000000000001', raceDate: '2026-10-05', venue: '東京', number: 11, name: '合成データ記念', startsAt: '2026-10-05T10:00:00Z', raceClass: 'G3', distance: 2000, surface: '芝', direction: '左', going: '良', fieldSize: horses.length, provenance: provenance('target-race') },
    entries: horses,
    history: [
      history({ horseIndex: 0, raceNo: 1, finish: 1 }), history({ horseIndex: 0, raceNo: 2, finish: 2 }), history({ horseIndex: 0, raceNo: 3, finish: 3 }),
      history({ horseIndex: 1, raceNo: 1, finish: 1 }),
      history({ horseIndex: 4, raceNo: 2, status: 'WITHDRAWN', finish: null }),
      correctedBefore, correctedAfter,
      history({ horseIndex: 6, raceNo: 5, confirmedAt: '2026-10-05T09:30:00Z', finish: 1 })
    ],
    pedigrees: [{ horseId: horses[7].horseId, father: '合成父', mother: '合成母', maternalGrandsire: '合成母父', provenance: provenance('pedigree-8', reviewLicense) }]
  };
  return {
    input,
    cases: {
      A_SUFFICIENT_HISTORY: horses[0].entryId,
      B_ONE_HISTORY: horses[1].entryId,
      C_NO_HISTORY: horses[2].entryId,
      D_SAME_NAME: horses[3].entryId,
      E_WITHDRAWN: horses[4].entryId,
      F_RESULT_CORRECTION: horses[5].entryId,
      G_FUTURE_RESULT: horses[6].entryId,
      H_LICENSE_REVIEW: horses[7].entryId
    },
    identity: {
      provider: 'JRA_VAN', externalKeyHash: 'a'.repeat(64), observedName: '同名候補', identities: [],
      horses: [{ id: horses[3].horseId, name: '同名候補' }]
    }
  };
}
