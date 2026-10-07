import { describe, expect, it } from 'vitest';
import { encodeSessionDraft, isEntryDetailDraftCurrent, isRaceDetailDraftCurrent, parseEntryDetailDraft, parseQuickEntryDraft, parseQuickRaceDraft, parseRaceDetailDraft, raceManagerDraftKey } from './race-manager-drafts';

describe('race manager session drafts', () => {
  it('round-trips a quick race draft and scopes its key to the operator', () => {
    const draft = { raceDate: '2026-10-08', raceClass: '特別競走', source: '東京\n9R テスト特別 14:35 芝1800 左', reason: '前日準備' };
    expect(parseQuickRaceDraft(encodeSessionDraft(draft))).toEqual(draft);
    expect(raceManagerDraftKey('operator-a', 'quick-races')).not.toBe(raceManagerDraftKey('operator-b', 'quick-races'));
  });

  it('round-trips an entry draft and scopes it to one race', () => {
    const draft = { source: '1,登録馬A\n2,登録馬B', reason: '出馬表を確認' };
    expect(parseQuickEntryDraft(encodeSessionDraft(draft))).toEqual(draft);
    expect(raceManagerDraftKey('operator-a', 'quick-entries', 'race-a')).not.toBe(raceManagerDraftKey('operator-a', 'quick-entries', 'race-b'));
  });

  it('rejects malformed, oversized and unknown-version values', () => {
    expect(parseQuickRaceDraft('{')).toBeNull();
    expect(parseQuickRaceDraft(JSON.stringify({ version: 2, raceDate: '2026-10-08', raceClass: '', source: '', reason: '' }))).toBeNull();
    expect(parseQuickEntryDraft(JSON.stringify({ version: 1, source: 'x'.repeat(5_001), reason: '' }))).toBeNull();
  });

  it('round-trips a revision-bound race detail draft without sharing it across targets', () => {
    const draft = {
      baseRevision: 7, raceDate: '2026-10-08', venue: '東京', number: '9', name: '復元特別', raceClass: '2勝クラス', distance: '1800',
      surface: 'TURF', direction: 'LEFT', startsAt: '2026-10-08T14:35', going: 'UNKNOWN', weather: '未確認', status: 'SCHEDULED',
      expertId: '11111111-1111-4111-8111-111111111111', expertDisplayName: '運営担当', reason: '前日準備',
    };
    expect(parseRaceDetailDraft(encodeSessionDraft(draft))).toEqual(draft);
    expect(isRaceDetailDraftCurrent(draft, 7)).toBe(true);
    expect(isRaceDetailDraftCurrent(draft, 8)).toBe(false);
    expect(raceManagerDraftKey('operator-a', 'race-detail', 'race-a')).not.toBe(raceManagerDraftKey('operator-a', 'race-detail', 'race-b'));
  });

  it('round-trips an entry detail draft and rejects invalid controlled values', () => {
    const draft = {
      raceRevision: 4, entryId: null, number: '3', gate: '2', horseName: '復元ホース', sex: 'FEMALE', age: '3', carriedWeight: '55.5',
      jockey: '確認騎手', trainer: '確認調教師', winOdds: '', popularity: '', status: 'ACTIVE', reason: '出馬表確認',
    };
    expect(parseEntryDetailDraft(encodeSessionDraft(draft))).toEqual(draft);
    expect(isEntryDetailDraftCurrent(draft, 4, null)).toBe(true);
    expect(isEntryDetailDraftCurrent(draft, 5, null)).toBe(false);
    expect(isEntryDetailDraftCurrent({ ...draft, entryId: '11111111-1111-4111-8111-111111111111' }, 4, null)).toBe(false);
    expect(parseEntryDetailDraft(encodeSessionDraft({ ...draft, status: 'UNKNOWN' }))).toBeNull();
    expect(parseRaceDetailDraft(encodeSessionDraft({
      baseRevision: null, raceDate: '2026-10-08', venue: '東京', number: '1', name: '', raceClass: '', distance: '1600', surface: 'TURF', direction: 'LEFT',
      startsAt: '2026-10-08T15:00', going: 'UNKNOWN', weather: '未確認', status: 'SCHEDULED', expertId: '', expertDisplayName: '', reason: 'x'.repeat(501),
    }))).toBeNull();
  });
});
