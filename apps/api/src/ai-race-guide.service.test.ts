import { describe, expect, it } from 'vitest';
import { AiRaceGuideService } from './ai-race-guide.service';

describe('AiRaceGuideService manual entry boundary', () => {
  it('does not invent unregistered entry details', () => {
    const input = new AiRaceGuideService().buildInput({
      id: '10000000-0000-4000-8000-000000000001', raceDate: '2099-10-06', venue: '東京', number: 9, name: '手動運用試験', startsAt: new Date('2099-10-06T15:00:00+09:00'), status: 'SCHEDULED', revision: 1,
      raceClass: '未設定', distance: 1600, surface: 'TURF', direction: 'LEFT', going: null, weather: null,
      entries: [{ id: '20000000-0000-4000-8000-000000000001', horseId: '30000000-0000-4000-8000-000000000001', number: 1, gate: null, horseName: '簡易登録馬', sex: null, age: null, carriedWeight: null, jockey: null, trainer: null, status: 'ACTIVE' }]
    }, new Date('2099-10-06T01:00:00Z'));
    expect(input.processingMode).toBe('DETERMINISTIC_TEMPLATE');
    expect(input.facts.find(fact => fact.category === 'ATTENTION_MATERIAL' && fact.entryId === input.entries[0].entryId)).toEqual(expect.objectContaining({ state: 'KNOWN', value: expect.objectContaining({ number: 1, horseName: '簡易登録馬' }) }));
    expect(input.facts.find(fact => fact.category === 'CAUTION_FACTOR' && fact.entryId === input.entries[0].entryId)).toEqual(expect.objectContaining({ state: 'INSUFFICIENT_DATA', reasonCode: 'ENTRY_DETAILS_NOT_REGISTERED' }));
    expect(JSON.stringify(input)).not.toMatch(/"gate":0|未確認騎手|未確認調教師/);
    expect(input.logicVersion).toBe('basic-guide-rules-v2');
    expect(input.promptVersion).toBe('basic-guide-template-v2');
  });
});
