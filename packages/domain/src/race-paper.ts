import { z } from 'zod';
import { dateSchema, venues } from './races';

export const paperSymbols = ['◎', '○', '▲', '△', '✕', '☆'] as const;
export const paperDisclaimer = '本予想は馬の評価を提供するものです。具体的な組み合わせや購入金額は指定していません。馬券を購入する場合は、ご自身の判断と責任で行ってください。';
const dateTime = z.preprocess(v => v instanceof Date ? v.toISOString() : v, z.string().datetime({ offset: true }));
const mark = z.object({ entryId: z.string().uuid(), symbol: z.enum(paperSymbols), reason: z.string().trim().max(1000).default('') }).strict();
export const racePaperDraftSchema = z.object({
  targetDate: dateSchema, title: z.string().trim().min(1).max(100),
  accessScope: z.enum(['MEMBERS', 'PAID']), summary: z.string().trim().max(5000),
  races: z.array(z.object({ raceId: z.string().uuid(), marks: z.array(mark).min(1).max(18) }).strict()).min(1).max(12)
}).strict().superRefine((v, ctx) => {
  const ids = new Set<string>();
  v.races.forEach((race, i) => {
    if (ids.has(race.raceId)) ctx.addIssue({ code: 'custom', path: ['races', i], message: '同じレースが重複しています。' });
    ids.add(race.raceId);
    if (race.marks.filter(m => m.symbol === '◎').length !== 1) ctx.addIssue({ code: 'custom', path: ['races', i, 'marks'], message: '各レースに◎を1頭設定してください。' });
    if (new Set(race.marks.map(m => m.entryId)).size !== race.marks.length) ctx.addIssue({ code: 'custom', path: ['races', i, 'marks'], message: '同じ馬に複数の印は設定できません。' });
  });
});
export type RacePaperDraft = z.infer<typeof racePaperDraftSchema>;
export const racePaperSnapshotSchema = z.object({
  targetDate: dateSchema, title: z.string().min(1).max(100), accessScope: z.enum(['MEMBERS', 'PAID']), summary: z.string().max(5000),
  races: z.array(z.object({
    raceId: z.string().uuid(), venue: z.string(), number: z.number().int().min(1).max(12), name: z.string(), startsAt: dateTime,
    marks: z.array(mark.extend({ number: z.number().int().min(1).max(18), horseName: z.string().min(1) })).min(1).max(18)
  }).strict()).min(1).max(12)
}).strict();
export type RacePaperSnapshot = z.infer<typeof racePaperSnapshotSchema>;
export const racePaperImportSchema = z.object({ targetDate: dateSchema, title: z.string().trim().min(1).max(100), accessScope: z.enum(['MEMBERS', 'PAID']), summary: z.string().trim().max(5000).default(''), text: z.string().min(1).max(20000) }).strict();
export const racePaperSaveSchema = z.object({ id: z.string().uuid(), revision: z.number().int().nonnegative(), draft: racePaperDraftSchema, reason: z.string().trim().min(1).max(500) }).strict();
export const racePaperPreviewInputSchema = z.object({ revision: z.number().int().positive(), correctionReason: z.string().trim().max(500).default('') }).strict();
export const racePaperMetadataSchema = z.object({ id: z.string().uuid(), version: z.number().int().positive(), publishedAt: dateTime, targetDate: dateSchema, title: z.string(), accessScope: z.enum(['MEMBERS', 'PAID']), correctionReason: z.string().nullable() }).strict();
export const racePaperPreviewSchema = z.object({ previewId: z.string().uuid(), expiresAt: dateTime, deadlineAt: dateTime, version: z.number().int().positive(), correctionReason: z.string(), snapshot: racePaperSnapshotSchema, notificationText: z.string() }).strict();
export type RacePaperPreview = z.infer<typeof racePaperPreviewSchema>;
export const racePaperWorkspaceSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive(), draft: racePaperDraftSchema, snapshot: racePaperSnapshotSchema, versions: z.array(racePaperMetadataSchema) }).strict();
export type RacePaperWorkspace = z.infer<typeof racePaperWorkspaceSchema>;
export const racePaperListSchema = z.object({ items: z.array(racePaperMetadataSchema), page: z.number().int().positive(), total: z.number().int().nonnegative() }).strict();
export type RacePaperList = z.infer<typeof racePaperListSchema>;
export const racePaperReadSchema = z.object({ id: z.string().uuid(), versions: z.array(z.discriminatedUnion('locked', [racePaperMetadataSchema.extend({ locked: z.literal(true) }), racePaperMetadataSchema.extend({ locked: z.literal(false), snapshot: racePaperSnapshotSchema })])) }).strict();
export type RacePaperRead = z.infer<typeof racePaperReadSchema>;

