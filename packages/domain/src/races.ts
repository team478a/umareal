import { z } from 'zod';

export const venues = ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'] as const;
export const raceStatuses = ['SCHEDULED', 'ACTIVE', 'DELAYED', 'FINISHED', 'CANCELLED'] as const;
export const entryStatuses = ['ACTIVE', 'SCRATCHED', 'EXCLUDED', 'STOPPED'] as const;
const raceDiscoveryDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);
const text = (max: number) => z.string().trim().min(1).max(max).refine(v => !/^[=+@\-\t\r]/.test(v) && !Array.from(v).some(c => { const n = c.charCodeAt(0); return n < 32 && n !== 9 && n !== 10 && n !== 13; }), '数式や制御文字で始まる値は使用できません。');
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, '有効な日付を入力してください。');
export const raceDaySchema = z.object({ raceDate: dateSchema, venue: z.enum(venues) }).strict();
export const raceFieldsSchema = raceDaySchema.extend({
  number: z.number().int().min(1).max(12), name: text(100), raceClass: text(60),
  distance: z.number().int().min(400).max(5000), surface: z.enum(['TURF', 'DIRT']), direction: z.enum(['RIGHT', 'LEFT', 'STRAIGHT']),
  startsAt: z.string().datetime({ offset: true }), going: z.enum(['GOOD', 'YIELDING', 'SOFT', 'HEAVY', 'UNKNOWN']),
  weather: text(30), status: z.enum(raceStatuses), expertId: z.string().uuid().nullable()
}).strict();
export const raceInputSchema = raceFieldsSchema.refine(v => {
  const date = new Date(new Date(v.startsAt).getTime() + 9 * 3600000);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v.raceDate;
}, { path: ['startsAt'], message: '発走時刻のJST日付を開催日に合わせてください。' });
export const entryInputSchema = z.object({
  horseId: z.string().uuid(), number: z.number().int().min(1).max(18), gate: z.number().int().min(1).max(8), horseName: text(80),
  sex: z.enum(['MALE', 'FEMALE', 'GELDING']), age: z.number().int().min(2).max(30),
  carriedWeight: z.number().min(30).max(80).multipleOf(0.1), jockey: text(60), trainer: text(60),
  winOdds: z.number().min(1).max(99999.9).multipleOf(0.1).nullable(), popularity: z.number().int().min(1).max(18).nullable(), status: z.enum(entryStatuses)
}).strict();
export type RaceInput = z.infer<typeof raceInputSchema>;
export type EntryInput = z.infer<typeof entryInputSchema>;

export const publicRaceListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  date: dateSchema.optional(),
  dateFrom: dateSchema.optional(),
  dateTo: dateSchema.optional(),
  publication: z.enum(['ALL', 'ANNOUNCED', 'PUBLISHED', 'UNPUBLISHED']).default('ALL'),
  result: z.enum(['ALL', 'CONFIRMED', 'PENDING']).default('ALL'),
  venue: z.string().trim().min(1).max(60).optional(),
  keyword: z.string().trim().min(1).max(80).optional()
}).strict().superRefine((value, context) => {
  if (value.date && (value.dateFrom || value.dateTo)) context.addIssue({ code: 'custom', path: ['date'], message: '開催日指定と期間指定は同時に使用できません。' });
  if (!!value.dateFrom !== !!value.dateTo) context.addIssue({ code: 'custom', path: ['dateFrom'], message: '期間の開始日と終了日を両方指定してください。' });
  if (value.dateFrom && value.dateTo) {
    const from = new Date(`${value.dateFrom}T00:00:00Z`).getTime();
    const to = new Date(`${value.dateTo}T00:00:00Z`).getTime();
    if (from > to) context.addIssue({ code: 'custom', path: ['dateTo'], message: '終了日は開始日以降を指定してください。' });
    if ((to - from) / 86400000 > 92) context.addIssue({ code: 'custom', path: ['dateTo'], message: '検索期間は93日以内にしてください。' });
  }
});

