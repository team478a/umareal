import { z } from 'zod';
import { dateSchema } from './races';

const dateTime = z.string().datetime({ offset: true });
const stableId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/);

export const aiRaceGuideFactStates = ['KNOWN', 'UNKNOWN', 'INSUFFICIENT_DATA', 'NOT_AVAILABLE'] as const;
export const aiRaceGuideSourceKinds = ['RACE', 'HORSE', 'RACE_ENTRY', 'RACE_RESULT', 'LICENSED_DATASET', 'DERIVED_RULE'] as const;
export const aiRaceGuideDataUses = ['GUIDE_GENERATION', 'MEMBER_DISPLAY', 'EXTERNAL_AI_PROCESSING'] as const;
export const aiRaceGuideFactCategories = [
  'RACE_OVERVIEW', 'ATTENTION_MATERIAL', 'POSITIVE_FACTOR', 'CAUTION_FACTOR',
  'COURSE_SUITABILITY', 'DISTANCE_SUITABILITY', 'GOING_SUITABILITY', 'PEDIGREE_REFERENCE',
  'RECENT_PERFORMANCE', 'PACE_REFERENCE', 'RACE_COMPLEXITY', 'PADDOCK_CHECK_POINT'
] as const;
export const aiRaceGuideSectionKinds = [
  'RACE_OVERVIEW', 'ATTENTION_MATERIALS', 'ATTENTION_HORSES', 'POSITIVE_FACTORS',
  'CAUTION_FACTORS', 'COURSE_SUITABILITY', 'DISTANCE_SUITABILITY', 'GOING_SUITABILITY',
  'PEDIGREE_REFERENCES', 'RECENT_PERFORMANCE', 'PACE_REFERENCES', 'RACE_COMPLEXITY',
  'PADDOCK_CHECK_POINTS'
] as const;

export type AiRaceGuideJsonValue = boolean | number | string | AiRaceGuideJsonValue[] | { [key: string]: AiRaceGuideJsonValue };
const jsonValueSchema: z.ZodType<AiRaceGuideJsonValue> = z.lazy(() => z.union([
  z.boolean(), z.number().finite(), z.string().max(5000),
  z.array(jsonValueSchema).max(100), z.record(jsonValueSchema)
]));

export const aiRaceGuideSourceSchema = z.object({
  sourceId: stableId,
  kind: z.enum(aiRaceGuideSourceKinds),
  sourceProvider: z.string().trim().min(1).max(100).optional(),
  sourceVersion: z.string().trim().min(1).max(100),
  licenseDecision: z.literal('APPROVED'),
  allowedUses: z.array(z.enum(aiRaceGuideDataUses)).min(1).max(aiRaceGuideDataUses.length),
  licensePolicyVersion: z.string().trim().min(1).max(100).optional()
}).strict().superRefine((value, ctx) => {
  if (new Set(value.allowedUses).size !== value.allowedUses.length) {
    ctx.addIssue({ code: 'custom', path: ['allowedUses'], message: 'allowedUsesが重複しています。' });
  }
  for (const required of ['GUIDE_GENERATION', 'MEMBER_DISPLAY'] as const) {
    if (!value.allowedUses.includes(required)) ctx.addIssue({ code: 'custom', path: ['allowedUses'], message: `${required}の許諾が必要です。` });
  }
});

export const aiRaceGuideEvidenceSchema = z.object({
  evidenceId: stableId,
  sourceId: stableId,
  sourceRecordId: z.string().trim().min(1).max(200).optional(),
  sourceProvider: z.string().trim().min(1).max(100).optional(),
  sourceKind: z.string().trim().min(1).max(100).optional(),
  sourceRecordReference: z.string().trim().min(1).max(200).optional(),
  sourceVersion: z.string().trim().min(1).max(100),
  observedAt: dateTime,
  importedAt: dateTime.optional(),
  dataCutoffAt: dateTime.optional(),
  logicVersion: z.string().trim().min(1).max(100).optional()
}).strict();

