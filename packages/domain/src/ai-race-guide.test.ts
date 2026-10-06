import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  aiRaceGuideFactSchema,
  aiRaceGuidePublicationSnapshotSchema,
  aiRaceGuideStructuredInputSchema,
  canonicalizeAiRaceGuideInput,
  createAiRaceGuideNarrativeProvider,
  projectAiRaceGuideSnapshot,
  resolveAiRaceGuideRuntime,
  validateAiRaceGuideGeneratedOutput
} from './ai-race-guide';

const raceId = randomUUID();
const entryId = randomUUID();
const horseId = randomUUID();
const source = {
  sourceId: 'race-import-1', kind: 'RACE' as const, sourceVersion: 'manifest-1', licenseDecision: 'APPROVED' as const,
  allowedUses: ['GUIDE_GENERATION', 'MEMBER_DISPLAY'] as const
};
const evidence = { evidenceId: 'e-race-1', sourceId: source.sourceId, sourceVersion: source.sourceVersion, sourceRecordId: raceId, observedAt: '2026-10-05T00:00:00Z' };
const fact = { factId: 'f-distance', category: 'RACE_OVERVIEW' as const, state: 'KNOWN' as const, value: { distance: 1600 }, unit: 'm', evidenceIds: [evidence.evidenceId] };

function input(overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 1, kind: 'PRE_RACE', processingMode: 'DETERMINISTIC_TEST', raceId, raceDate: '2026-10-05',
    dataCutoffAt: '2026-10-05T01:00:00Z', logicVersion: 'logic-v1', promptVersion: 'prompt-v1', sourceVersion: 'input-v1',
    entries: [{ entryId, horseId, number: 1, horseName: 'テストホース' }], sources: [source], evidence: [evidence], facts: [fact],
    ...overrides
  };
}

const validOutput = {
  formatVersion: 1,
  sections: [{ kind: 'RACE_OVERVIEW', statements: [{ statementId: 's-overview', text: '距離は1600mです。', factIds: [fact.factId], entryIds: [] }] }]
};

