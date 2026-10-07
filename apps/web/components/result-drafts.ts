export type QuickResultDraft = {
  resultRevision: number;
  source: string;
  reason: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

export function quickResultDraftKey(userId: string, raceId: string) {
  return `keiba:result-manager:${userId}:quick-result:${raceId}`;
}

export function encodeQuickResultDraft(value: QuickResultDraft) {
  return JSON.stringify({ version: 1, ...value });
}

export function parseQuickResultDraft(raw: string | null): QuickResultDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !Number.isInteger(value.resultRevision) || Number(value.resultRevision) < 0
      || !text(value.source, 5_000) || !text(value.reason, 500)) return null;
    return { resultRevision: value.resultRevision as number, source: value.source, reason: value.reason };
  } catch { return null; }
}

export function isQuickResultDraftCurrent(draft: QuickResultDraft, resultRevision: number) {
  return draft.resultRevision === resultRevision;
}