export type ParsedPaperRace = { venue: typeof venues[number]; number: number; name: string; marks: { symbol: typeof paperSymbols[number]; number: number; horseName: string }[] };
export function paperNameKey(value: string) { return value.normalize('NFKC').replace(/\s/g, '').replace(/C$/, 'カップ'); }
/** Deterministic transcription only; never generates or reinterprets a prediction. */
export function parseRacePaper(text: string): { races: ParsedPaperRace[]; errors: string[] } {
  const races: ParsedPaperRace[] = []; const errors: string[] = [];
  let venue: typeof venues[number] | undefined; let current: ParsedPaperRace | undefined;
  if (text.length > 20000) return { races, errors: ['原稿は20,000文字以内にしてください。'] };
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.normalize('NFKC').trim(); if (!line) return;
    if (venues.includes(line as typeof venues[number])) { venue = line as typeof venues[number]; current = undefined; return; }
    const header = line.match(/^(\d{1,2})R\s+(.+)$/i);
    if (header) {
      if (!venue || +header[1] < 1 || +header[1] > 12) { errors.push(`${i + 1}行目：競馬場とレース番号を確認してください。`); current = undefined; return; }
      current = { venue, number: +header[1], name: header[2].trim(), marks: [] }; races.push(current); return;
    }
    const selection = line.match(/^([◎○◯▲△✕×✖☆])\s*(\d{1,2})\s*[・.、:-]\s*(.+)$/);
    if (selection && current) {
      const symbol = selection[1] === '◯' ? '○' : ['×', '✖'].includes(selection[1]) ? '✕' : selection[1];
      current.marks.push({ symbol: symbol as typeof paperSymbols[number], number: +selection[2], horseName: selection[3].trim() }); return;
    }
    // Only the supplied greeting may precede the first venue; other text is never silently discarded.
    if (!venue && /^(明日の紙面予想です。[\s]*|宜しくお願いいたします。|よろしくお願いいたします。)$/.test(line)) return;
    errors.push(`${i + 1}行目：読み取れません。「東京」「9R 八ヶ岳特別」「◎4・馬名」の形式で入力してください。`);
  });
  if (!races.length || races.length > 12) errors.push('対象レースは1〜12件にしてください。');
  const seen = new Set<string>();
  for (const r of races) {
    const key = `${r.venue}${r.number}R`;
    if (seen.has(key)) errors.push(`${key}が重複しています。`); seen.add(key);
    if (r.marks.filter(m => m.symbol === '◎').length !== 1) errors.push(`${key}：◎を1頭指定してください。`);
    if (r.marks.length > 18 || new Set(r.marks.map(m => m.number)).size !== r.marks.length || r.marks.some(m => m.number < 1 || m.number > 18 || m.horseName.length > 80)) errors.push(`${key}：馬番の範囲・重複・馬名を確認してください。`);
  }
  return { races, errors };
}

export function buildRacePaperNotice(input: { id: string; title: string; targetDate: string; version: number; appBaseUrl: string }) {
  const id = z.string().uuid().parse(input.id);
  return { type: 'text' as const, text: `【通常レース紙面${input.version > 1 ? ' 訂正版' : ''}】\n${input.targetDate}\n${input.title}\n第${input.version}版を公開しました。\n会員ページでご確認ください。\n${new URL(`/papers/${id}`, input.appBaseUrl).href}` };
}