const publicRaceListItemSchema = z.object({
    id: z.string().uuid(),
    raceDate: dateSchema,
    venue: z.string(),
    number: z.number().int().positive(),
    name: z.string(),
    startsAt: raceDiscoveryDateTimeSchema,
    status: z.enum(raceStatuses),
    raceDayId: z.string().uuid().nullable(),
    raceClass: z.string().nullable(),
    distance: z.number().int().positive().nullable(),
    surface: z.string().nullable(),
    direction: z.string().nullable(),
    going: z.string().nullable(),
    weather: z.string().nullable(),
    revision: z.number().int().positive(),
    latestAnnouncement: z.object({
      version: z.number().int().positive(),
      publishedAt: raceDiscoveryDateTimeSchema
    }).strict().nullable(),
    latestPrediction: z.object({
      version: z.number().int().positive(),
      status: z.enum(['PUBLISHED', 'CORRECTED']),
      visibility: z.enum(['FREE', 'PAID']),
      publishedAt: raceDiscoveryDateTimeSchema
    }).strict().nullable(),
    latestResult: z.object({
      version: z.number().int().positive(),
      raceCanceled: z.boolean(),
      confirmedAt: raceDiscoveryDateTimeSchema
    }).strict().nullable()
  }).strict();

export const publicRaceListResponseSchema = z.object({
  items: z.array(publicRaceListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(50),
  filters: z.object({
    date: dateSchema.nullable(),
    dateFrom: dateSchema,
    dateTo: dateSchema,
    publication: z.enum(['ALL', 'ANNOUNCED', 'PUBLISHED', 'UNPUBLISHED']),
    result: z.enum(['ALL', 'CONFIRMED', 'PENDING']),
    venue: z.string().nullable(),
    keyword: z.string().nullable(),
    venues: z.array(z.string())
  }).strict()
}).strict();

export type PublicRaceListQuery = z.infer<typeof publicRaceListQuerySchema>;
export type PublicRaceListResponse = z.infer<typeof publicRaceListResponseSchema>;

export const expertRaceListResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    raceDate: dateSchema,
    venue: z.string().min(1),
    number: z.number().int().min(1).max(12),
    name: z.string().min(1),
    startsAt: raceDiscoveryDateTimeSchema,
    status: z.enum(raceStatuses)
  }).strict()).max(50)
}).strict();

export type ExpertRaceListResponse = z.infer<typeof expertRaceListResponseSchema>;

export const publicRaceAnnouncementsResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    publishedAt: raceDiscoveryDateTimeSchema,
    race: z.object({
      id: z.string().uuid(),
      raceDate: dateSchema,
      venue: z.string().min(1),
      number: z.number().int().min(1).max(12),
      name: z.string().min(1),
      startsAt: raceDiscoveryDateTimeSchema
    }).strict()
  }).strict()).max(10)
}).strict();

export type PublicRaceAnnouncementsResponse = z.infer<typeof publicRaceAnnouncementsResponseSchema>;
export type ImportKind = 'races' | 'entries';
export const raceHeaders = ['raceDate', 'venue', 'number', 'name', 'raceClass', 'distance', 'surface', 'direction', 'startsAt', 'going', 'weather', 'status', 'expertId'];
export const entryHeaders = ['horseId', 'number', 'gate', 'horseName', 'sex', 'age', 'carriedWeight', 'jockey', 'trainer', 'winOdds', 'popularity', 'status'];
export type CsvIssue = { row: number; field: string; message: string };

export type QuickRaceParseResult = { races: RaceInput[]; errors: CsvIssue[] };

/**
 * Parses the small, human-readable race list used by the operations screen.
 * The result still goes through the existing CSV preview API before it can be saved.
 */
