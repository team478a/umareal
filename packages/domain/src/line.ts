import { z } from 'zod';

const notificationInputSchema = z.object({
  eventType: z.enum(['PREDICTION_PUBLISHED', 'PREDICTION_CORRECTED', 'RACE_ANNOUNCED', 'FREE_REPORT_PUBLISHED', 'FREE_REPORT_REVIEW_PUBLISHED']),
  raceId: z.string().uuid(),
  raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  venue: z.string().trim().min(1).max(40),
  raceNumber: z.number().int().min(1).max(12),
  raceName: z.string().trim().min(1).max(100),
  version: z.number().int().positive(),
  visibility: z.enum(['FREE', 'PAID']),
  appBaseUrl: z.string().url()
}).strict();

const win5NotificationInputSchema = z.object({
  eventType: z.enum(['WIN5_PREVIEW_PUBLISHED', 'WIN5_PREVIEW_CORRECTED']),
  productId: z.string().uuid(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1).max(100),
  version: z.number().int().positive(),
  appBaseUrl: z.string().url()
}).strict();

const raceResultNotificationInputSchema = z.object({
  eventType: z.literal('RACE_EVALUATION_CONFIRMED'),
  raceId: z.string().uuid(),
  raceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  venue: z.string().trim().min(1).max(40),
  raceNumber: z.number().int().min(1).max(12),
  raceName: z.string().trim().min(1).max(100),
  resultVersion: z.number().int().positive(),
  status: z.enum(['PRIMARY_WIN', 'PRIMARY_TOP2', 'PRIMARY_TOP3', 'WINNER_IN_RECOMMENDED', 'WINNER_NOT_RECOMMENDED', 'SKIPPED', 'EXCLUDED', 'CANCELED']),
  appBaseUrl: z.string().url()
}).strict();

const win5ResultNotificationInputSchema = z.object({
  eventType: z.literal('WIN5_EVALUATION_CONFIRMED'),
  productId: z.string().uuid(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1).max(100),
  resultVersion: z.number().int().positive(),
  status: z.enum(['WIN5_ALL_WINNERS_RECOMMENDED', 'WIN5_PARTIAL', 'WIN5_MISSED']),
  recommendedLegs: z.number().int().min(0).max(5),
  appBaseUrl: z.string().url()
}).strict();

const supportReplyNotificationInputSchema = z.object({
  eventType: z.literal('SUPPORT_RESPONSE_POSTED'),
  requestId: z.string().uuid(),
  appBaseUrl: z.string().url()
}).strict();

export type LineTextMessage = { type: 'text'; text: string };

function singleLine(value: string) { return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function checkedBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Notification links require HTTPS outside local development');
  return url;
}

export function buildPredictionLineMessage(raw: z.input<typeof notificationInputSchema>): LineTextMessage {
  const input = notificationInputSchema.parse(raw);
  const url = checkedBaseUrl(input.appBaseUrl);
  const title = input.eventType === 'RACE_ANNOUNCED' ? '予想対象レースのお知らせ'
    : input.eventType === 'FREE_REPORT_PUBLISHED' ? '無料パドック速報を公開しました'
    : input.eventType === 'FREE_REPORT_REVIEW_PUBLISHED' ? '無料速報のレース後検証を公開しました'
    : input.eventType === 'PREDICTION_CORRECTED' ? '最終予想を訂正しました' : '最終予想を公開しました';
  const audience = input.visibility === 'PAID' ? '有料会員向け' : '無料公開';
  const link = new URL(`/races/${input.raceId}`, url).toString();
  const detail = input.eventType === 'RACE_ANNOUNCED' ? '最終予想は公開後に会員ページでご確認ください。'
    : input.eventType.startsWith('FREE_REPORT_') ? `第${input.version}版・無料会員向け\n内容は会員ページでご確認ください。`
    : `第${input.version}版・${audience}\n内容は会員ページでご確認ください。`;
  const text = [title, `${input.raceDate} ${singleLine(input.venue)} ${input.raceNumber}R`, singleLine(input.raceName), detail, link].join('\n');
  if (text.length > 5000) throw new Error('LINE text message exceeds the supported length');
  return { type: 'text', text };
}

export function buildWin5LineMessage(raw: z.input<typeof win5NotificationInputSchema>): LineTextMessage {
  const input = win5NotificationInputSchema.parse(raw);
  const url = checkedBaseUrl(input.appBaseUrl);
  const heading = input.eventType === 'WIN5_PREVIEW_CORRECTED' ? 'WIN5紙面予想を訂正しました' : 'WIN5紙面予想を公開しました';
  const link = new URL(`/win5/${input.productId}`, url).toString();
  const text = [heading, input.targetDate, singleLine(input.title), `第${input.version}版`, '対象5レースの紙面は会員ページでご確認ください。', link].join('\n');
  if (text.length > 5000) throw new Error('LINE text message exceeds the supported length');
  return { type: 'text', text };
}

export function buildRaceResultLineMessage(raw: z.input<typeof raceResultNotificationInputSchema>): LineTextMessage {
  const input = raceResultNotificationInputSchema.parse(raw);
  const url = checkedBaseUrl(input.appBaseUrl);
  const result = {
    PRIMARY_WIN: '本命馬が1着', PRIMARY_TOP2: '本命馬が2着', PRIMARY_TOP3: '本命馬が3着',
    WINNER_IN_RECOMMENDED: '勝ち馬を中心馬または相手候補として選出', WINNER_NOT_RECOMMENDED: '勝ち馬は候補外',
    SKIPPED: '見送り', EXCLUDED: '評価対象外', CANCELED: 'レース中止'
  }[input.status];
  const link = new URL(`/races/${input.raceId}`, url).toString();
  const text = ['パドック直前予想の評価結果が確定しました', `${input.raceDate} ${singleLine(input.venue)} ${input.raceNumber}R`, singleLine(input.raceName), result, `結果版${input.resultVersion}`, '全予想結果は会員ページでご確認ください。', link].join('\n');
  if (text.length > 5000) throw new Error('LINE text message exceeds the supported length');
  return { type: 'text', text };
}

export function buildWin5ResultLineMessage(raw: z.input<typeof win5ResultNotificationInputSchema>): LineTextMessage {
  const input = win5ResultNotificationInputSchema.parse(raw);
  const url = checkedBaseUrl(input.appBaseUrl);
  const result = input.status === 'WIN5_ALL_WINNERS_RECOMMENDED' ? '対象5レースすべてで勝ち馬を候補内に選出'
    : input.status === 'WIN5_PARTIAL' ? `対象5レース中${input.recommendedLegs}レースで勝ち馬を候補内に選出` : '対象5レースの勝ち馬は候補外';
  const link = new URL(`/win5/${input.productId}`, url).toString();
  const text = ['WIN5紙面予想の評価結果が確定しました', input.targetDate, singleLine(input.title), result, `結果版${input.resultVersion}`, '全予想結果は会員ページでご確認ください。', link].join('\n');
  if (text.length > 5000) throw new Error('LINE text message exceeds the supported length');
  return { type: 'text', text };
}

export function buildSupportReplyLineMessage(raw: z.input<typeof supportReplyNotificationInputSchema>): LineTextMessage {
  const input = supportReplyNotificationInputSchema.parse(raw);
  const url = checkedBaseUrl(input.appBaseUrl);
  const link = new URL('/support', url).toString();
  const text = ['お問い合わせへの回答があります', '回答内容は会員ページでご確認ください。', link].join('\n');
  if (text.length > 5000) throw new Error('LINE text message exceeds the supported length');
  return { type: 'text', text };
}
