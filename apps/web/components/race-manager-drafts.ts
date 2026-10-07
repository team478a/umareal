export type QuickRaceDraft = { raceDate: string; raceClass: string; source: string; reason: string };
export type QuickEntryDraft = { source: string; reason: string };
export type RaceDetailDraft = {
  baseRevision: number | null;
  raceDate: string;
  venue: string;
  number: string;
  name: string;
  raceClass: string;
  distance: string;
  surface: string;
  direction: string;
  startsAt: string;
  going: string;
  weather: string;
  status: string;
  expertId: string;
  expertDisplayName: string;
  reason: string;
};
export type EntryDetailDraft = {
  raceRevision: number;
  entryId: string | null;
  number: string;
  gate: string;
  horseName: string;
  sex: string;
  age: string;
  carriedWeight: string;
  jockey: string;
  trainer: string;
  winOdds: string;
  popularity: string;
  status: string;
  reason: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function oneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}

function integerText(value: unknown, maximumDigits = 4): value is string {
  return typeof value === 'string' && (value === '' || new RegExp(`^\\d{1,${maximumDigits}}$`).test(value));
}

function decimalText(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || /^\d{1,4}(?:\.\d)?$/.test(value));
}

function optionalUuid(value: unknown): value is string {
  return value === '' || (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

export function raceManagerDraftKey(userId: string, kind: 'quick-races' | 'quick-entries' | 'race-detail' | 'entry-detail', scope?: string) {
  return `keiba:race-manager:${userId}:${kind}${scope ? `:${scope}` : ''}`;
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

export function parseRaceDetailDraft(raw: string | null): RaceDetailDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1
      || !(value.baseRevision === null || (Number.isInteger(value.baseRevision) && Number(value.baseRevision) > 0))
      || !text(value.raceDate, 10) || !(value.raceDate === '' || /^\d{4}-\d{2}-\d{2}$/.test(value.raceDate))
      || !oneOf(value.venue, ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'])
      || !integerText(value.number, 2) || !text(value.name, 100) || !text(value.raceClass, 60)
      || !integerText(value.distance, 4) || !oneOf(value.surface, ['TURF', 'DIRT'])
      || !oneOf(value.direction, ['LEFT', 'RIGHT', 'STRAIGHT'])
      || !text(value.startsAt, 16) || !(value.startsAt === '' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value.startsAt))
      || !oneOf(value.going, ['UNKNOWN', 'GOOD', 'YIELDING', 'SOFT', 'HEAVY'])
      || !text(value.weather, 30) || !oneOf(value.status, ['SCHEDULED', 'ACTIVE', 'DELAYED', 'FINISHED', 'CANCELLED'])
      || !optionalUuid(value.expertId) || !text(value.expertDisplayName, 80) || !text(value.reason, 500)) return null;
    return {
      baseRevision: value.baseRevision as number | null,
      raceDate: value.raceDate, venue: value.venue, number: value.number, name: value.name,
      raceClass: value.raceClass, distance: value.distance, surface: value.surface, direction: value.direction,
      startsAt: value.startsAt, going: value.going, weather: value.weather, status: value.status,
      expertId: value.expertId, expertDisplayName: value.expertDisplayName, reason: value.reason,
    };
  } catch { return null; }
}

export function parseEntryDetailDraft(raw: string | null): EntryDetailDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !Number.isInteger(value.raceRevision) || Number(value.raceRevision) <= 0
      || !(value.entryId === null || (typeof value.entryId === 'string' && optionalUuid(value.entryId)))
      || !integerText(value.number, 2) || !integerText(value.gate, 2) || !text(value.horseName, 80)
      || !oneOf(value.sex, ['', 'MALE', 'FEMALE', 'GELDING']) || !integerText(value.age, 2)
      || !decimalText(value.carriedWeight) || !text(value.jockey, 60) || !text(value.trainer, 60)
      || !decimalText(value.winOdds) || !integerText(value.popularity, 2)
      || !oneOf(value.status, ['ACTIVE', 'SCRATCHED', 'EXCLUDED', 'STOPPED']) || !text(value.reason, 500)) return null;
    return {
      raceRevision: value.raceRevision as number, entryId: value.entryId as string | null,
      number: value.number, gate: value.gate, horseName: value.horseName, sex: value.sex, age: value.age,
      carriedWeight: value.carriedWeight, jockey: value.jockey, trainer: value.trainer,
      winOdds: value.winOdds, popularity: value.popularity, status: value.status, reason: value.reason,
    };
  } catch { return null; }
}

export function isRaceDetailDraftCurrent(draft: RaceDetailDraft, revision: number | null) {
  return draft.baseRevision === revision;
}

export function isEntryDetailDraftCurrent(draft: EntryDetailDraft, raceRevision: number, entryId: string | null) {
  return draft.raceRevision === raceRevision && draft.entryId === entryId;
}

export function encodeSessionDraft(value: QuickRaceDraft | QuickEntryDraft | RaceDetailDraft | EntryDetailDraft) {
  return JSON.stringify({ version: 1, ...value });
}