export function parseQuickRaceList(input: { raceDate: string; raceClass: string; text: string }): QuickRaceParseResult {
  const result: QuickRaceParseResult = { races: [], errors: [] };
  const checkedDate = dateSchema.safeParse(input.raceDate);
  if (!checkedDate.success) result.errors.push({ row: 0, field: 'raceDate', message: '有効な開催日を選択してください。' });
  const checkedClass = text(60).safeParse(input.raceClass);
  if (!checkedClass.success) result.errors.push({ row: 0, field: 'raceClass', message: 'クラスを1〜60文字で入力してください。' });
  if (input.text.length > 20000) result.errors.push({ row: 0, field: 'text', message: '貼り付け内容は20,000文字以内にしてください。' });
  if (result.errors.length) return result;

  let currentVenue: typeof venues[number] | null = null;
  const keys = new Set<string>();
  const lines = input.text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const row = index + 1;
    const line = lines[index].trim().replace(/[\u3000\t]+/g, ' ').replace(/：/g, ':');
    if (!line) continue;
    const venueText = line.replace(/[：:]$/, '').replace(/競馬場$/, '').trim();
    if ((venues as readonly string[]).includes(venueText)) {
      currentVenue = venueText as typeof venues[number];
      continue;
    }
    if (!currentVenue) {
      result.errors.push({ row, field: 'venue', message: 'レースより前に競馬場名を1行で入力してください。' });
      continue;
    }
    const match = /^(\d{1,2})\s*[RrＲ]\s+(.+?)\s+(\d{1,2}):(\d{2})\s+(芝|ダート|ダ)\s*(\d{3,4})\s*[mｍ]?\s+(右(?:回り)?|左(?:回り)?|直線)$/.exec(line);
    if (!match) {
      result.errors.push({ row, field: 'text', message: '「9R レース名 14:35 芝1800 左」の形式で入力してください。' });
      continue;
    }
    const number = Number(match[1]);
    const hour = Number(match[3]);
    const minute = Number(match[4]);
    if (number < 1 || number > 12 || hour > 23 || minute > 59) {
      result.errors.push({ row, field: number < 1 || number > 12 ? 'number' : 'startsAt', message: number < 1 || number > 12 ? 'レース番号は1〜12にしてください。' : '有効な発走時刻を入力してください。' });
      continue;
    }
    const key = `${input.raceDate}:${currentVenue}:${number}`;
    if (keys.has(key)) {
      result.errors.push({ row, field: 'number', message: '同じ競馬場のレース番号が重複しています。' });
      continue;
    }
    keys.add(key);
    const direction = match[7].startsWith('右') ? 'RIGHT' : match[7].startsWith('左') ? 'LEFT' : 'STRAIGHT';
    const candidate: RaceInput = {
      raceDate: input.raceDate,
      venue: currentVenue,
      number,
      name: match[2].trim(),
      raceClass: input.raceClass.trim(),
      distance: Number(match[6]),
      surface: match[5] === '芝' ? 'TURF' : 'DIRT',
      direction,
      startsAt: new Date(`${input.raceDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`).toISOString(),
      going: 'UNKNOWN',
      weather: '未確認',
      status: 'SCHEDULED',
      expertId: null
    };
    const checked = raceInputSchema.safeParse(candidate);
    if (!checked.success) {
      checked.error.issues.forEach(issue => result.errors.push({ row, field: issue.path.join('.'), message: issue.message }));
      continue;
    }
    result.races.push(checked.data);
  }
  if (!result.races.length && !result.errors.length) result.errors.push({ row: 0, field: 'text', message: '登録するレースを入力してください。' });
  if (result.races.length > 36) result.errors.push({ row: 0, field: 'text', message: '一度に登録できるのは36レースまでです。' });
  return result;
}

function quoteCsvField(value: unknown) {
  const textValue = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
}

export function serializeRaceCsv(races: readonly RaceInput[]) {
  return [raceHeaders.join(','), ...races.map(race => raceHeaders.map(header => quoteCsvField(race[header as keyof RaceInput])).join(','))].join('\n');
}