const factBase = z.object({
  factId: stableId,
  category: z.enum(aiRaceGuideFactCategories),
  entryId: z.string().uuid().optional(),
  sampleSize: z.number().int().nonnegative().optional(),
  dataCutoffAt: dateTime.optional(),
  logicVersion: z.string().trim().min(1).max(100).optional()
});
const knownFact = factBase.extend({
  state: z.literal('KNOWN'),
  value: jsonValueSchema,
  unit: z.string().trim().min(1).max(30).optional(),
  evidenceIds: z.array(stableId).min(1).max(30)
}).strict();
const unavailableFact = factBase.extend({
  state: z.enum(['UNKNOWN', 'INSUFFICIENT_DATA', 'NOT_AVAILABLE']),
  reasonCode: stableId,
  evidenceIds: z.array(stableId).max(30).default([])
}).strict();
export const aiRaceGuideFactSchema = z.discriminatedUnion('state', [knownFact, unavailableFact]);

export const aiRaceGuideStructuredInputSchema = z.object({
  formatVersion: z.literal(1),
  kind: z.literal('PRE_RACE'),
  processingMode: z.enum(['DETERMINISTIC_TEST', 'EXTERNAL_LLM']),
  raceId: z.string().uuid(),
  raceDate: dateSchema,
  dataCutoffAt: dateTime,
  logicVersion: z.string().trim().min(1).max(100),
  promptVersion: z.string().trim().min(1).max(100),
  sourceVersion: z.string().trim().min(1).max(100),
  entries: z.array(z.object({
    entryId: z.string().uuid(), horseId: z.string().uuid(), number: z.number().int().min(1).max(18), horseName: z.string().trim().min(1).max(100)
  }).strict()).min(1).max(18),
  sources: z.array(aiRaceGuideSourceSchema).min(1).max(50),
  evidence: z.array(aiRaceGuideEvidenceSchema).min(1).max(2000),
  facts: z.array(aiRaceGuideFactSchema).min(1).max(2000)
}).strict().superRefine((value, ctx) => {
  const cutoff = new Date(value.dataCutoffAt).getTime();
  const sourceById = new Map(value.sources.map(source => [source.sourceId, source]));
  const evidenceById = new Map(value.evidence.map(item => [item.evidenceId, item]));
  const entryIds = new Set(value.entries.map(entry => entry.entryId));
  addDuplicateIssues(value.sources.map(v => v.sourceId), ['sources'], 'sourceId', ctx);
  addDuplicateIssues(value.evidence.map(v => v.evidenceId), ['evidence'], 'evidenceId', ctx);
  addDuplicateIssues(value.facts.map(v => v.factId), ['facts'], 'factId', ctx);
  addDuplicateIssues(value.entries.map(v => v.entryId), ['entries'], 'entryId', ctx);
  addDuplicateIssues(value.entries.map(v => v.horseId), ['entries'], 'horseId', ctx);
  addDuplicateIssues(value.entries.map(v => v.number), ['entries'], 'number', ctx);

  value.evidence.forEach((evidence, index) => {
    const source = sourceById.get(evidence.sourceId);
    if (!source) ctx.addIssue({ code: 'custom', path: ['evidence', index, 'sourceId'], message: '存在するsourceIdを指定してください。' });
    else if (source.sourceVersion !== evidence.sourceVersion) ctx.addIssue({ code: 'custom', path: ['evidence', index, 'sourceVersion'], message: 'sourceVersionがsourceと一致しません。' });
    if (new Date(evidence.observedAt).getTime() > cutoff) ctx.addIssue({ code: 'custom', path: ['evidence', index, 'observedAt'], message: 'dataCutoffAtより後の根拠は使用できません。' });
    if (evidence.importedAt && new Date(evidence.importedAt).getTime() > cutoff) ctx.addIssue({ code: 'custom', path: ['evidence', index, 'importedAt'], message: 'dataCutoffAtより後に取り込まれた根拠は使用できません。' });
    if (evidence.dataCutoffAt && evidence.dataCutoffAt !== value.dataCutoffAt) ctx.addIssue({ code: 'custom', path: ['evidence', index, 'dataCutoffAt'], message: 'evidenceのdataCutoffAtが入力と一致しません。' });
  });

  value.facts.forEach((fact, index) => {
    if (new Set(fact.evidenceIds).size !== fact.evidenceIds.length) ctx.addIssue({ code: 'custom', path: ['facts', index, 'evidenceIds'], message: 'evidenceIdが重複しています。' });
    if (fact.entryId && !entryIds.has(fact.entryId)) ctx.addIssue({ code: 'custom', path: ['facts', index, 'entryId'], message: '存在するentryIdを指定してください。' });
    if (fact.dataCutoffAt && fact.dataCutoffAt !== value.dataCutoffAt) ctx.addIssue({ code: 'custom', path: ['facts', index, 'dataCutoffAt'], message: 'factのdataCutoffAtが入力と一致しません。' });
    if (fact.logicVersion && fact.logicVersion !== value.logicVersion) ctx.addIssue({ code: 'custom', path: ['facts', index, 'logicVersion'], message: 'factのlogicVersionが入力と一致しません。' });
    const refs = fact.evidenceIds.map(id => evidenceById.get(id));
    if (refs.some(ref => !ref)) ctx.addIssue({ code: 'custom', path: ['facts', index, 'evidenceIds'], message: '存在するevidenceIdだけを指定してください。' });
    if (fact.state === 'KNOWN' && refs.every(ref => ref && sourceById.get(ref.sourceId)?.kind === 'DERIVED_RULE')) {
      ctx.addIssue({ code: 'custom', path: ['facts', index, 'evidenceIds'], message: '既知factには元データの根拠が必要です。' });
    }
  });

  if (value.processingMode === 'EXTERNAL_LLM') {
    value.sources.forEach((source, index) => {
      if (!source.allowedUses.includes('EXTERNAL_AI_PROCESSING')) {
        ctx.addIssue({ code: 'custom', path: ['sources', index, 'allowedUses'], message: '外部AI処理の許諾がありません。' });
      }
    });
  }
});
export type AiRaceGuideStructuredInput = z.infer<typeof aiRaceGuideStructuredInputSchema>;

