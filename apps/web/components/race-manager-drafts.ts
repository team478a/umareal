export type QuickRaceDraft = { raceDate: string; raceClass: string; source: string; reason: string };
export type QuickEntryDraft = { source: string; reason: string };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

export function raceManagerDraftKey(userId: string, kind: 'quick-races' | 'quick-entries', raceId?: string) {
  return `keiba:race-manager:${userId}:${kind}${raceId ? `:${raceId}` : ''}`;
}

export function parseQuickRaceDraft(raw: string | null): QuickRaceDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !text(value.raceDate, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value.raceDate)
      || !text(value.raceClass, 60) || !text(value.source, 20_000) || !text(value.reason, 500)) return null;
    return { raceDate: value.raceDate, raceClass: value.raceClass, source: value.source, reason: value.reason };
  } catch { return null; }
}

export function parseQuickEntryDraft(raw: string | null): QuickEntryDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !text(value.source, 5_000) || !text(value.reason, 500)) return null;
    return { source: value.source, reason: value.reason };
  } catch { return null; }
}

export function encodeSessionDraft(value: QuickRaceDraft | QuickEntryDraft) {
  return JSON.stringify({ version: 1, ...value });
}
