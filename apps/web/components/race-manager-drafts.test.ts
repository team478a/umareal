import { describe, expect, it } from 'vitest';
import { encodeSessionDraft, parseQuickEntryDraft, parseQuickRaceDraft, raceManagerDraftKey } from './race-manager-drafts';

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
});