const statementSchema = z.object({
  statementId: stableId,
  text: z.string().trim().min(1).max(500),
  factIds: z.array(stableId).min(1).max(20),
  entryIds: z.array(z.string().uuid()).max(18).default([])
}).strict().superRefine((value, ctx) => {
  if (new Set(value.factIds).size !== value.factIds.length) ctx.addIssue({ code: 'custom', path: ['factIds'], message: 'factIdが重複しています。' });
  if (new Set(value.entryIds).size !== value.entryIds.length) ctx.addIssue({ code: 'custom', path: ['entryIds'], message: 'entryIdが重複しています。' });
});

export const aiRaceGuideGeneratedOutputSchema = z.object({
  formatVersion: z.literal(1),
  sections: z.array(z.object({
    kind: z.enum(aiRaceGuideSectionKinds),
    statements: z.array(statementSchema).min(1).max(50)
  }).strict()).min(1).max(aiRaceGuideSectionKinds.length)
}).strict().superRefine((value, ctx) => {
  addDuplicateIssues(value.sections.map(section => section.kind), ['sections'], 'kind', ctx);
  addDuplicateIssues(value.sections.flatMap(section => section.statements.map(statement => statement.statementId)), ['sections'], 'statementId', ctx);
});
export type AiRaceGuideGeneratedOutput = z.infer<typeof aiRaceGuideGeneratedOutputSchema>;

export type AiRaceGuideValidationResult = { valid: true; output: AiRaceGuideGeneratedOutput } | { valid: false; issues: string[] };
const forbiddenNarrative = /(買い目|自動投票|購入金額|勝率|的中率|期待利益|利益予測|利益保証|的中保証|必ず勝|絶対に勝|本命|対抗|単勝|複勝|馬連|馬単|ワイド|三連複|三連単|三国谷氏?(?:が言った|の発言|の予想|の評価))/;

