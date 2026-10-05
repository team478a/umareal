import { z } from 'zod';
import {
  aiRaceGuideStructuredInputSchema,
  type AiRaceGuideStructuredInput
} from './ai-race-guide';
import { dateSchema } from './races';

const dateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();

export const aiDataLicenseDecisions = ['APPROVED', 'INTERNAL_ONLY', 'LICENSE_REVIEW_REQUIRED', 'PROHIBITED'] as const;
export const aiDataLicenseDecisionSchema = z.enum(aiDataLicenseDecisions);
export const aiDataLicensePolicySchema = z.object({
  provider: z.string().trim().min(1).max(100),
  sourceKind: z.string().trim().min(1).max(100),
  fieldName: z.string().trim().min(1).max(100),
  policyVersion: z.string().trim().min(1).max(100),
  storageUse: aiDataLicenseDecisionSchema,
  derivationUse: aiDataLicenseDecisionSchema,
  memberDisplayUse: aiDataLicenseDecisionSchema,
  externalAiUse: aiDataLicenseDecisionSchema
}).strict();
export type AiDataLicensePolicy = z.infer<typeof aiDataLicensePolicySchema>;

export const aiRaceGuideProvenanceSchema = z.object({
  sourceProvider: z.string().trim().min(1).max(100),
  sourceKind: z.string().trim().min(1).max(100),
  sourceVersion: z.string().trim().min(1).max(100),
  sourceRecordReference: z.string().trim().min(1).max(200),
  observedAt: dateTime,
  importedAt: dateTime,
  license: aiDataLicensePolicySchema
}).strict();
export type AiRaceGuideProvenance = z.infer<typeof aiRaceGuideProvenanceSchema>;

const targetRaceSchema = z.object({
  raceId: uuid,
  raceDate: dateSchema,
  venue: z.string().trim().min(1).max(100),
  number: z.number().int().min(1).max(12),
  name: z.string().trim().min(1).max(200),
  startsAt: dateTime,
  raceClass: z.string().trim().min(1).max(100).nullable(),
  distance: z.number().int().positive().nullable(),
  surface: z.string().trim().min(1).max(50).nullable(),
  direction: z.string().trim().min(1).max(50).nullable(),
  going: z.string().trim().min(1).max(50).nullable(),
  fieldSize: z.number().int().min(1).max(18),
  provenance: aiRaceGuideProvenanceSchema
}).strict();

const factEntrySchema = z.object({
  entryId: uuid,
  horseId: uuid,
  number: z.number().int().min(1).max(18),
  horseName: z.string().trim().min(1).max(100),
  gate: z.number().int().min(1).max(18),
  sex: z.string().trim().min(1).max(20),
  age: z.number().int().min(2).max(30),
  carriedWeight: z.number().min(30).max(100),
  jockey: z.string().trim().min(1).max(100),
  trainer: z.string().trim().min(1).max(100),
  status: z.enum(['ACTIVE', 'WITHDRAWN', 'EXCLUDED']),
  provenance: aiRaceGuideProvenanceSchema
}).strict();

export const historicalPerformanceSchema = z.object({
  resultVersionId: uuid,
  resultVersion: z.number().int().positive(),
  resultConfirmedAt: dateTime,
  raceId: uuid,
  raceEntryId: uuid,
  horseId: uuid,
  raceDate: dateSchema,
  startsAt: dateTime,
  venue: z.string().trim().min(1).max(100),
  raceClass: z.string().trim().min(1).max(100).nullable(),
  surface: z.string().trim().min(1).max(50).nullable(),
  distance: z.number().int().positive().nullable(),
  going: z.string().trim().min(1).max(50).nullable(),
  raceCanceled: z.boolean(),
  status: z.enum(['FINISHED', 'WITHDRAWN', 'EXCLUDED', 'DNF', 'CANCELED']),
  finishPosition: z.number().int().min(1).max(18).nullable(),
  popularity: z.number().int().min(1).max(18).nullable(),
  finalOdds: z.number().positive().nullable(),
  provenance: aiRaceGuideProvenanceSchema
}).strict();
export type HistoricalPerformance = z.infer<typeof historicalPerformanceSchema>;