// RFC 4180-style field quoting. Limits are deliberately small for a 3–5-race/day workflow.
export function parseCsv(csv: string): string[][] {
  if (csv.length > 90000) throw new Error('CSVは90,000文字以内にしてください。');
  const source = csv.replace(/^\uFEFF/, '');
  const rows: string[][] = []; let row: string[] = [], value = '', quoted = false, closed = false;
  const field = () => { row.push(value); value = ''; closed = false; };
  const finish = () => { field(); if (row.some(v => v !== '')) rows.push(row); row = []; if (rows.length > 201) throw new Error('CSVは200データ行以内にしてください。'); };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (c === '"') { if (source[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } } else value += c; }
    else if (c === ',') field();
    else if (c === '\n' || c === '\r') { if (c === '\r' && source[i + 1] === '\n') i++; finish(); }
    else if (c === '"' && value === '' && !closed) quoted = true;
    else if (c === '"' || closed) throw new Error('CSVの引用符が正しくありません。');
    else value += c;
  }
  if (quoted) throw new Error('CSVの引用符が閉じていません。');
  if (value !== '' || row.length || closed) finish();
  return rows;
}
export interface RaceDataProvider {
  parse(kind: ImportKind, source: string): { races: RaceInput[]; entries: EntryInput[]; errors: CsvIssue[] };
}
export class CsvRaceDataProvider implements RaceDataProvider {
  parse(kind: ImportKind, source: string) {
    const result: ReturnType<RaceDataProvider['parse']> = { races: [], entries: [], errors: [] };
    let rows: string[][];
    try { rows = parseCsv(source); } catch (e) { result.errors.push({ row: 0, field: 'csv', message: (e as Error).message }); return result; }
    const headers = kind === 'races' ? raceHeaders : entryHeaders;
    if (!rows.length || rows[0].join(',') !== headers.join(',')) { result.errors.push({ row: 1, field: 'header', message: `見出しは次の順序にしてください：${headers.join(',')}` }); return result; }
    if (rows.length === 1) result.errors.push({ row: 2, field: 'csv', message: 'データ行がありません。' });
    const keys = new Set<string>(); const horses = new Set<string>();
    rows.slice(1).forEach((row, index) => {
      const rowNumber = index + 2;
      if (row.length !== headers.length) { result.errors.push({ row: rowNumber, field: 'csv', message: '列数が見出しと一致しません。' }); return; }
      const record: Record<string, unknown> = Object.fromEntries(headers.map((h, i) => [h, row[i].trim()]));
      const numbers = kind === 'races' ? ['number', 'distance'] : ['number', 'gate', 'age', 'carriedWeight', 'winOdds', 'popularity'];
      for (const key of numbers) record[key] = record[key] === '' ? null : Number(record[key]);
      if (kind === 'races' && record.expertId === '') record.expertId = null;
      const parsed = kind === 'races' ? raceInputSchema.safeParse(record) : entryInputSchema.safeParse(record);
      if (!parsed.success) { for (const issue of parsed.error.issues) result.errors.push({ row: rowNumber, field: issue.path.join('.'), message: issue.message }); return; }
      const key = kind === 'races' ? `${record.raceDate}:${record.venue}:${record.number}` : String(record.number);
      if (keys.has(key)) result.errors.push({ row: rowNumber, field: 'number', message: 'CSV内でレースまたは馬番が重複しています。' });
      keys.add(key);
      if (kind === 'entries') {
        if (horses.has(String(record.horseId))) result.errors.push({ row: rowNumber, field: 'horseId', message: '同じ馬IDが重複しています。' });
        horses.add(String(record.horseId)); result.entries.push(parsed.data as EntryInput);
      } else result.races.push(parsed.data as RaceInput);
    });
    return result;
  }
}

