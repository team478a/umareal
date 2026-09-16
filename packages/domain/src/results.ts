import { z } from 'zod';
import { betTypes } from './predictions';
import { dateSchema, jraVanBundleManifestSchema, parseCsv, venues } from './races';

export const resultRuleVersion = 'VERSION_AUDIT_V1';
export const runnerResultStatuses = ['FINISHED', 'WITHDRAWN', 'EXCLUDED', 'DNF', 'CANCELED'] as const;
export const resultEntrySchema = z.object({ entryId: z.string().uuid(), status: z.enum(runnerResultStatuses), finishPosition: z.number().int().min(1).max(18).nullable(), popularity: z.number().int().min(1).max(18).nullable(), finalOdds: z.string().regex(/^\d{1,7}(\.\d)?$/).nullable() }).strict();
export type ResultEntry = z.infer<typeof resultEntrySchema>;
export const resultCsvHeaders = ['number', 'status', 'finishPosition', 'popularity', 'finalOdds'] as const;
export const resultCsvRowSchema = z.object({
  number: z.number().int().min(1).max(18), status: z.enum(runnerResultStatuses), finishPosition: z.number().int().min(1).max(18).nullable(),
  popularity: z.number().int().min(1).max(18).nullable(), finalOdds: z.string().regex(/^\d{1,7}(\.\d)?$/).nullable()
}).strict().superRefine((value, context) => {
  if (value.status === 'FINISHED' && value.finishPosition === null) context.addIssue({ code: 'custom', path: ['finishPosition'], message: '完走馬には着順が必要です。' });
  if (value.status !== 'FINISHED' && value.finishPosition !== null) context.addIssue({ code: 'custom', path: ['finishPosition'], message: '完走以外には着順を設定できません。' });
});
export type ResultCsvRow = z.infer<typeof resultCsvRowSchema>;
export type ResultCsvIssue = { row: number; field: string; message: string };
export const batchResultCsvHeaders = ['raceDate', 'venue', 'raceNumber', 'horseNumber', 'status', 'finishPosition', 'popularity', 'finalOdds'] as const;
export const batchResultCsvRowSchema = z.object({
  raceDate: dateSchema, venue: z.enum(venues), raceNumber: z.number().int().min(1).max(12), horseNumber: z.number().int().min(1).max(18),
  status: z.enum(runnerResultStatuses), finishPosition: z.number().int().min(1).max(18).nullable(), popularity: z.number().int().min(1).max(18).nullable(),
  finalOdds: z.string().regex(/^\d{1,7}(\.\d)?$/).nullable()
}).strict().superRefine((value, context) => {
  if (value.status === 'FINISHED' && value.finishPosition === null) context.addIssue({ code: 'custom', path: ['finishPosition'], message: '完走馬には着順が必要です。' });
  if (value.status !== 'FINISHED' && value.finishPosition !== null) context.addIssue({ code: 'custom', path: ['finishPosition'], message: '完走以外には着順を設定できません。' });
});
export type BatchResultCsvRow = z.infer<typeof batchResultCsvRowSchema>;

export const resultDataProviderIds = ['CANONICAL_CSV', 'JRA_VAN_BRIDGE_V1'] as const;
export const resultDataProviderIdSchema = z.enum(resultDataProviderIds);
export type ResultDataProviderId = z.infer<typeof resultDataProviderIdSchema>;
export type ResultDataProviderInfo = { id: ResultDataProviderId; label: string; formatVersion: string; headers: readonly string[] };
export type ResultDataProviderParseResult = { provider: ResultDataProviderInfo; rows: BatchResultCsvRow[]; errors: ResultCsvIssue[] };
export interface ResultDataProvider { info: ResultDataProviderInfo; parse(source: string): ResultDataProviderParseResult }

export const jraVanBridgeResultHeaders = ['recordType', 'raceDate', 'venueCode', 'raceNumber', 'horseNumber', 'abnormalCode', 'finishPosition', 'popularity', 'finalOdds', 'raceCanceled'] as const;
const jraVenueCodes: Record<string, typeof venues[number]> = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京',
  '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉'
};
const jraAbnormalStatuses: Record<string, typeof runnerResultStatuses[number]> = {
  '0': 'FINISHED', '1': 'WITHDRAWN', '2': 'EXCLUDED', '3': 'EXCLUDED',
  '4': 'DNF', '5': 'EXCLUDED', '6': 'FINISHED', '7': 'FINISHED'
};