describe('AI race guide Phase 1A contract', () => {
  it('keeps known and unavailable facts distinct instead of treating missing data as zero', () => {
    expect(aiRaceGuideFactSchema.safeParse(fact).success).toBe(true);
    expect(aiRaceGuideFactSchema.safeParse({ factId: fact.factId, category: fact.category, state: 'UNKNOWN', reasonCode: 'NO_SOURCE', evidenceIds: [] }).success).toBe(true);
    expect(aiRaceGuideFactSchema.safeParse({ ...fact, state: 'UNKNOWN', reasonCode: 'NO_SOURCE' }).success).toBe(false);
    expect(aiRaceGuideFactSchema.safeParse({ ...fact, evidenceIds: [] }).success).toBe(false);
    expect(aiRaceGuideFactSchema.safeParse({ ...fact, value: null }).success).toBe(false);
  });

  it('rejects unknown sources, evidence newer than the cutoff and fields outside the approved contract', () => {
    expect(aiRaceGuideStructuredInputSchema.safeParse(input()).success).toBe(true);
    expect(aiRaceGuideStructuredInputSchema.safeParse(input({ evidence: [{ ...evidence, sourceId: 'missing' }] }))).toMatchObject({ success: false });
    expect(aiRaceGuideStructuredInputSchema.safeParse(input({ evidence: [{ ...evidence, observedAt: '2026-10-05T02:00:00Z' }] }))).toMatchObject({ success: false });
    expect(aiRaceGuideStructuredInputSchema.safeParse({ ...input(), assessmentSnapshot: {} })).toMatchObject({ success: false });
  });

  it('requires explicit external-AI permission before an input can use that processing mode', () => {
    expect(aiRaceGuideStructuredInputSchema.safeParse(input({ processingMode: 'EXTERNAL_LLM' }))).toMatchObject({ success: false });
    const approved = { ...source, allowedUses: ['GUIDE_GENERATION', 'MEMBER_DISPLAY', 'EXTERNAL_AI_PROCESSING'] };
    expect(aiRaceGuideStructuredInputSchema.safeParse(input({ processingMode: 'EXTERNAL_LLM', sources: [approved] }))).toMatchObject({ success: true });
  });

  it('rejects narrative claims without input facts, fabricated numbers and prediction language', () => {
    expect(validateAiRaceGuideGeneratedOutput(input(), validOutput)).toMatchObject({ valid: true });
    const missingFact = structuredClone(validOutput); missingFact.sections[0].statements[0].factIds = ['missing'];
    expect(validateAiRaceGuideGeneratedOutput(input(), missingFact)).toMatchObject({ valid: false });
    const fabricatedNumber = structuredClone(validOutput); fabricatedNumber.sections[0].statements[0].text = '距離は2000mです。';
    expect(validateAiRaceGuideGeneratedOutput(input(), fabricatedNumber)).toMatchObject({ valid: false });
    const prediction = structuredClone(validOutput); prediction.sections[0].statements[0].text = '本命として扱います。';
    expect(validateAiRaceGuideGeneratedOutput(input(), prediction)).toMatchObject({ valid: false });
  });

  it('canonicalizes object keys before a service computes the SHA-256 input hash', () => {
    const original = input();
    const reordered = {
      facts: original.facts, evidence: original.evidence, sources: original.sources, entries: original.entries,
      sourceVersion: original.sourceVersion, promptVersion: original.promptVersion, logicVersion: original.logicVersion,
      dataCutoffAt: original.dataCutoffAt, raceDate: original.raceDate, raceId: original.raceId,
      processingMode: original.processingMode, kind: original.kind, formatVersion: original.formatVersion
    };
    expect(canonicalizeAiRaceGuideInput(reordered)).toBe(canonicalizeAiRaceGuideInput(original));
  });

  it('returns only the free preview when full access is absent', () => {
    const extra = { statementId: 's-paid', text: '距離適性の詳細です。', factIds: [fact.factId], entryIds: [entryId] };
    const snapshot = {
      raceId, raceDate: '2026-10-05', version: 1, dataCutoffAt: '2026-10-05T01:00:00Z',
      generatedAt: '2026-10-05T01:01:00Z', publishedAt: '2026-10-05T01:02:00Z',
      modelVersion: 'fixture-v1', logicVersion: 'logic-v1', promptVersion: 'prompt-v1', sourceVersion: 'input-v1',
      preview: validOutput,
      full: { ...validOutput, sections: [{ ...validOutput.sections[0], statements: [...validOutput.sections[0].statements, extra] }] }
    };
    expect(aiRaceGuidePublicationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    const free = projectAiRaceGuideSnapshot(snapshot, false);
    expect(free.accessScope).toBe('FREE_PREVIEW');
    expect(JSON.stringify(free)).not.toContain('s-paid');
    expect(projectAiRaceGuideSnapshot(snapshot, true).content.sections[0].statements).toHaveLength(2);
  });

  it('does not allow a preview statement to differ from the paid full snapshot', () => {
    const snapshot = {
      raceId, raceDate: '2026-10-05', version: 1, dataCutoffAt: '2026-10-05T01:00:00Z',
      generatedAt: '2026-10-05T01:01:00Z', publishedAt: '2026-10-05T01:02:00Z',
      modelVersion: 'fixture-v1', logicVersion: 'logic-v1', promptVersion: 'prompt-v1', sourceVersion: 'input-v1',
      preview: validOutput,
      full: { ...validOutput, sections: [{ ...validOutput.sections[0], statements: [{ ...validOutput.sections[0].statements[0], text: '異なる文章です。' }] }] }
    };
    expect(aiRaceGuidePublicationSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('requires cutoff, generation and publication timestamps to remain chronological', () => {
    const snapshot = {
      raceId, raceDate: '2026-10-05', version: 1, dataCutoffAt: '2026-10-05T01:03:00Z',
      generatedAt: '2026-10-05T01:01:00Z', publishedAt: '2026-10-05T01:02:00Z',
      modelVersion: 'fixture-v1', logicVersion: 'logic-v1', promptVersion: 'prompt-v1', sourceVersion: 'input-v1',
      preview: validOutput, full: validOutput
    };
    expect(aiRaceGuidePublicationSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it('keeps every feature flag off by default and rejects disabled transport', async () => {
    expect(resolveAiRaceGuideRuntime({})).toEqual({ enabled: false, generationEnabled: false, publicationEnabled: false, transport: 'disabled' });
    expect(resolveAiRaceGuideRuntime({ AI_RACE_GUIDE_TRANSPORT: 'template' }).transport).toBe('template');
    expect(resolveAiRaceGuideRuntime({ AI_RACE_GUIDE_ENABLED: 'true', AI_RACE_GUIDE_GENERATION_ENABLED: 'false', AI_RACE_GUIDE_PUBLICATION_ENABLED: 'true', AI_RACE_GUIDE_TRANSPORT: 'unknown' })).toEqual({ enabled: true, generationEnabled: false, publicationEnabled: true, transport: 'disabled' });
    await expect(createAiRaceGuideNarrativeProvider('disabled').generate(aiRaceGuideStructuredInputSchema.parse(input()))).rejects.toThrow('AI_RACE_GUIDE_TRANSPORT_DISABLED');
  });

  it('renders a deterministic network-free Basic Guide from registered facts only', async () => {
    const templateInput = aiRaceGuideStructuredInputSchema.parse(input({
      processingMode: 'DETERMINISTIC_TEMPLATE',
      facts: [
        { ...fact, value: { venue: '東京', raceNumber: 9, raceName: '手動運用試験', surface: 'TURF', distance: 1600, fieldSize: 1 } },
        { factId: 'f-entry', category: 'ATTENTION_MATERIAL', entryId, state: 'KNOWN', value: { number: 1, horseName: 'テストホース', status: 'ACTIVE' }, evidenceIds: [evidence.evidenceId] },
        { factId: 'f-entry-details', category: 'CAUTION_FACTOR', entryId, state: 'INSUFFICIENT_DATA', reasonCode: 'ENTRY_DETAILS_NOT_REGISTERED', evidenceIds: [evidence.evidenceId] },
        { factId: 'f-paddock', category: 'PADDOCK_CHECK_POINT', state: 'KNOWN', value: { checkItems: ['歩様', '落ち着き', '発汗'], automaticPaddockJudgement: false }, evidenceIds: [evidence.evidenceId] }
      ]
    }));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => { calls += 1; throw new Error('network forbidden'); }) as typeof fetch;
    try {
      const provider = createAiRaceGuideNarrativeProvider('template');
      const output = await provider.generate(templateInput);
      expect(output).toEqual(await provider.generate(templateInput));
      expect(validateAiRaceGuideGeneratedOutput(templateInput, output)).toMatchObject({ valid: true });
      expect(JSON.stringify(output)).toContain('データ不足を成績不振とは扱いません');
      expect(JSON.stringify(output)).not.toMatch(/本命|勝率|買い目|三国谷/u);
      expect(calls).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('uses a deterministic network-free test provider', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => { calls += 1; throw new Error('network forbidden'); }) as typeof fetch;
    try {
      const provider = createAiRaceGuideNarrativeProvider('test');
      const structured = aiRaceGuideStructuredInputSchema.parse(input());
      expect(await provider.generate(structured)).toEqual(await provider.generate(structured));
      expect(calls).toBe(0);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('rejects horse references and misattribution that are absent from the input', () => {
    const unknownHorse = structuredClone(validOutput); unknownHorse.sections[0].statements[0].entryIds = [randomUUID()];
    expect(validateAiRaceGuideGeneratedOutput(input(), unknownHorse)).toMatchObject({ valid: false });
    const misattribution = structuredClone(validOutput); misattribution.sections[0].statements[0].text = '三国谷氏の予想として表示します。';
    expect(validateAiRaceGuideGeneratedOutput(input(), misattribution)).toMatchObject({ valid: false });
  });
});