export const jraVanBundleFormatVersion = 'UMAREAL_JRA_VAN_BUNDLE_V1' as const;
const bundleSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const bundleFileSchema = z.object({
  kind: z.enum(['RACES', 'ENTRIES', 'RESULTS']), path: z.string().min(1).max(160),
  rowCount: z.number().int().positive().max(648), sha256: bundleSha256
}).strict();
export const jraVanBundleManifestSchema = z.object({
  formatVersion: z.literal(jraVanBundleFormatVersion), targetDate: dateSchema,
  raceCount: z.number().int().positive().max(36), entryRaceCount: z.number().int().positive().max(36),
  entryCount: z.number().int().positive().max(648), finalizedRaceCount: z.number().int().nonnegative().max(36),
  resultsIncluded: z.boolean(), sampleData: z.boolean().optional().default(false),
  source: z.object({
    raRecordCount: z.number().int().positive().max(100000), raSha256: bundleSha256,
    seRecordCount: z.number().int().positive().max(100000), seSha256: bundleSha256
  }).strict(),
  files: z.array(bundleFileSchema).min(2).max(38),
  collection: z.record(z.string(), z.number().int().nonnegative()).optional()
}).strict();
export type JraVanBundleManifest = z.infer<typeof jraVanBundleManifestSchema>;
export type JraVanBundleEntryFile = { path: string; csv: string };
export type JraVanBundleEntryGroup = { path: string; raceDate: string; venue: typeof venues[number]; number: number; entries: EntryInput[] };
export type JraVanBundleParseResult = {
  manifest: JraVanBundleManifest | null; races: RaceInput[]; entryGroups: JraVanBundleEntryGroup[]; errors: CsvIssue[];
};
const venueCodes = Object.fromEntries(venues.map((venue, index) => [String(index + 1).padStart(2, '0'), venue])) as Record<string, typeof venues[number]>;
const entryPathPattern = /^entries\/(\d{4}-\d{2}-\d{2})-(0[1-9]|10)-(0[1-9]|1[0-2])R\.csv$/;