const pedigreeSchema = z.object({
  horseId: uuid,
  father: z.string().trim().min(1).max(100),
  mother: z.string().trim().min(1).max(100),
  maternalGrandsire: z.string().trim().min(1).max(100),
  provenance: aiRaceGuideProvenanceSchema
}).strict();

export const aiRaceGuideFactBuilderInputSchema = z.object({
  dataCutoffAt: dateTime,
  logicVersion: z.string().trim().min(1).max(100),
  targetRace: targetRaceSchema,
  entries: z.array(factEntrySchema).min(1).max(18),
  history: z.array(historicalPerformanceSchema).max(1000),
  pedigrees: z.array(pedigreeSchema).max(18).default([])
}).strict().superRefine((value, ctx) => {
  if (new Date(value.dataCutoffAt) >= new Date(value.targetRace.startsAt)) {
    ctx.addIssue({ code: 'custom', path: ['dataCutoffAt'], message: '事前Factのcutoffは対象レース発走前である必要があります。' });
  }
  const horseIds = new Set(value.entries.map(entry => entry.horseId));
  value.history.forEach((row, index) => {
    if (!horseIds.has(row.horseId)) ctx.addIssue({ code: 'custom', path: ['history', index, 'horseId'], message: '対象出走馬の過去走だけを指定してください。' });
  });
});
export type AiRaceGuideFactBuilderInput = z.infer<typeof aiRaceGuideFactBuilderInputSchema>;

export const aiRaceGuideCoverageStatuses = ['AVAILABLE', 'PARTIAL', 'NOT_AVAILABLE', 'LICENSE_REVIEW_REQUIRED'] as const;
export const aiRaceGuideDataCoverageSchema = z.object({
  category: z.enum(['RACE_DATA', 'ENTRY_DATA', 'PAST_RACES', 'PEDIGREE', 'TRAINING']),
  status: z.enum(aiRaceGuideCoverageStatuses),
  availableCount: z.number().int().nonnegative(),
  requiredCount: z.number().int().nonnegative(),
  note: z.string().trim().min(1).max(300)
}).strict();

export const aiRaceGuideDataCoverageResponseSchema = z.object({
  raceId: uuid,
  dataCutoffAt: dateTime,
  logicVersion: z.string().trim().min(1).max(100),
  coverage: z.array(aiRaceGuideDataCoverageSchema),
  factStates: z.object({
    known: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    insufficientData: z.number().int().nonnegative(),
    notAvailable: z.number().int().nonnegative()
  }).strict(),
  boundaries: z.object({
    assessmentExcluded: z.literal(true),
    predictionExcluded: z.literal(true),
    expertCommentExcluded: z.literal(true),
    userDataExcluded: z.literal(true),
    futureDataExcluded: z.literal(true),
    externalAiCommunication: z.literal(false)
  }).strict()
}).strict();
export type AiRaceGuideDataCoverageResponse = z.infer<typeof aiRaceGuideDataCoverageResponseSchema>;

export const aiRaceGuideFactBundleSchema = z.object({
  dataCutoffAt: dateTime,
  logicVersion: z.string().trim().min(1).max(100),
  sources: z.array(z.object({
    sourceId: z.string().min(1),
    sourceProvider: z.string().min(1),
    sourceKind: z.enum(['RACE', 'RACE_ENTRY', 'RACE_RESULT', 'LICENSED_DATASET']),
    sourceVersion: z.string().min(1),
    licensePolicyVersion: z.string().min(1),
    derivationApproved: z.boolean(),
    memberDisplayApproved: z.boolean(),
    externalAiApproved: z.boolean()
  }).strict()).min(1),
  evidence: z.array(z.object({
    evidenceId: z.string().min(1),
    sourceId: z.string().min(1),
    sourceProvider: z.string().min(1),
    sourceKind: z.string().min(1),
    sourceVersion: z.string().min(1),
    sourceRecordReference: z.string().min(1),
    observedAt: dateTime,
    importedAt: dateTime,
    dataCutoffAt: dateTime,
    logicVersion: z.string().min(1)
  }).strict()),
  facts: z.array(z.object({
    factId: z.string().min(1),
    category: z.enum(['RACE_OVERVIEW', 'ATTENTION_MATERIAL', 'COURSE_SUITABILITY', 'DISTANCE_SUITABILITY', 'GOING_SUITABILITY', 'PEDIGREE_REFERENCE', 'RECENT_PERFORMANCE', 'RACE_COMPLEXITY']),
    entryId: uuid.optional(),
    state: z.enum(['KNOWN', 'UNKNOWN', 'INSUFFICIENT_DATA', 'NOT_AVAILABLE']),
    value: z.unknown().optional(),
    reasonCode: z.string().min(1).optional(),
    evidenceIds: z.array(z.string()),
    sampleSize: z.number().int().nonnegative(),
    dataCutoffAt: dateTime,
    logicVersion: z.string().min(1)
  }).strict().superRefine((fact, ctx) => {
    if (fact.state === 'KNOWN' && fact.value === undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'KNOWNにはvalueが必要です。' });
    if (fact.state !== 'KNOWN' && !fact.reasonCode) ctx.addIssue({ code: 'custom', path: ['reasonCode'], message: '欠損状態にはreasonCodeが必要です。' });
  })).min(1),
  coverage: z.array(aiRaceGuideDataCoverageSchema)
}).strict();
export type AiRaceGuideFactBundle = z.infer<typeof aiRaceGuideFactBundleSchema>;