export function validateAiRaceGuideGeneratedOutput(inputValue: unknown, outputValue: unknown): AiRaceGuideValidationResult {
  const input = aiRaceGuideStructuredInputSchema.safeParse(inputValue);
  const output = aiRaceGuideGeneratedOutputSchema.safeParse(outputValue);
  const issues: string[] = [];
  if (!input.success) issues.push(...input.error.issues.map(issue => `input:${issue.path.join('.')}:${issue.message}`));
  if (!output.success) issues.push(...output.error.issues.map(issue => `output:${issue.path.join('.')}:${issue.message}`));
  if (!input.success || !output.success) return { valid: false, issues };

  const factById = new Map(input.data.facts.map(fact => [fact.factId, fact]));
  const entryIds = new Set(input.data.entries.map(entry => entry.entryId));
  const allowedNumbers = collectKnownNumbers(input.data.facts);
  for (const section of output.data.sections) {
    for (const statement of section.statements) {
      if (forbiddenNarrative.test(statement.text)) issues.push(`${statement.statementId}:禁止された予想・購入表現が含まれています。`);
      if (statement.factIds.some(id => !factById.has(id))) issues.push(`${statement.statementId}:入力にないfactIdが指定されています。`);
      if (statement.entryIds.some(id => !entryIds.has(id))) issues.push(`${statement.statementId}:入力にないentryIdが指定されています。`);
      const numbers = statement.text.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (numbers.some(number => !allowedNumbers.has(number))) issues.push(`${statement.statementId}:入力factにない数値が含まれています。`);
    }
  }
  return issues.length ? { valid: false, issues } : { valid: true, output: output.data };
}

export const aiRaceGuideStatuses = ['DATA_PENDING', 'QUEUED', 'GENERATING', 'VALIDATING', 'REVIEW_REQUIRED', 'READY', 'PUBLISHED', 'FAILED', 'STALE'] as const;
export const aiRaceGuideTransportSchema = z.enum(['disabled', 'test']);
export type AiRaceGuideTransport = z.infer<typeof aiRaceGuideTransportSchema>;
export type AiRaceGuideRuntime = { enabled: boolean; generationEnabled: boolean; publicationEnabled: boolean; transport: AiRaceGuideTransport };
export function resolveAiRaceGuideRuntime(env: Record<string, string | undefined>): AiRaceGuideRuntime {
  const flag = (name: string) => env[name] === 'true';
  return {
    enabled: flag('AI_RACE_GUIDE_ENABLED'),
    generationEnabled: flag('AI_RACE_GUIDE_GENERATION_ENABLED'),
    publicationEnabled: flag('AI_RACE_GUIDE_PUBLICATION_ENABLED'),
    transport: aiRaceGuideTransportSchema.catch('disabled').parse(env.AI_RACE_GUIDE_TRANSPORT)
  };
}

export interface AiRaceGuideNarrativeProvider {
  readonly name: 'test' | 'disabled';
  readonly modelVersion: string;
  generate(input: AiRaceGuideStructuredInput): Promise<AiRaceGuideGeneratedOutput>;
}

export class DisabledAiRaceGuideNarrativeProvider implements AiRaceGuideNarrativeProvider {
  readonly name = 'disabled' as const;
  readonly modelVersion = 'disabled';
  async generate(): Promise<AiRaceGuideGeneratedOutput> { throw new Error('AI_RACE_GUIDE_TRANSPORT_DISABLED'); }
}

const sectionForCategory: Record<typeof aiRaceGuideFactCategories[number], typeof aiRaceGuideSectionKinds[number]> = {
  RACE_OVERVIEW: 'RACE_OVERVIEW', ATTENTION_MATERIAL: 'ATTENTION_MATERIALS', POSITIVE_FACTOR: 'POSITIVE_FACTORS',
  CAUTION_FACTOR: 'CAUTION_FACTORS', COURSE_SUITABILITY: 'COURSE_SUITABILITY', DISTANCE_SUITABILITY: 'DISTANCE_SUITABILITY',
  GOING_SUITABILITY: 'GOING_SUITABILITY', PEDIGREE_REFERENCE: 'PEDIGREE_REFERENCES', RECENT_PERFORMANCE: 'RECENT_PERFORMANCE',
  PACE_REFERENCE: 'PACE_REFERENCES', RACE_COMPLEXITY: 'RACE_COMPLEXITY', PADDOCK_CHECK_POINT: 'PADDOCK_CHECK_POINTS'
};
const deterministicText: Record<typeof aiRaceGuideFactCategories[number], string> = {
  RACE_OVERVIEW: '登録済みのレース条件を整理しました。', ATTENTION_MATERIAL: 'データ上の注目材料があります。',
  POSITIVE_FACTOR: '確認できるプラス材料があります。', CAUTION_FACTOR: '確認しておきたい注意材料があります。',
  COURSE_SUITABILITY: 'コース条件の参考情報です。', DISTANCE_SUITABILITY: '距離条件の参考情報です。',
  GOING_SUITABILITY: '馬場条件の参考情報です。', PEDIGREE_REFERENCE: '血統に関する参考情報です。',
  RECENT_PERFORMANCE: '近走内容の参考情報です。', PACE_REFERENCE: '展開を考えるための参考情報です。',
  RACE_COMPLEXITY: 'データの情報差を整理しました。', PADDOCK_CHECK_POINT: 'パドックで確認したいポイントです。'
};

