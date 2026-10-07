import { describe, expect, it } from 'vitest';
import { encodeQuickResultDraft, isQuickResultDraftCurrent, parseQuickResultDraft, quickResultDraftKey } from './result-drafts';

describe('quick result session draft', () => {
  it('round-trips a revision-bound draft', () => {
    const draft = { resultRevision: 3, source: '1,1,2,3.4\n2,2,1,2.8', reason: '公式結果を確認' };
    expect(parseQuickResultDraft(encodeQuickResultDraft(draft))).toEqual(draft);
    expect(isQuickResultDraftCurrent(draft, 3)).toBe(true);
    expect(isQuickResultDraftCurrent(draft, 4)).toBe(false);
  });

  it('scopes storage to the operator and race', () => {
    expect(quickResultDraftKey('operator-a', 'race-a')).not.toBe(quickResultDraftKey('operator-b', 'race-a'));
    expect(quickResultDraftKey('operator-a', 'race-a')).not.toBe(quickResultDraftKey('operator-a', 'race-b'));
  });

  it('rejects malformed, oversized and unknown-version values', () => {
    expect(parseQuickResultDraft('{')).toBeNull();
    expect(parseQuickResultDraft(JSON.stringify({ version: 2, resultRevision: 0, source: '', reason: '' }))).toBeNull();
    expect(parseQuickResultDraft(JSON.stringify({ version: 1, resultRevision: 0, source: 'x'.repeat(5_001), reason: '' }))).toBeNull();
    expect(parseQuickResultDraft(JSON.stringify({ version: 1, resultRevision: -1, source: '', reason: '' }))).toBeNull();
  });
});