export const aiRaceGuideFactMinimumSamples = Object.freeze({
  RECENT_PERFORMANCE: 1,
  DISTANCE_SUITABILITY: 3,
  COURSE_SUITABILITY: 3,
  GOING_SUITABILITY: 3,
  SURFACE_HISTORY: 3,
  CLASS_HISTORY: 3
});

type BundleFact = AiRaceGuideFactBundle['facts'][number];

function approvedForFacts(provenance: AiRaceGuideProvenance) {
  return provenance.license.storageUse === 'APPROVED' && provenance.license.derivationUse === 'APPROVED' && provenance.license.memberDisplayUse === 'APPROVED';
}

function latestEligibleHistory(input: AiRaceGuideFactBuilderInput) {
  const cutoff = new Date(input.dataCutoffAt).getTime();
  const targetStart = new Date(input.targetRace.startsAt).getTime();
  const candidates = input.history.filter(row =>
    row.raceId !== input.targetRace.raceId &&
    new Date(row.startsAt).getTime() < targetStart &&
    new Date(row.resultConfirmedAt).getTime() <= cutoff &&
    new Date(row.provenance.observedAt).getTime() <= cutoff &&
    new Date(row.provenance.importedAt).getTime() <= cutoff &&
    approvedForFacts(row.provenance)
  );
  const latest = new Map<string, HistoricalPerformance>();
  for (const row of candidates) {
    const key = `${row.raceId}:${row.horseId}`;
    const current = latest.get(key);
    if (!current || row.resultVersion > current.resultVersion || (row.resultVersion === current.resultVersion && row.resultConfirmedAt > current.resultConfirmedAt)) latest.set(key, row);
  }
  return [...latest.values()];
}

function aggregateFact(args: {
  factId: string;
  category: BundleFact['category'];
  entryId: string;
  rows: HistoricalPerformance[];
  minimum: number;
  condition: Record<string, string | number>;
  dataCutoffAt: string;
  logicVersion: string;
  evidenceId: (row: HistoricalPerformance) => string;
}): BundleFact {
  const finished = args.rows.filter(row => row.status === 'FINISHED' && row.finishPosition !== null);
  const evidenceIds = args.rows.map(args.evidenceId);
  if (!args.rows.length) return { factId: args.factId, category: args.category, entryId: args.entryId, state: 'UNKNOWN', reasonCode: 'NO_MATCHING_HISTORY', evidenceIds: [], sampleSize: 0, dataCutoffAt: args.dataCutoffAt, logicVersion: args.logicVersion };
  if (finished.length < args.minimum) return { factId: args.factId, category: args.category, entryId: args.entryId, state: 'INSUFFICIENT_DATA', reasonCode: 'MINIMUM_SAMPLE_NOT_MET', evidenceIds, sampleSize: finished.length, dataCutoffAt: args.dataCutoffAt, logicVersion: args.logicVersion };
  const finishTotal = finished.reduce((sum, row) => sum + (row.finishPosition ?? 0), 0);
  return {
    factId: args.factId,
    category: args.category,
    entryId: args.entryId,
    state: 'KNOWN',
    value: {
      condition: args.condition,
      starts: finished.length,
      wins: finished.filter(row => row.finishPosition === 1).length,
      top3: finished.filter(row => (row.finishPosition ?? 99) <= 3).length,
      averageFinish: Number((finishTotal / finished.length).toFixed(2))
    },
    evidenceIds,
    sampleSize: finished.length,
    dataCutoffAt: args.dataCutoffAt,
    logicVersion: args.logicVersion
  };
}

