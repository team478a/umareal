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

export type LineTextMessage = { type: 'text'; text: string };

function singleLine(value: string) { return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(); }

export function buildPredictionLineMessage(raw: z.input<typeof notificationInputSchema>): LineTextMessage {
  const input = notificationInputSchema.parse(raw);
  const url = new URL(input.appBaseUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Notification links require HTTPS outside local development');
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
