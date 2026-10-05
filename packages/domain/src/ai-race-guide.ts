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
  sourceVersion: z.string().trim().min(1).max(100),
  licenseDecision: z.literal('APPROVED'),
  allowedUses: z.array(z.enum(aiRaceGuideDataUses)).min(1).max(aiRaceGuideDataUses.length)
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
  sourceVersion: z.string().trim().min(1).max(100),
  observedAt: dateTime
}).strict();

const factBase = z.object({
  factId: stableId,
  category: z.enum(aiRaceGuideFactCategories),
  entryId: z.string().uuid().optional()
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
  });

  value.facts.forEach((fact, index) => {
    if (new Set(fact.evidenceIds).size !== fact.evidenceIds.length) ctx.addIssue({ code: 'custom', path: ['facts', index, 'evidenceIds'], message: 'evidenceIdが重複しています。' });
    if (fact.entryId && !entryIds.has(fact.entryId)) ctx.addIssue({ code: 'custom', path: ['facts', index, 'entryId'], message: '存在するentryIdを指定してください。' });
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
const forbiddenNarrative = /(買い目|自動投票|購入金額|勝率|的中率|利益保証|必ず勝|絶対に勝|本命|対抗|単勝|複勝|三国谷氏?の発言)/;

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