export function buildAiRaceGuideFacts(inputValue: unknown): AiRaceGuideFactBundle {
  const input = aiRaceGuideFactBuilderInputSchema.parse(inputValue);
  const eligible = latestEligibleHistory(input);
  const evidence = new Map<string, AiRaceGuideFactBundle['evidence'][number]>();
  const sources = new Map<string, AiRaceGuideFactBundle['sources'][number]>();
  const register = (provenance: AiRaceGuideProvenance, reference: string, kind: 'RACE' | 'RACE_ENTRY' | 'RACE_RESULT' | 'LICENSED_DATASET') => {
    const sourceId = `source:${provenance.sourceProvider}:${kind}:${provenance.sourceVersion}`;
    sources.set(sourceId, {
      sourceId,
      sourceProvider: provenance.sourceProvider,
      sourceKind: kind,
      sourceVersion: provenance.sourceVersion,
      licensePolicyVersion: provenance.license.policyVersion,
      derivationApproved: provenance.license.storageUse === 'APPROVED' && provenance.license.derivationUse === 'APPROVED',
      memberDisplayApproved: provenance.license.memberDisplayUse === 'APPROVED',
      externalAiApproved: provenance.license.externalAiUse === 'APPROVED'
    });
    const evidenceId = `evidence:${provenance.sourceProvider}:${reference}`;
    evidence.set(evidenceId, { evidenceId, sourceId, sourceProvider: provenance.sourceProvider, sourceKind: provenance.sourceKind, sourceVersion: provenance.sourceVersion, sourceRecordReference: provenance.sourceRecordReference, observedAt: provenance.observedAt, importedAt: provenance.importedAt, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion });
    return evidenceId;
  };
  const raceEvidenceId = register(input.targetRace.provenance, input.targetRace.raceId, 'RACE');
  const entryEvidence = new Map(input.entries.map(entry => [entry.entryId, register(entry.provenance, entry.entryId, 'RACE_ENTRY')]));
  const performanceEvidence = new Map(eligible.map(row => [row.resultVersionId + ':' + row.raceEntryId, register(row.provenance, `${row.resultVersionId}:${row.raceEntryId}`, 'RACE_RESULT')]));
  const evidenceIdFor = (row: HistoricalPerformance) => performanceEvidence.get(row.resultVersionId + ':' + row.raceEntryId)!;
  const facts: BundleFact[] = [{
    factId: `fact:race:${input.targetRace.raceId}`,
    category: 'RACE_OVERVIEW', state: 'KNOWN',
    value: { venue: input.targetRace.venue, raceNumber: input.targetRace.number, raceName: input.targetRace.name, startsAt: input.targetRace.startsAt, raceClass: input.targetRace.raceClass ?? 'UNKNOWN', surface: input.targetRace.surface ?? 'UNKNOWN', distance: input.targetRace.distance ?? 'UNKNOWN', direction: input.targetRace.direction ?? 'UNKNOWN', going: input.targetRace.going ?? 'UNKNOWN', fieldSize: input.targetRace.fieldSize },
    evidenceIds: [raceEvidenceId], sampleSize: 1, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion
  }];

  for (const entry of input.entries) {
    const history = eligible.filter(row => row.horseId === entry.horseId).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
    const recent = history.filter(row => !['WITHDRAWN', 'EXCLUDED', 'CANCELED'].includes(row.status)).slice(0, 5);
    const recentEvidence = recent.map(evidenceIdFor);
    facts.push(recent.length ? {
      factId: `fact:recent:${entry.entryId}`, category: 'RECENT_PERFORMANCE', entryId: entry.entryId, state: 'KNOWN',
      value: { races: recent.map(row => ({ raceDate: row.raceDate, venue: row.venue, surface: row.surface ?? 'UNKNOWN', distance: row.distance ?? 'UNKNOWN', going: row.going ?? 'UNKNOWN', status: row.status, finishPosition: row.finishPosition ?? 'NOT_FINISHED', popularity: row.popularity ?? 'UNKNOWN', finalOdds: row.finalOdds ?? 'UNKNOWN' })) },
      evidenceIds: recentEvidence, sampleSize: recent.length, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion
    } : {
      factId: `fact:recent:${entry.entryId}`, category: 'RECENT_PERFORMANCE', entryId: entry.entryId, state: 'UNKNOWN', reasonCode: 'NO_HISTORY', evidenceIds: [], sampleSize: 0, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion
    });
    facts.push(aggregateFact({ factId: `fact:distance:${entry.entryId}`, category: 'DISTANCE_SUITABILITY', entryId: entry.entryId, rows: history.filter(row => row.distance === input.targetRace.distance), minimum: aiRaceGuideFactMinimumSamples.DISTANCE_SUITABILITY, condition: { distance: input.targetRace.distance ?? 'UNKNOWN' }, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion, evidenceId: evidenceIdFor }));
    facts.push(aggregateFact({ factId: `fact:course:${entry.entryId}`, category: 'COURSE_SUITABILITY', entryId: entry.entryId, rows: history.filter(row => row.venue === input.targetRace.venue), minimum: aiRaceGuideFactMinimumSamples.COURSE_SUITABILITY, condition: { venue: input.targetRace.venue }, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion, evidenceId: evidenceIdFor }));
    facts.push(aggregateFact({ factId: `fact:going:${entry.entryId}`, category: 'GOING_SUITABILITY', entryId: entry.entryId, rows: history.filter(row => !!input.targetRace.going && row.going === input.targetRace.going), minimum: aiRaceGuideFactMinimumSamples.GOING_SUITABILITY, condition: { going: input.targetRace.going ?? 'UNKNOWN' }, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion, evidenceId: evidenceIdFor }));
    facts.push(aggregateFact({ factId: `fact:surface:${entry.entryId}`, category: 'ATTENTION_MATERIAL', entryId: entry.entryId, rows: history.filter(row => !!input.targetRace.surface && row.surface === input.targetRace.surface), minimum: aiRaceGuideFactMinimumSamples.SURFACE_HISTORY, condition: { surface: input.targetRace.surface ?? 'UNKNOWN' }, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion, evidenceId: evidenceIdFor }));
    facts.push(aggregateFact({ factId: `fact:class:${entry.entryId}`, category: 'ATTENTION_MATERIAL', entryId: entry.entryId, rows: history.filter(row => !!input.targetRace.raceClass && row.raceClass === input.targetRace.raceClass), minimum: aiRaceGuideFactMinimumSamples.CLASS_HISTORY, condition: { raceClass: input.targetRace.raceClass ?? 'UNKNOWN' }, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion, evidenceId: evidenceIdFor }));
    const pedigree = input.pedigrees.find(item => item.horseId === entry.horseId && approvedForFacts(item.provenance));
    if (pedigree) {
      const pedigreeEvidence = register(pedigree.provenance, `pedigree:${entry.horseId}`, 'LICENSED_DATASET');
      facts.push({ factId: `fact:pedigree:${entry.entryId}`, category: 'PEDIGREE_REFERENCE', entryId: entry.entryId, state: 'KNOWN', value: { father: pedigree.father, mother: pedigree.mother, maternalGrandsire: pedigree.maternalGrandsire }, evidenceIds: [pedigreeEvidence], sampleSize: 1, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion });
    } else {
      const blocked = input.pedigrees.find(item => item.horseId === entry.horseId);
      facts.push({ factId: `fact:pedigree:${entry.entryId}`, category: 'PEDIGREE_REFERENCE', entryId: entry.entryId, state: 'NOT_AVAILABLE', reasonCode: blocked ? 'LICENSE_REVIEW_REQUIRED' : 'PEDIGREE_NOT_AVAILABLE', evidenceIds: [], sampleSize: 0, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion });
    }
    facts.push({ factId: `fact:completeness:${entry.entryId}`, category: 'RACE_COMPLEXITY', entryId: entry.entryId, state: 'KNOWN', value: { completedPastRaces: history.filter(row => row.status === 'FINISHED').length, historyFieldsAvailable: ['raceDate', 'venue', 'surface', 'distance', 'going', 'finishPosition', 'popularity', 'finalOdds'].filter(field => history.some(row => (row as unknown as Record<string, unknown>)[field] !== null)).length, historyFieldsRequired: 8 }, evidenceIds: [...history.map(evidenceIdFor), entryEvidence.get(entry.entryId)!], sampleSize: history.length, dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion });
  }

  const histories = input.entries.map(entry => eligible.filter(row => row.horseId === entry.horseId && row.status === 'FINISHED').length);
  const approvedPedigrees = input.pedigrees.filter(item => approvedForFacts(item.provenance)).length;
  const blockedPedigree = input.pedigrees.some(item => !approvedForFacts(item.provenance));
  const coverage = [
    { category: 'RACE_DATA' as const, status: approvedForFacts(input.targetRace.provenance) ? 'AVAILABLE' as const : 'LICENSE_REVIEW_REQUIRED' as const, availableCount: approvedForFacts(input.targetRace.provenance) ? 1 : 0, requiredCount: 1, note: '開催日・場・番号・条件・発走時刻を確認します。' },
    { category: 'ENTRY_DATA' as const, status: input.entries.every(entry => approvedForFacts(entry.provenance)) ? 'AVAILABLE' as const : 'LICENSE_REVIEW_REQUIRED' as const, availableCount: input.entries.filter(entry => approvedForFacts(entry.provenance)).length, requiredCount: input.entries.length, note: '出走馬の基本項目を確認します。' },
    { category: 'PAST_RACES' as const, status: histories.every(count => count >= 3) ? 'AVAILABLE' as const : histories.some(count => count > 0) ? 'PARTIAL' as const : 'NOT_AVAILABLE' as const, availableCount: histories.filter(count => count >= 3).length, requiredCount: input.entries.length, note: '各馬3件以上の確定済み過去走を基準にします。' },
    { category: 'PEDIGREE' as const, status: blockedPedigree ? 'LICENSE_REVIEW_REQUIRED' as const : approvedPedigrees === input.entries.length ? 'AVAILABLE' as const : approvedPedigrees ? 'PARTIAL' as const : 'NOT_AVAILABLE' as const, availableCount: approvedPedigrees, requiredCount: input.entries.length, note: 'Phase 1Bではsyntheticまたは許諾済みデータだけを扱います。' },
    { category: 'TRAINING' as const, status: 'NOT_AVAILABLE' as const, availableCount: 0, requiredCount: input.entries.length, note: '調教・追切は将来候補でありV1対象外です。' }
  ];
  return aiRaceGuideFactBundleSchema.parse({ dataCutoffAt: input.dataCutoffAt, logicVersion: input.logicVersion, sources: [...sources.values()], evidence: [...evidence.values()], facts, coverage });
}