class CanonicalResultDataProvider implements ResultDataProvider {
  info = { id: 'CANONICAL_CSV' as const, label: '内部標準CSV', formatVersion: 'UMAREAL_RESULTS_V1', headers: batchResultCsvHeaders };
  parse(source: string): ResultDataProviderParseResult { return { provider: this.info, ...parseBatchResultCsv(source) }; }
}

class JraVanBridgeResultDataProvider implements ResultDataProvider {
  info = { id: 'JRA_VAN_BRIDGE_V1' as const, label: 'JRA-VAN連携ブリッジ', formatVersion: 'UMAREAL_JRA_VAN_BRIDGE_V1', headers: jraVanBridgeResultHeaders };
  parse(source: string): ResultDataProviderParseResult {
    const result: ResultDataProviderParseResult = { provider: this.info, rows: [], errors: [] };
    let csvRows: string[][];
    try { csvRows = parseCsv(source); } catch (error) { result.errors.push({ row: 0, field: 'csv', message: (error as Error).message }); return result; }
    if (!csvRows.length || csvRows[0].join(',') !== jraVanBridgeResultHeaders.join(',')) {
      result.errors.push({ row: 1, field: 'header', message: `見出しは次の順序にしてください：${jraVanBridgeResultHeaders.join(',')}` }); return result;
    }
    if (csvRows.length === 1) result.errors.push({ row: 2, field: 'csv', message: 'データ行がありません。' });
    const entries = new Set<string>();
    csvRows.slice(1).forEach((row, index) => {
      const rowNumber = index + 2;
      if (row.length !== jraVanBridgeResultHeaders.length) { result.errors.push({ row: rowNumber, field: 'csv', message: '列数が見出しと一致しません。' }); return; }
      const [recordType, raceDate, venueCode, raceNumber, horseNumber, abnormalCode, finishPosition, popularity, finalOdds, raceCanceled] = row.map(value => value.trim());
      if (recordType !== 'SE') result.errors.push({ row: rowNumber, field: 'recordType', message: '馬毎レース情報（SE）だけを指定してください。' });
      const venue = jraVenueCodes[venueCode];
      if (!venue) result.errors.push({ row: rowNumber, field: 'venueCode', message: '中央競馬の競馬場コード（01〜10）を指定してください。' });
      const status = jraAbnormalStatuses[abnormalCode];
      if (!status) result.errors.push({ row: rowNumber, field: 'abnormalCode', message: '対応する異常区分コード（0〜7）を指定してください。' });
      if (!['true', 'false'].includes(raceCanceled)) result.errors.push({ row: rowNumber, field: 'raceCanceled', message: 'trueまたはfalseを指定してください。' });
      if (recordType !== 'SE' || !venue || !status || !['true', 'false'].includes(raceCanceled)) return;
      const canceled = raceCanceled === 'true';
      if (canceled && (finishPosition !== '' || popularity !== '' || finalOdds !== '')) {
        result.errors.push({ row: rowNumber, field: 'raceCanceled', message: 'レース中止時は着順、人気、確定単勝を空欄にしてください。' }); return;
      }
      const parsed = batchResultCsvRowSchema.safeParse({
        raceDate, venue, raceNumber: raceNumber === '' ? null : Number(raceNumber), horseNumber: horseNumber === '' ? null : Number(horseNumber),
        status: canceled ? 'CANCELED' : status, finishPosition: canceled || finishPosition === '' ? null : Number(finishPosition),
        popularity: canceled || popularity === '' ? null : Number(popularity), finalOdds: canceled ? null : finalOdds || null
      });
      if (!parsed.success) { parsed.error.issues.forEach(issue => result.errors.push({ row: rowNumber, field: issue.path.join('.'), message: issue.message })); return; }
      const key = `${parsed.data.raceDate}:${parsed.data.venue}:${parsed.data.raceNumber}:${parsed.data.horseNumber}`;
      if (entries.has(key)) result.errors.push({ row: rowNumber, field: 'horseNumber', message: 'CSV内で同じレースの馬番が重複しています。' });
      entries.add(key); result.rows.push(parsed.data);
    });
    return result;
  }
}

const resultDataProviders: Record<ResultDataProviderId, ResultDataProvider> = {
  CANONICAL_CSV: new CanonicalResultDataProvider(), JRA_VAN_BRIDGE_V1: new JraVanBridgeResultDataProvider()
};
export const resultDataProviderCatalog = resultDataProviderIds.map(id => resultDataProviders[id].info);
export function getResultDataProvider(id: ResultDataProviderId) { return resultDataProviders[id]; }

