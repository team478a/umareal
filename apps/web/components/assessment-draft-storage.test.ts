import { describe, expect, it } from 'vitest';
import { blankAssessment } from '@keiba/domain';
import { assessmentDraftRetentionMs, clearAssessmentDraftStorage, clearStorageByPrefixes, operationalSessionDraftPrefixes, readAssessmentDrafts, writeAssessmentDrafts } from './assessment-draft-storage';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const draft = { content: blankAssessment, revision: 0, raceRevision: 1, horseId: '11111111-1111-4111-8111-111111111111', mutationId: '22222222-2222-4222-8222-222222222222', reason: '端末保存試験' };

describe('assessment draft storage', () => {
  it('stores drafts in a 24-hour envelope and detects concurrent changes', () => {
    const storage = new MemoryStorage(); const key = 'keiba:assessment:user:race'; const now = Date.UTC(2026, 9, 7);
    const raw = writeAssessmentDrafts(storage, key, { entry: draft }, null, now);
    expect(JSON.parse(raw!)).toMatchObject({ version: 1, updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + assessmentDraftRetentionMs).toISOString() });
    expect(readAssessmentDrafts(storage, key, now + 1).drafts.entry).toEqual(draft);
    expect(() => writeAssessmentDrafts(storage, key, {}, 'stale', now)).toThrow(/別のタブ/);
  });

  it('removes expired and invalid drafts instead of restoring them', () => {
    const storage = new MemoryStorage(); const key = 'keiba:assessment:user:race'; const now = Date.UTC(2026, 9, 7);
    writeAssessmentDrafts(storage, key, { entry: draft }, null, now);
    expect(readAssessmentDrafts(storage, key, now + assessmentDraftRetentionMs).expired).toBe(true);
    expect(storage.getItem(key)).toBeNull();
    storage.setItem(key, '{broken');
    expect(readAssessmentDrafts(storage, key, now).drafts).toEqual({});
    expect(storage.getItem(key)).toBeNull();
  });

  it('migrates a valid legacy map without changing its draft', () => {
    const storage = new MemoryStorage(); const key = 'keiba:assessment:user:race'; const now = Date.UTC(2026, 9, 7);
    storage.setItem(key, JSON.stringify({ entry: draft }));
    const result = readAssessmentDrafts(storage, key, now);
    expect(result.migrated).toBe(true);
    expect(result.drafts.entry).toEqual(draft);
    expect(JSON.parse(storage.getItem(key)!)).toMatchObject({ version: 1, drafts: { entry: draft } });
  });

  it('clears only assessment drafts on logout', () => {
    const storage = new MemoryStorage();
    storage.setItem('keiba:assessment:user:race', '{}'); storage.setItem('keiba:assessment:other:race', '{}'); storage.setItem('unrelated', 'keep');
    expect(clearAssessmentDraftStorage(storage)).toBe(2);
    expect(storage.getItem('unrelated')).toBe('keep');
  });

  it('clears only the allowlisted operational session drafts', () => {
    const storage = new MemoryStorage();
    storage.setItem('keiba:race-manager:user:race-detail:race', 'race draft');
    storage.setItem('keiba:result-manager:user:quick-result:race', 'result draft');
    storage.setItem('keiba:prediction-editor:user:race', 'prediction draft');
    storage.setItem('keiba:other:user', 'keep'); storage.setItem('unrelated', 'keep');
    expect(clearStorageByPrefixes(storage, operationalSessionDraftPrefixes)).toBe(3);
    expect(storage.getItem('keiba:other:user')).toBe('keep');
    expect(storage.getItem('unrelated')).toBe('keep');
  });
});