const forbiddenPayloadKeys = new Set(['assessment', 'assessmentVersion', 'prediction', 'predictionVersion', 'mikuniyacomment', 'user', 'member', 'administrator', 'internalmemo']);
function assertNoForbiddenPayload(value: unknown, path = ''): void {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoForbiddenPayload(item, `${path}.${index}`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenPayloadKeys.has(key.replace(/[^a-z]/gi, '').toLowerCase())) throw new Error(`AI_FACT_PAYLOAD_FORBIDDEN_FIELD:${path}.${key}`);
    assertNoForbiddenPayload(child, `${path}.${key}`);
  }
}

export function projectFactBundleToStructuredInput(args: {
  bundle: AiRaceGuideFactBundle;
  raceId: string;
  raceDate: string;
  entries: Array<{ entryId: string; horseId: string; number: number; horseName: string }>;
  promptVersion: string;
  sourceVersion: string;
  processingMode?: 'DETERMINISTIC_TEST' | 'EXTERNAL_LLM';
}): AiRaceGuideStructuredInput {
  const bundle = aiRaceGuideFactBundleSchema.parse(args.bundle);
  assertNoForbiddenPayload(bundle);
  const processingMode = args.processingMode ?? 'DETERMINISTIC_TEST';
  if (bundle.sources.some(source => !source.derivationApproved)) throw new Error('AI_FACT_DERIVATION_LICENSE_DENIED');
  if (bundle.sources.some(source => !source.memberDisplayApproved)) throw new Error('AI_FACT_MEMBER_DISPLAY_LICENSE_DENIED');
  if (processingMode === 'EXTERNAL_LLM' && bundle.sources.some(source => !source.externalAiApproved)) throw new Error('AI_FACT_EXTERNAL_AI_LICENSE_DENIED');
  return aiRaceGuideStructuredInputSchema.parse({
    formatVersion: 1,
    kind: 'PRE_RACE',
    processingMode,
    raceId: args.raceId,
    raceDate: args.raceDate,
    dataCutoffAt: bundle.dataCutoffAt,
    logicVersion: bundle.logicVersion,
    promptVersion: args.promptVersion,
    sourceVersion: args.sourceVersion,
    entries: args.entries,
    sources: bundle.sources.map(source => ({ sourceId: source.sourceId, kind: source.sourceKind, sourceProvider: source.sourceProvider, sourceVersion: source.sourceVersion, licenseDecision: 'APPROVED', allowedUses: processingMode === 'EXTERNAL_LLM' ? ['GUIDE_GENERATION', 'MEMBER_DISPLAY', 'EXTERNAL_AI_PROCESSING'] : ['GUIDE_GENERATION', 'MEMBER_DISPLAY'], licensePolicyVersion: source.licensePolicyVersion })),
    evidence: bundle.evidence.map(item => ({ evidenceId: item.evidenceId, sourceId: item.sourceId, sourceRecordId: item.sourceRecordReference, sourceProvider: item.sourceProvider, sourceKind: item.sourceKind, sourceRecordReference: item.sourceRecordReference, sourceVersion: item.sourceVersion, observedAt: item.observedAt, importedAt: item.importedAt, dataCutoffAt: item.dataCutoffAt, logicVersion: item.logicVersion })),
    facts: bundle.facts.map(fact => fact.state === 'KNOWN'
      ? { factId: fact.factId, category: fact.category, entryId: fact.entryId, state: fact.state, value: fact.value, evidenceIds: fact.evidenceIds, sampleSize: fact.sampleSize, dataCutoffAt: fact.dataCutoffAt, logicVersion: fact.logicVersion }
      : { factId: fact.factId, category: fact.category, entryId: fact.entryId, state: fact.state, reasonCode: fact.reasonCode, evidenceIds: fact.evidenceIds, sampleSize: fact.sampleSize, dataCutoffAt: fact.dataCutoffAt, logicVersion: fact.logicVersion })
  });
}

