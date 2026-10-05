import { describe, expect, it } from 'vitest';
import {
  aiRaceGuideFactBuilderInputSchema,
  buildAiRaceGuideFacts,
  projectFactBundleToStructuredInput,
  resolveHorseExternalIdentity
} from './ai-race-guide-facts';
import { createAiRaceGuidePhase1BSyntheticFixtures } from './ai-race-guide-phase1b-fixtures';

describe('AI race guide Phase 1B fact builder', () => {
  it('produces evidence-backed facts with fixed cutoff, sample size and logic version', () => {
    const fixture = createAiRaceGuidePhase1BSyntheticFixtures();
    const bundle = buildAiRaceGuideFacts(fixture.input);
    expect(bundle.facts.every(fact => fact.dataCutoffAt === fixture.input.dataCutoffAt)).toBe(true);
    expect(bundle.facts.every(fact => fact.logicVersion === fixture.input.logicVersion)).toBe(true);
    expect(bundle.evidence.every(item => item.dataCutoffAt === fixture.input.dataCutoffAt)).toBe(true);
    const known = bundle.facts.find(fact => fact.factId === `fact:distance:${fixture.cases.A_SUFFICIENT_HISTORY}`);
    expect(known).toMatchObject({ state: 'KNOWN', sampleSize: 3 });
    expect(known?.evidenceIds).toHaveLength(3);
  });

  it('distinguishes UNKNOWN, INSUFFICIENT_DATA and NOT_AVAILABLE', () => {
    const fixture = createAiRaceGuidePhase1BSyntheticFixtures();
    const bundle = buildAiRaceGuideFacts(fixture.input);
    expect(bundle.facts.find(fact => fact.factId === `fact:distance:${fixture.cases.B_ONE_HISTORY}`)).toMatchObject({ state: 'INSUFFICIENT_DATA', sampleSize: 1 });
    expect(bundle.facts.find(fact => fact.factId === `fact:recent:${fixture.cases.C_NO_HISTORY}`)).toMatchObject({ state: 'UNKNOWN', reasonCode: 'NO_HISTORY' });
    expect(bundle.facts.find(fact => fact.factId === `fact:pedigree:${fixture.cases.C_NO_HISTORY}`)).toMatchObject({ state: 'NOT_AVAILABLE', reasonCode: 'PEDIGREE_NOT_AVAILABLE' });
    expect(bundle.facts.find(fact => fact.factId === `fact:pedigree:${fixture.cases.H_LICENSE_REVIEW}`)).toMatchObject({ state: 'NOT_AVAILABLE', reasonCode: 'LICENSE_REVIEW_REQUIRED' });
  });

  it('applies deterministic withdrawn/DNF/canceled rules', () => {
    const fixture = createAiRaceGuidePhase1BSyntheticFixtures();
    const withdrawn = fixture.input.history.find(row => row.horseId === fixture.input.entries[4].horseId)!;
    const nonFinishes = (['DNF', 'EXCLUDED', 'CANCELED'] as const).map((status, index) => ({
      ...withdrawn,
      resultVersionId: `60000000-0000-4000-8000-00000000000${index + 1}`,
      raceId: `61000000-0000-4000-8000-00000000000${index + 1}`,
      raceEntryId: `62000000-0000-4000-8000-00000000000${index + 1}`,
      raceDate: `2026-09-2${index + 1}`,
      startsAt: `2026-09-2${index + 1}T06:00:00Z`,
      status,
      provenance: { ...withdrawn.provenance, sourceRecordReference: `non-finish-${status}` }
    }));
    const bundle = buildAiRaceGuideFacts({ ...fixture.input, history: [...fixture.input.history, ...nonFinishes] });
    const recent = bundle.facts.find(fact => fact.factId === `fact:recent:${fixture.cases.E_WITHDRAWN}`);
    expect(recent).toMatchObject({ state: 'KNOWN', sampleSize: 1 });
    expect(JSON.stringify(recent)).toContain('DNF');
    expect(JSON.stringify(recent)).not.toContain('WITHDRAWN');
    expect(JSON.stringify(recent)).not.toContain('EXCLUDED');
    expect(JSON.stringify(recent)).not.toContain('CANCELED');
    expect(bundle.facts.find(fact => fact.factId === `fact:distance:${fixture.cases.E_WITHDRAWN}`)).toMatchObject({ state: 'INSUFFICIENT_DATA', sampleSize: 0 });
  });

  it('uses the latest result version known at cutoff and blocks future leakage', () => {
    const fixture = createAiRaceGuidePhase1BSyntheticFixtures();
    const bundle = buildAiRaceGuideFacts(fixture.input);
    const corrected = bundle.facts.find(fact => fact.factId === `fact:recent:${fixture.cases.F_RESULT_CORRECTION}`);
    expect(corrected).toMatchObject({ state: 'KNOWN', sampleSize: 1 });
    expect(JSON.stringify(corrected)).toContain('"finishPosition":4');
    expect(JSON.stringify(corrected)).not.toContain('"finishPosition":1');
    expect(bundle.facts.find(fact => fact.factId === `fact:recent:${fixture.cases.G_FUTURE_RESULT}`)).toMatchObject({ state: 'UNKNOWN', sampleSize: 0 });
    expect(bundle.evidence.every(item => new Date(item.observedAt) <= new Date(fixture.input.dataCutoffAt))).toBe(true);
    expect(bundle.evidence.every(item => new Date(item.importedAt) <= new Date(fixture.input.dataCutoffAt))).toBe(true);
  });

  it('connects to the Phase 1A structured input through an explicit allowlist', () => {
    const fixture = createAiRaceGuidePhase1BSyntheticFixtures();
    const bundle = buildAiRaceGuideFacts(fixture.input);
    const structured = projectFactBundleToStructuredInput({
      bundle, raceId: fixture.input.targetRace.raceId, raceDate: fixture.input.targetRace.raceDate,
      entries: fixture.input.entries.map(entry => ({ entryId: entry.entryId, horseId: entry.horseId, number: entry.number, horseName: entry.horseName })),
      promptVersion: 'phase1b-test-v1', sourceVersion: 'phase1b-fixture-v1'
    });
    expect(structured.facts.length).toBe(bundle.facts.length);
    const keys: string[] = [];
    const collectKeys = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(collectKeys);
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) { keys.push(key); collectKeys(child); }
    };
    collectKeys(structured);
    expect(keys.join(',')).not.toMatch(/assessment|prediction|mikuniyacomment|user|member|administrator|internalmemo/i);
    expect(() => projectFactBundleToStructuredInput({
      bundle: { ...bundle, sources: bundle.sources.map((source, index) => index ? source : { ...source, memberDisplayApproved: false }) },
      raceId: fixture.input.targetRace.raceId,
      raceDate: fixture.input.targetRace.raceDate,
      entries: structured.entries,
      promptVersion: 'v1',
      sourceVersion: 'v1'
    })).toThrow('AI_FACT_MEMBER_DISPLAY_LICENSE_DENIED');
    expect(() => projectFactBundleToStructuredInput({ bundle, raceId: fixture.input.targetRace.raceId, raceDate: fixture.input.targetRace.raceDate, entries: structured.entries, promptVersion: 'v1', sourceVersion: 'v1', processingMode: 'EXTERNAL_LLM' })).toThrow('AI_FACT_EXTERNAL_AI_LICENSE_DENIED');
  });

  it('rejects Assessment, Prediction and user-shaped contamination at the strict input boundary', () => {
    const fixture = createAiRaceGuidePhase1BSyntheticFixtures();
    expect(aiRaceGuideFactBuilderInputSchema.safeParse({ ...fixture.input, assessment: {} }).success).toBe(false);
    expect(aiRaceGuideFactBuilderInputSchema.safeParse({ ...fixture.input, prediction: {} }).success).toBe(false);
    expect(aiRaceGuideFactBuilderInputSchema.safeParse({ ...fixture.input, user: {} }).success).toBe(false);
  });
});

