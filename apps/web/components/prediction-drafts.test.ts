import { describe, expect, it } from 'vitest';
import { emptyPredictionDraft } from '@keiba/domain';
import { encodePredictionEditorDraft, isPredictionEditorDraftCurrent, parsePredictionEditorDraft, predictionEditorDraftKey } from './prediction-drafts';

describe('prediction editor session draft', () => {
  const value = {
    predictionRevision: 2,
    raceRevision: 4,
    draft: { ...emptyPredictionDraft, visibility: 'FREE' as const, confidence: 'A' as const, summary: '発走前の最終見解' },
    reason: 'パドック確認後の更新',
    correctionReason: '',
  };

  it('round-trips a schema-validated draft', () => {
    expect(parsePredictionEditorDraft(encodePredictionEditorDraft(value))).toEqual(value);
  });

  it('requires the current prediction and race revisions', () => {
    expect(isPredictionEditorDraftCurrent(value, 2, 4)).toBe(true);
    expect(isPredictionEditorDraftCurrent(value, 3, 4)).toBe(false);
    expect(isPredictionEditorDraftCurrent(value, 2, 5)).toBe(false);
  });

  it('scopes storage to one operator and race', () => {
    expect(predictionEditorDraftKey('operator-a', 'race-a')).not.toBe(predictionEditorDraftKey('operator-b', 'race-a'));
    expect(predictionEditorDraftKey('operator-a', 'race-a')).not.toBe(predictionEditorDraftKey('operator-a', 'race-b'));
  });

  it('rejects malformed, oversized, unknown-version and invalid-domain values', () => {
    expect(parsePredictionEditorDraft('{')).toBeNull();
    expect(parsePredictionEditorDraft(JSON.stringify({ version: 2, ...value }))).toBeNull();
    expect(parsePredictionEditorDraft(encodePredictionEditorDraft({ ...value, reason: 'x'.repeat(501) }))).toBeNull();
    expect(parsePredictionEditorDraft(JSON.stringify({ version: 1, ...value, draft: { ...value.draft, confidence: 'WIN' } }))).toBeNull();
  });
});
