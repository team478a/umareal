import { assessmentSaveSchema, type AssessmentSaveInput } from '@keiba/domain';

export const assessmentDraftStoragePrefix = 'keiba:assessment:';
export const assessmentDraftRetentionMs = 24 * 60 * 60 * 1000;
export const operationalSessionDraftPrefixes = ['keiba:race-manager:', 'keiba:result-manager:', 'keiba:prediction-editor:'] as const;

type Drafts = Record<string, AssessmentSaveInput>;
type DraftEnvelope = { version: 1; updatedAt: string; expiresAt: string; drafts: Drafts };
type DraftReadResult = { raw: string | null; drafts: Drafts; expired: boolean; migrated: boolean };

function validDrafts(value: unknown): Drafts {
  const drafts: Drafts = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return drafts;
  for (const [entryId, draft] of Object.entries(value)) {
    const parsed = assessmentSaveSchema.safeParse(draft);
    if (parsed.success) drafts[entryId] = parsed.data;
  }
  return drafts;
}

function envelope(drafts: Drafts, now: number): DraftEnvelope {
  return {
    version: 1,
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + assessmentDraftRetentionMs).toISOString(),
    drafts
  };
}

export function readAssessmentDrafts(storage: Storage, key: string, now = Date.now()): DraftReadResult {
  const original = storage.getItem(key);
  if (!original) return { raw: null, drafts: {}, expired: false, migrated: false };
  try {
    const parsed = JSON.parse(original) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'version' in parsed) {
      const candidate = parsed as Partial<DraftEnvelope>;
      const expiresAt = typeof candidate.expiresAt === 'string' ? Date.parse(candidate.expiresAt) : Number.NaN;
      if (candidate.version !== 1 || !Number.isFinite(expiresAt) || expiresAt <= now) {
        storage.removeItem(key);
        return { raw: null, drafts: {}, expired: Number.isFinite(expiresAt) && expiresAt <= now, migrated: false };
      }
      const drafts = validDrafts(candidate.drafts);
      if (!Object.keys(drafts).length) {
        storage.removeItem(key);
        return { raw: null, drafts: {}, expired: false, migrated: false };
      }
      return { raw: original, drafts, expired: false, migrated: false };
    }

    // Releases before the retention policy stored the draft map directly.
    // Preserve recoverable input once, but move it into the expiring envelope.
    const drafts = validDrafts(parsed);
    if (!Object.keys(drafts).length) {
      storage.removeItem(key);
      return { raw: null, drafts: {}, expired: false, migrated: false };
    }
    const raw = JSON.stringify(envelope(drafts, now));
    storage.setItem(key, raw);
    return { raw, drafts, expired: false, migrated: true };
  } catch {
    storage.removeItem(key);
    return { raw: null, drafts: {}, expired: false, migrated: false };
  }
}

export function writeAssessmentDrafts(storage: Storage, key: string, drafts: Drafts, expectedRaw: string | null, now = Date.now()) {
  if (storage.getItem(key) !== expectedRaw) throw new Error('別のタブで一時保存が変更されました。このタブの内容を確認してから再読み込みしてください。');
  if (!Object.keys(drafts).length) {
    storage.removeItem(key);
    return null;
  }
  const raw = JSON.stringify(envelope(drafts, now));
  storage.setItem(key, raw);
  return raw;
}

export function clearAssessmentDraftStorage(storage: Storage) {
  return clearStorageByPrefixes(storage, [assessmentDraftStoragePrefix]);
}

export function clearStorageByPrefixes(storage: Storage, prefixes: readonly string[]) {
  let removed = 0;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key && prefixes.some(prefix => key.startsWith(prefix))) {
      storage.removeItem(key);
      removed += 1;
    }
  }
  return removed;
}

export function clearBrowserAssessmentDraftStorage() {
  try { return clearAssessmentDraftStorage(window.localStorage); }
  catch { return 0; }
}

export function clearBrowserOperationalDraftStorage() {
  const assessments = clearBrowserAssessmentDraftStorage();
  try { return assessments + clearStorageByPrefixes(window.sessionStorage, operationalSessionDraftPrefixes); }
  catch { return assessments; }
}
