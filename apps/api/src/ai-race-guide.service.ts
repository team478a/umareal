import { Injectable } from '@nestjs/common';
import {
  aiRaceGuideGeneratedOutputSchema,
  aiRaceGuideStructuredInputSchema,
  canonicalizeAiRaceGuideInput,
  createAiRaceGuideNarrativeProvider,
  type AiRaceGuideGeneratedOutput,
  type AiRaceGuideStructuredInput,
  type AiRaceGuideTransport
} from '@keiba/domain';
import { hashToken } from './security';

type FixtureRace = {
  id: string;
  raceDate: string;
  venue: string;
  number: number;
  name: string;
  startsAt: Date;
  status: string;
  revision: number;
  raceClass: string | null;
  distance: number | null;
  surface: string | null;
  direction: string | null;
  going: string | null;
  weather: string | null;
  entries: Array<{
    id: string;
    horseId: string;
    number: number;
    gate: number | null;
    horseName: string;
    sex: string | null;
    age: number | null;
    carriedWeight: { toString(): string } | null;
    jockey: string | null;
    trainer: string | null;
    status: string;
  }>;
};

@Injectable()
export class AiRaceGuideService {
  readonly logicVersion = 'basic-guide-rules-v1';
  readonly promptVersion = 'basic-guide-template-v1';
  readonly sourceVersion = 'umareal-operational-snapshot-v1';

  buildInput(race: FixtureRace, dataCutoffAt = new Date(), transport: AiRaceGuideTransport = 'template'): AiRaceGuideStructuredInput {
    const observedAt = dataCutoffAt.toISOString();
    const raceSourceId = 'source:umareal-race';
    const entrySourceId = 'source:umareal-entries';
    const raceEvidenceId = `evidence:race:${race.id}`;
    const entries = race.entries.map(entry => ({ entryId: entry.id, horseId: entry.horseId, number: entry.number, horseName: entry.horseName }));
    const input = {
      formatVersion: 1 as const,
      kind: 'PRE_RACE' as const,
      processingMode: transport === 'test' ? 'DETERMINISTIC_TEST' as const : 'DETERMINISTIC_TEMPLATE' as const,
      raceId: race.id,
      raceDate: race.raceDate,
      dataCutoffAt: observedAt,
      logicVersion: this.logicVersion,
      promptVersion: this.promptVersion,
      sourceVersion: this.sourceVersion,
      entries,
      sources: [
        { sourceId: raceSourceId, kind: 'RACE' as const, sourceProvider: 'UMAREAL', sourceVersion: this.sourceVersion, licenseDecision: 'APPROVED' as const, allowedUses: ['GUIDE_GENERATION', 'MEMBER_DISPLAY'] as const },
        { sourceId: entrySourceId, kind: 'RACE_ENTRY' as const, sourceProvider: 'UMAREAL', sourceVersion: this.sourceVersion, licenseDecision: 'APPROVED' as const, allowedUses: ['GUIDE_GENERATION', 'MEMBER_DISPLAY'] as const }
      ],
      evidence: [
        { evidenceId: raceEvidenceId, sourceId: raceSourceId, sourceRecordId: race.id, sourceVersion: this.sourceVersion, observedAt },
        ...race.entries.map(entry => ({ evidenceId: `evidence:entry:${entry.id}`, sourceId: entrySourceId, sourceRecordId: entry.id, sourceVersion: this.sourceVersion, observedAt }))
      ],
      facts: [
        {
          factId: `fact:race:${race.id}`,
          category: 'RACE_OVERVIEW' as const,
          state: 'KNOWN' as const,
          value: {
            raceRevision: race.revision,
            venue: race.venue,
            raceNumber: race.number,
            raceName: race.name,
            startsAt: race.startsAt.toISOString(),
            status: race.status,
            raceClass: race.raceClass ?? 'UNKNOWN',
            distance: race.distance ?? 'UNKNOWN',
            surface: race.surface ?? 'UNKNOWN',
            direction: race.direction ?? 'UNKNOWN',
            going: race.going ?? 'UNKNOWN',
            weather: race.weather ?? 'UNKNOWN',
            fieldSize: race.entries.length
          },
          evidenceIds: [raceEvidenceId]
        },
        ...race.entries.map(entry => ({
          factId: `fact:entry:${entry.id}`,
          category: 'ATTENTION_MATERIAL' as const,
          entryId: entry.id,
          state: 'KNOWN' as const,
          value: { number: entry.number, horseName: entry.horseName, status: entry.status },
          evidenceIds: [`evidence:entry:${entry.id}`]
        })),
        ...race.entries.flatMap(entry => {
          const detailsComplete = entry.gate !== null && entry.sex !== null && entry.age !== null && entry.carriedWeight !== null && entry.jockey !== null && entry.trainer !== null;
          return detailsComplete ? [] : [{
            factId: `fact:entry-details:${entry.id}`,
            category: 'CAUTION_FACTOR' as const,
            entryId: entry.id,
            state: 'INSUFFICIENT_DATA' as const,
            reasonCode: 'ENTRY_DETAILS_NOT_REGISTERED',
            evidenceIds: [`evidence:entry:${entry.id}`]
          }];
        }),
        {
          factId: `fact:paddock-check:${race.id}`,
          category: 'PADDOCK_CHECK_POINT' as const,
          state: 'KNOWN' as const,
          value: { checkItems: ['歩様', '落ち着き', '発汗'], automaticPaddockJudgement: false },
          evidenceIds: [raceEvidenceId]
        }
      ]
    };
    return aiRaceGuideStructuredInputSchema.parse(input);
  }

  hashInput(input: AiRaceGuideStructuredInput) {
    return hashToken(canonicalizeAiRaceGuideInput(input));
  }

  async generate(transport: AiRaceGuideTransport, input: AiRaceGuideStructuredInput) {
    const provider = createAiRaceGuideNarrativeProvider(transport);
    return { provider: provider.name, modelVersion: provider.modelVersion, output: await provider.generate(input) };
  }

  preview(outputValue: unknown): AiRaceGuideGeneratedOutput {
    const output = aiRaceGuideGeneratedOutputSchema.parse(outputValue);
    const overview = output.sections.find(section => section.kind === 'RACE_OVERVIEW') ?? output.sections[0];
    return aiRaceGuideGeneratedOutputSchema.parse({ formatVersion: 1, sections: [overview] });
  }

  isFresh(inputValue: unknown, race: FixtureRace) {
    const input = aiRaceGuideStructuredInputSchema.parse(inputValue);
    if (input.raceId !== race.id || input.raceDate !== race.raceDate) return false;
    const overview = input.facts.find(fact => fact.category === 'RACE_OVERVIEW' && fact.state === 'KNOWN');
    const value = overview?.state === 'KNOWN' && !Array.isArray(overview.value) && typeof overview.value === 'object' ? overview.value : null;
    if (!value || value.raceRevision !== race.revision) return false;
    const current = race.entries.map(entry => `${entry.id}:${entry.horseId}:${entry.number}:${entry.horseName}`).sort();
    const saved = input.entries.map(entry => `${entry.entryId}:${entry.horseId}:${entry.number}:${entry.horseName}`).sort();
    return JSON.stringify(current) === JSON.stringify(saved);
  }
}