export function verifyJraVanResultBundle(
  manifestSource: string,
  resultCsv: string,
  rows: BatchResultCsvRow[],
  checksum: (value: string) => string
) {
  const errors: ResultCsvIssue[] = [];
  let value: unknown;
  try { value = JSON.parse(manifestSource); }
  catch { return { manifest: null, errors: [{ row: 0, field: 'bundleManifest', message: 'manifest.jsonを解析できません。' }] }; }
  const checked = jraVanBundleManifestSchema.safeParse(value);
  if (!checked.success) {
    checked.error.issues.forEach(issue => errors.push({ row: 0, field: `bundleManifest.${issue.path.join('.')}`, message: issue.message }));
    return { manifest: null, errors };
  }
  const manifest = checked.data;
  if (manifest.sampleData) errors.push({ row: 0, field: 'bundleManifest.sampleData', message: 'リハーサル用の合成データは結果管理へ取り込めません。' });
  const resultFiles = manifest.files.filter(file => file.kind === 'RESULTS');
  if (!manifest.resultsIncluded || resultFiles.length !== 1 || resultFiles[0]?.path !== 'results.csv') errors.push({ row: 0, field: 'bundleManifest.resultsIncluded', message: 'manifestにresults.csvが1件記録されていません。' });
  const metadata = resultFiles[0];
  if (metadata && checksum(resultCsv) !== metadata.sha256) errors.push({ row: 0, field: 'results.csv', message: 'results.csvのSHA-256がmanifestと一致しません。' });
  if (metadata && metadata.rowCount !== rows.length) errors.push({ row: 0, field: 'bundleManifest.files', message: '結果行数がmanifestと一致しません。' });
  if (rows.some(row => row.raceDate !== manifest.targetDate)) errors.push({ row: 0, field: 'bundleManifest.targetDate', message: 'results.csvにmanifest対象日以外のレースがあります。' });
  const raceCount = new Set(rows.map(row => `${row.raceDate}:${row.venue}:${row.raceNumber}`)).size;
  if (raceCount !== manifest.finalizedRaceCount) errors.push({ row: 0, field: 'bundleManifest.finalizedRaceCount', message: '確定結果レース数がmanifestと一致しません。' });
  return { manifest, errors };
}

export function parseResultCsv(source: string): { rows: ResultCsvRow[]; errors: ResultCsvIssue[] } {
  const result: { rows: ResultCsvRow[]; errors: ResultCsvIssue[] } = { rows: [], errors: [] };
  let csvRows: string[][];
  try { csvRows = parseCsv(source); } catch (error) { result.errors.push({ row: 0, field: 'csv', message: (error as Error).message }); return result; }
  if (!csvRows.length || csvRows[0].join(',') !== resultCsvHeaders.join(',')) {
    result.errors.push({ row: 1, field: 'header', message: `見出しは次の順序にしてください：${resultCsvHeaders.join(',')}` }); return result;
  }
  if (csvRows.length === 1) result.errors.push({ row: 2, field: 'csv', message: 'データ行がありません。' });
  const numbers = new Set<number>();
  csvRows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    if (row.length !== resultCsvHeaders.length) { result.errors.push({ row: rowNumber, field: 'csv', message: '列数が見出しと一致しません。' }); return; }
    const [number, status, finishPosition, popularity, finalOdds] = row.map(value => value.trim());
    const parsed = resultCsvRowSchema.safeParse({
      number: number === '' ? null : Number(number), status,
      finishPosition: finishPosition === '' ? null : Number(finishPosition),
      popularity: popularity === '' ? null : Number(popularity), finalOdds: finalOdds || null
    });
    if (!parsed.success) { parsed.error.issues.forEach(issue => result.errors.push({ row: rowNumber, field: issue.path.join('.'), message: issue.message })); return; }
    if (numbers.has(parsed.data.number)) result.errors.push({ row: rowNumber, field: 'number', message: 'CSV内で馬番が重複しています。' });
    numbers.add(parsed.data.number); result.rows.push(parsed.data);
  });
  return result;
}