export class TestAiRaceGuideNarrativeProvider implements AiRaceGuideNarrativeProvider {
  readonly name = 'test' as const;
  readonly modelVersion = 'deterministic-test-v1';
  async generate(inputValue: AiRaceGuideStructuredInput): Promise<AiRaceGuideGeneratedOutput> {
    const input = aiRaceGuideStructuredInputSchema.parse(inputValue);
    const grouped = new Map<typeof aiRaceGuideSectionKinds[number], z.infer<typeof statementSchema>[]>();
    for (const fact of input.facts) {
      const kind = sectionForCategory[fact.category];
      const text = fact.state === 'KNOWN' ? deterministicText[fact.category] : fact.state === 'INSUFFICIENT_DATA' ? '判断に必要なデータ件数が不足しています。' : fact.state === 'NOT_AVAILABLE' ? 'この情報は取得対象外です。' : '確認できるデータがありません。';
      const statements = grouped.get(kind) ?? [];
      statements.push({ statementId: `statement:${fact.factId}`, text, factIds: [fact.factId], entryIds: fact.entryId ? [fact.entryId] : [] });
      grouped.set(kind, statements);
    }
    return aiRaceGuideGeneratedOutputSchema.parse({ formatVersion: 1, sections: [...grouped].map(([kind, statements]) => ({ kind, statements })) });
  }
}

export function createAiRaceGuideNarrativeProvider(transport: AiRaceGuideTransport): AiRaceGuideNarrativeProvider {
  return transport === 'test' ? new TestAiRaceGuideNarrativeProvider() : new DisabledAiRaceGuideNarrativeProvider();
}

const mutationBase = z.object({ revision: z.number().int().nonnegative(), mutationId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict();
export const aiRaceGuideGenerationRequestSchema = mutationBase;
export const aiRaceGuideApprovalSchema = mutationBase.extend({ generationId: z.string().uuid() }).strict();
export const aiRaceGuidePublishSchema = mutationBase.extend({ generationId: z.string().uuid(), correctionReason: z.string().trim().max(500).default('') }).strict();

export const aiRaceGuideAdminResponseSchema = z.object({
  race: z.object({ id: z.string().uuid(), raceDate: dateSchema, venue: z.string(), number: z.number().int(), name: z.string(), startsAt: dateTime }).strict(),
  runtime: z.object({ enabled: z.boolean(), generationEnabled: z.boolean(), publicationEnabled: z.boolean(), transport: aiRaceGuideTransportSchema }).strict(),
  guide: z.object({ id: z.string().uuid(), status: z.enum(aiRaceGuideStatuses), revision: z.number().int().positive(), latestGenerationId: z.string().uuid().nullable(), updatedAt: dateTime }).strict().nullable(),
  generations: z.array(z.object({ id: z.string().uuid(), attemptNo: z.number().int().positive(), inputHash: z.string(), dataCutoffAt: dateTime, logicVersion: z.string(), promptVersion: z.string(), sourceVersion: z.string(), modelProvider: aiRaceGuideTransportSchema, modelVersion: z.string(), validationStatus: z.string(), validationErrors: z.array(z.string()), generatedOutput: aiRaceGuideGeneratedOutputSchema.nullable(), structuredInputSnapshot: aiRaceGuideStructuredInputSchema, createdAt: dateTime }).strict()),
  versions: z.array(z.object({ id: z.string().uuid(), version: z.number().int().positive(), publishedAt: dateTime, correctionReason: z.string().nullable() }).strict())
}).strict();
export type AiRaceGuideAdminResponse = z.infer<typeof aiRaceGuideAdminResponseSchema>;

export const aiRaceGuideAdminRaceListResponseSchema = z.object({
  items: z.array(z.object({ id: z.string().uuid(), raceDate: dateSchema, venue: z.string(), number: z.number().int().positive(), name: z.string(), startsAt: dateTime, status: z.string() }).strict()).max(500)
}).strict();
export type AiRaceGuideAdminRaceListResponse = z.infer<typeof aiRaceGuideAdminRaceListResponseSchema>;

export const aiRaceGuidePublicResponseSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }).strict(),
  z.object({ available: z.literal(true), accessScope: z.enum(['FREE_PREVIEW', 'PAID_FULL']), metadata: z.object({ raceId: z.string().uuid(), raceDate: dateSchema, version: z.number().int().positive(), dataCutoffAt: dateTime, generatedAt: dateTime, publishedAt: dateTime, modelVersion: z.string(), logicVersion: z.string(), promptVersion: z.string(), sourceVersion: z.string() }).strict(), content: aiRaceGuideGeneratedOutputSchema }).strict()
]);
export type AiRaceGuidePublicResponse = z.infer<typeof aiRaceGuidePublicResponseSchema>;