export function parseJraVanRaceBundle(
  input: { manifest: string; racesCsv: string; entries: JraVanBundleEntryFile[] },
  checksum: (value: string) => string
): JraVanBundleParseResult {
  const result: JraVanBundleParseResult = { manifest: null, races: [], entryGroups: [], errors: [] };
  let rawManifest: unknown;
  try { rawManifest = JSON.parse(input.manifest); }
  catch { result.errors.push({ row: 0, field: 'manifest', message: 'manifest.jsonを解析できません。' }); return result; }
  const checkedManifest = jraVanBundleManifestSchema.safeParse(rawManifest);
  if (!checkedManifest.success) {
    checkedManifest.error.issues.forEach(issue => result.errors.push({ row: 0, field: `manifest.${issue.path.join('.')}`, message: issue.message }));
    return result;
  }
  const manifest = checkedManifest.data; result.manifest = manifest;
  if (manifest.sampleData) result.errors.push({ row: 0, field: 'manifest.sampleData', message: 'リハーサル用の合成データは管理画面へ取り込めません。' });
  const metadataByPath = new Map<string, z.infer<typeof bundleFileSchema>>();
  for (const file of manifest.files) {
    if (metadataByPath.has(file.path)) result.errors.push({ row: 0, field: 'manifest.files', message: `ファイルが重複しています: ${file.path}` });
    metadataByPath.set(file.path, file);
  }
  const raceMetadata = manifest.files.filter(file => file.kind === 'RACES');
  const entryMetadata = manifest.files.filter(file => file.kind === 'ENTRIES');
  const resultMetadata = manifest.files.filter(file => file.kind === 'RESULTS');
  if (raceMetadata.length !== 1 || raceMetadata[0]?.path !== 'races.csv') result.errors.push({ row: 0, field: 'manifest.files', message: 'RACESはraces.csvを1件だけ指定してください。' });
  if (entryMetadata.length !== manifest.entryRaceCount) result.errors.push({ row: 0, field: 'manifest.entryRaceCount', message: '出走馬ファイル数がmanifestと一致しません。' });
  if (manifest.resultsIncluded !== (resultMetadata.length === 1) || resultMetadata.length > 1 || (resultMetadata[0] && resultMetadata[0].path !== 'results.csv')) result.errors.push({ row: 0, field: 'manifest.resultsIncluded', message: '結果ファイル情報がmanifestと一致しません。' });
  if (manifest.finalizedRaceCount > manifest.raceCount || (manifest.resultsIncluded ? manifest.finalizedRaceCount < 1 : manifest.finalizedRaceCount !== 0)) result.errors.push({ row: 0, field: 'manifest.finalizedRaceCount', message: '確定結果レース数が不正です。' });

  if (raceMetadata[0] && checksum(input.racesCsv) !== raceMetadata[0].sha256) result.errors.push({ row: 0, field: 'races.csv', message: 'races.csvのSHA-256がmanifestと一致しません。' });
  const provider = new CsvRaceDataProvider();
  const parsedRaces = provider.parse('races', input.racesCsv);
  result.errors.push(...parsedRaces.errors.map(issue => ({ ...issue, field: `races.csv.${issue.field}` })));
  result.races = parsedRaces.races;
  if (parsedRaces.races.length !== manifest.raceCount || raceMetadata[0]?.rowCount !== parsedRaces.races.length) result.errors.push({ row: 0, field: 'manifest.raceCount', message: 'レース件数がmanifestと一致しません。' });
  if (parsedRaces.races.some(race => race.raceDate !== manifest.targetDate)) result.errors.push({ row: 0, field: 'targetDate', message: 'races.csvに対象日以外のレースがあります。' });

  const uploaded = new Map<string, string>();
  for (const file of input.entries) {
    if (uploaded.has(file.path)) result.errors.push({ row: 0, field: 'entries', message: `出走馬ファイルが重複しています: ${file.path}` });
    uploaded.set(file.path, file.csv);
  }
  const expectedPaths = new Set(entryMetadata.map(file => file.path));
  for (const path of expectedPaths) if (!uploaded.has(path)) result.errors.push({ row: 0, field: 'entries', message: `出走馬ファイルが不足しています: ${path}` });
  for (const path of uploaded.keys()) if (!expectedPaths.has(path)) result.errors.push({ row: 0, field: 'entries', message: `manifestにない出走馬ファイルです: ${path}` });

  for (const metadata of entryMetadata) {
    const csv = uploaded.get(metadata.path); if (csv === undefined) continue;
    const match = entryPathPattern.exec(metadata.path);
    if (!match || match[1] !== manifest.targetDate) { result.errors.push({ row: 0, field: 'manifest.files.path', message: `出走馬ファイル名が不正です: ${metadata.path}` }); continue; }
    if (checksum(csv) !== metadata.sha256) result.errors.push({ row: 0, field: metadata.path, message: 'SHA-256がmanifestと一致しません。' });
    const parsed = provider.parse('entries', csv);
    result.errors.push(...parsed.errors.map(issue => ({ ...issue, field: `${metadata.path}.${issue.field}` })));
    if (parsed.entries.length !== metadata.rowCount || parsed.entries.length > 18) result.errors.push({ row: 0, field: metadata.path, message: '出走馬件数がmanifestと一致しないか18頭を超えています。' });
    result.entryGroups.push({ path: metadata.path, raceDate: match[1], venue: venueCodes[match[2]], number: Number(match[3]), entries: parsed.entries });
  }
  const raceKeys = new Set(result.races.map(race => `${race.raceDate}:${race.venue}:${race.number}`));
  const groupKeys = result.entryGroups.map(group => `${group.raceDate}:${group.venue}:${group.number}`);
  if (new Set(groupKeys).size !== groupKeys.length) result.errors.push({ row: 0, field: 'entries', message: '同じレースの出走馬ファイルが重複しています。' });
  for (const key of raceKeys) if (!groupKeys.includes(key)) result.errors.push({ row: 0, field: 'entries', message: `出走馬ファイルがないレースです: ${key}` });
  for (const key of groupKeys) if (!raceKeys.has(key)) result.errors.push({ row: 0, field: 'entries', message: `races.csvにないレースの出走馬ファイルです: ${key}` });
  const entryCount = result.entryGroups.reduce((total, group) => total + group.entries.length, 0);
  if (entryCount !== manifest.entryCount) result.errors.push({ row: 0, field: 'manifest.entryCount', message: '出走馬総数がmanifestと一致しません。' });
  return result;
}