export function parseBatchResultCsv(source: string): { rows: BatchResultCsvRow[]; errors: ResultCsvIssue[] } {
  const result: { rows: BatchResultCsvRow[]; errors: ResultCsvIssue[] } = { rows: [], errors: [] };
  let csvRows: string[][];
  try { csvRows = parseCsv(source); } catch (error) { result.errors.push({ row: 0, field: 'csv', message: (error as Error).message }); return result; }
  if (!csvRows.length || csvRows[0].join(',') !== batchResultCsvHeaders.join(',')) {
    result.errors.push({ row: 1, field: 'header', message: `見出しは次の順序にしてください：${batchResultCsvHeaders.join(',')}` }); return result;
  }
  if (csvRows.length === 1) result.errors.push({ row: 2, field: 'csv', message: 'データ行がありません。' });
  const entries = new Set<string>();
  csvRows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    if (row.length !== batchResultCsvHeaders.length) { result.errors.push({ row: rowNumber, field: 'csv', message: '列数が見出しと一致しません。' }); return; }
    const [raceDate, venue, raceNumber, horseNumber, status, finishPosition, popularity, finalOdds] = row.map(value => value.trim());
    const parsed = batchResultCsvRowSchema.safeParse({
      raceDate, venue, raceNumber: raceNumber === '' ? null : Number(raceNumber), horseNumber: horseNumber === '' ? null : Number(horseNumber), status,
      finishPosition: finishPosition === '' ? null : Number(finishPosition), popularity: popularity === '' ? null : Number(popularity), finalOdds: finalOdds || null
    });
    if (!parsed.success) { parsed.error.issues.forEach(issue => result.errors.push({ row: rowNumber, field: issue.path.join('.'), message: issue.message })); return; }
    const key = `${parsed.data.raceDate}:${parsed.data.venue}:${parsed.data.raceNumber}:${parsed.data.horseNumber}`;
    if (entries.has(key)) result.errors.push({ row: rowNumber, field: 'horseNumber', message: 'CSV内で同じレースの馬番が重複しています。' });
    entries.add(key); result.rows.push(parsed.data);
  });
  return result;
}
const payoutSchema = z.object({ betType: z.enum(betTypes), combination: z.array(z.number().int().min(1).max(18)).min(1).max(3), payoutPer100Yen: z.number().int().min(0).max(100_000_000), refund: z.boolean() }).strict();
const resultCoreSchema = z.object({ revision: z.number().int().min(0), raceCanceled: z.boolean(), entries: z.array(resultEntrySchema).max(18), reason: z.string().trim().min(1).max(500) }).strict().superRefine((value, context) => {
  const entries = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (entries.has(entry.entryId)) context.addIssue({ code: 'custom', path: ['entries', index, 'entryId'], message: '同じ出走馬が重複しています。' });
    entries.add(entry.entryId);
    if (entry.status === 'FINISHED' && entry.finishPosition === null) context.addIssue({ code: 'custom', path: ['entries', index, 'finishPosition'], message: '完走馬には着順が必要です。' });
    if (entry.status !== 'FINISHED' && entry.finishPosition !== null) context.addIssue({ code: 'custom', path: ['entries', index, 'finishPosition'], message: '完走以外には着順を設定できません。' });
    if (value.raceCanceled && entry.status !== 'CANCELED') context.addIssue({ code: 'custom', path: ['entries', index, 'status'], message: 'レース中止時は全馬を中止にしてください。' });
    if (!value.raceCanceled && entry.status === 'CANCELED') context.addIssue({ code: 'custom', path: ['entries', index, 'status'], message: 'レース中止を有効にしてください。' });
  });
});
export const raceResultInputSchema = resultCoreSchema;
export type RaceResultInput = z.infer<typeof raceResultInputSchema>;

// 既存の凍結済み買い目を再現するためだけに残す。現行APIはこのスキーマを受け付けない。
export const legacyRaceResultInputSchema = z.object({ revision: z.number().int().min(0), raceCanceled: z.boolean(), entries: z.array(resultEntrySchema).max(18), payouts: z.array(payoutSchema).max(500), reason: z.string().trim().min(1).max(500) }).strict().superRefine((value, context) => {
  const parsedCore = resultCoreSchema.safeParse({ revision: value.revision, raceCanceled: value.raceCanceled, entries: value.entries, reason: value.reason });
  if (!parsedCore.success) parsedCore.error.issues.forEach(issue => context.addIssue(issue));
  const payouts = new Set<string>();
  value.payouts.forEach((payout, index) => {
    const arity = ['WIN', 'PLACE'].includes(payout.betType) ? 1 : ['QUINELLA', 'EXACTA', 'WIDE'].includes(payout.betType) ? 2 : 3;
    if (payout.combination.length !== arity || new Set(payout.combination).size !== payout.combination.length) context.addIssue({ code: 'custom', path: ['payouts', index, 'combination'], message: '券種と組合せを確認してください。' });
    if (payout.refund && payout.payoutPer100Yen !== 100) context.addIssue({ code: 'custom', path: ['payouts', index, 'payoutPer100Yen'], message: '返還は100円あたり100円で入力してください。' });
    if (!payout.refund && payout.payoutPer100Yen === 0) context.addIssue({ code: 'custom', path: ['payouts', index, 'payoutPer100Yen'], message: '払戻金は1円以上で入力してください。' });
    const key = payoutKey(payout.betType, payout.combination);
    if (payouts.has(key)) context.addIssue({ code: 'custom', path: ['payouts', index], message: '同じ払戻組合せが重複しています。' });
    payouts.add(key);
  });
  if (value.raceCanceled && value.payouts.length) context.addIssue({ code: 'custom', path: ['payouts'], message: 'レース中止時は払戻を個別入力しません。' });
});
export type LegacyRaceResultInput = z.infer<typeof legacyRaceResultInputSchema>;