export const horseIdentityMatchStatuses = ['MATCHED', 'POSSIBLE_DUPLICATE', 'UNRESOLVED'] as const;
export function resolveHorseExternalIdentity(args: {
  provider: string;
  externalKeyHash: string;
  observedName: string;
  identities: Array<{ provider: string; externalKeyHash: string; horseId: string | null }>;
  horses: Array<{ id: string; name: string }>;
}) {
  const exact = args.identities.filter(identity => identity.provider === args.provider && identity.externalKeyHash === args.externalKeyHash);
  const normalizedName = args.observedName.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ja-JP');
  const nameCandidates = args.horses.filter(horse => horse.name.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ja-JP') === normalizedName).map(horse => horse.id);
  if (exact.length) return { status: exact.length === 1 && exact[0].horseId ? 'MATCHED' as const : 'UNRESOLVED' as const, horseId: exact.length === 1 ? exact[0].horseId : null, candidateHorseIds: [...new Set(exact.map(item => item.horseId).filter((id): id is string => !!id))], duplicateIdentity: exact.length > 1 };
  if (nameCandidates.length) return { status: 'POSSIBLE_DUPLICATE' as const, horseId: null, candidateHorseIds: nameCandidates, duplicateIdentity: false };
  return { status: 'UNRESOLVED' as const, horseId: null, candidateHorseIds: [], duplicateIdentity: false };
}