export const aiRaceGuidePublicationSnapshotSchema = z.object({
  raceId: z.string().uuid(),
  raceDate: dateSchema,
  version: z.number().int().positive(),
  dataCutoffAt: dateTime,
  generatedAt: dateTime,
  publishedAt: dateTime,
  modelVersion: z.string().trim().min(1).max(100),
  logicVersion: z.string().trim().min(1).max(100),
  promptVersion: z.string().trim().min(1).max(100),
  sourceVersion: z.string().trim().min(1).max(100),
  preview: aiRaceGuideGeneratedOutputSchema,
  full: aiRaceGuideGeneratedOutputSchema
}).strict().superRefine((value, ctx) => {
  const cutoff = new Date(value.dataCutoffAt).getTime();
  const generated = new Date(value.generatedAt).getTime();
  const published = new Date(value.publishedAt).getTime();
  if (cutoff > generated || generated > published) ctx.addIssue({ code: 'custom', path: ['publishedAt'], message: 'dataCutoffAt、generatedAt、publishedAtの順序を確認してください。' });
  const full = new Map(value.full.sections.flatMap(section => section.statements.map(statement => [statement.statementId, { kind: section.kind, statement }] as const)));
  for (const section of value.preview.sections) for (const statement of section.statements) {
    const matching = full.get(statement.statementId);
    if (!matching || matching.kind !== section.kind || stableStringify(matching.statement) !== stableStringify(statement)) {
      ctx.addIssue({ code: 'custom', path: ['preview'], message: 'previewはfull内の同一statementだけで構成してください。' });
      break;
    }
  }
});
export type AiRaceGuidePublicationSnapshot = z.infer<typeof aiRaceGuidePublicationSnapshotSchema>;

export type AiRaceGuidePublicRead = {
  available: true;
  accessScope: 'FREE_PREVIEW' | 'PAID_FULL';
  metadata: Omit<AiRaceGuidePublicationSnapshot, 'preview' | 'full'>;
  content: AiRaceGuideGeneratedOutput;
};

export function projectAiRaceGuideSnapshot(snapshotValue: unknown, canReadFull: boolean): AiRaceGuidePublicRead {
  const snapshot = aiRaceGuidePublicationSnapshotSchema.parse(snapshotValue);
  const { preview, full, ...metadata } = snapshot;
  return { available: true, accessScope: canReadFull ? 'PAID_FULL' : 'FREE_PREVIEW', metadata, content: canReadFull ? full : preview };
}

export const aiRaceGuideInputHashAlgorithm = 'sha256' as const;
export function canonicalizeAiRaceGuideInput(value: unknown) {
  return stableStringify(aiRaceGuideStructuredInputSchema.parse(value));
}

function addDuplicateIssues<T>(values: T[], path: (string | number)[], label: string, ctx: z.RefinementCtx) {
  if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', path, message: `${label}が重複しています。` });
}

function collectKnownNumbers(facts: z.infer<typeof aiRaceGuideFactSchema>[]) {
  const values = new Set<number>();
  const visit = (value: AiRaceGuideJsonValue): void => {
    if (typeof value === 'number') values.add(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  facts.forEach(fact => { if (fact.state === 'KNOWN') visit(fact.value); });
  return values;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