export function payoutKey(type: string, combination: number[]) {
  const normalized = ['EXACTA', 'TRIFECTA'].includes(type) ? combination : [...combination].sort((a, b) => a - b);
  return `${type}:${normalized.join('-')}`;
}

export type SettlementBet = { id: string; betType: string; combination: unknown; amountPerPointYen: number; totalYen: number };
export function settlePrediction(input: { stance: string; marks: { mark: string; entryId: string }[]; bets: SettlementBet[]; result: LegacyRaceResultInput }) {
  const positions = new Map(input.result.entries.map(entry => [entry.entryId, entry.finishPosition]));
  const payoutMap = new Map(input.result.payouts.map(payout => [payoutKey(payout.betType, payout.combination), payout]));
  const excluded = input.result.raceCanceled || input.stance === 'SKIP';
  const bets = input.bets.map(bet => {
    const combinations = z.array(z.array(z.number().int())).parse(bet.combination);
    let refundYen = 0, payoutYen = 0, hit = false;
    const settlement = combinations.map(combination => {
      const payout = payoutMap.get(payoutKey(bet.betType, combination));
      const returned = payout ? Math.floor(bet.amountPerPointYen * payout.payoutPer100Yen / 100) : input.result.raceCanceled ? bet.amountPerPointYen : 0;
      const refund = input.result.raceCanceled || payout?.refund === true;
      if (refund) refundYen += returned; else { payoutYen += returned; if (returned > 0) hit = true; }
      return { combination, outcome: refund ? 'REFUND' : returned > 0 ? 'HIT' : 'LOSS', returnYen: returned };
    });
    return { predictionBetId: bet.id, hit, stakeYen: bet.totalYen, refundYen, payoutYen, returnYen: refundYen + payoutYen, settlement };
  });
  const honmei = input.marks.find(mark => mark.mark === 'HONMEI');
  return { excluded, hit: !excluded && bets.some(bet => bet.hit), stakeYen: bets.reduce((sum, bet) => sum + bet.stakeYen, 0), refundYen: bets.reduce((sum, bet) => sum + bet.refundYen, 0), payoutYen: bets.reduce((sum, bet) => sum + bet.payoutYen, 0), returnYen: bets.reduce((sum, bet) => sum + bet.returnYen, 0), honmeiPosition: honmei ? positions.get(honmei.entryId) ?? null : null, bets };
}

export function aggregatePerformances(items: { excluded: boolean; hit: boolean; stakeYen: number; returnYen: number; honmeiPosition: number | null }[]) {
  const eligible = items.filter(item => !item.excluded), betEligible = eligible.filter(item => item.stakeYen > 0), honmei = eligible.filter(item => item.honmeiPosition !== null);
  const stakeYen = betEligible.reduce((sum, item) => sum + item.stakeYen, 0), returnYen = betEligible.reduce((sum, item) => sum + item.returnYen, 0);
  const percent = (numerator: number, denominator: number) => denominator ? Math.round(numerator / denominator * 1000) / 10 : null;
  return { publishedVersions: items.length, skippedOrCanceled: items.length - eligible.length, eligiblePredictions: eligible.length, hits: eligible.filter(item => item.hit).length, hitRatePercent: percent(eligible.filter(item => item.hit).length, eligible.length), stakeYen, returnYen, recoveryRatePercent: percent(returnYen, stakeYen), honmeiCount: honmei.length, honmeiPlaceRatePercent: percent(honmei.filter(item => item.honmeiPosition! <= 3).length, honmei.length), honmeiQuinellaRatePercent: percent(honmei.filter(item => item.honmeiPosition! <= 2).length, honmei.length) };
}