describe('horse external identity resolution', () => {
  it('matches the same external identity deterministically', () => {
    const fixture = createAiRaceGuidePhase1BSyntheticFixtures();
    const horseId = fixture.identity.horses[0].id;
    expect(resolveHorseExternalIdentity({ ...fixture.identity, identities: [{ provider: fixture.identity.provider, externalKeyHash: fixture.identity.externalKeyHash, horseId }] })).toMatchObject({ status: 'MATCHED', horseId, duplicateIdentity: false });
  });

  it('flags duplicate identity rows and never auto-merges name matches', () => {
    const fixture = createAiRaceGuidePhase1BSyntheticFixtures();
    const duplicate = resolveHorseExternalIdentity({ ...fixture.identity, identities: [
      { provider: fixture.identity.provider, externalKeyHash: fixture.identity.externalKeyHash, horseId: fixture.identity.horses[0].id },
      { provider: fixture.identity.provider, externalKeyHash: fixture.identity.externalKeyHash, horseId: '20000000-0000-4000-8000-000000000099' }
    ] });
    expect(duplicate).toMatchObject({ status: 'UNRESOLVED', horseId: null, duplicateIdentity: true });
    expect(resolveHorseExternalIdentity(fixture.identity)).toMatchObject({ status: 'POSSIBLE_DUPLICATE', horseId: null, candidateHorseIds: [fixture.identity.horses[0].id] });
  });

  it('leaves an unknown horse unresolved', () => {
    const fixture = createAiRaceGuidePhase1BSyntheticFixtures();
    expect(resolveHorseExternalIdentity({ ...fixture.identity, observedName: '存在しない馬', horses: [] })).toMatchObject({ status: 'UNRESOLVED', horseId: null, candidateHorseIds: [] });
  });
});
