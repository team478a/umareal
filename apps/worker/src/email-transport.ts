import type { LineTextMessage } from '@keiba/domain';
import type { DeliveryOutcome, NotificationTransport } from './notification-runner';

type Fetch = typeof fetch;
const endpoint = 'https://api.resend.com/emails';
const subjects: Record<string, string> = {
  RACE_ANNOUNCED: '予想対象レースのお知らせ',
  PREDICTION_PUBLISHED: '最終予想を公開しました',
  PREDICTION_CORRECTED: '最終予想を訂正しました',
  FREE_REPORT_PUBLISHED: '無料パドック速報を公開しました',
  FREE_REPORT_REVIEW_PUBLISHED: '無料速報のレース後検証を公開しました'
};

export class ResendEmailTransport implements NotificationTransport {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly request: Fetch = fetch, private readonly apiEndpoint = endpoint) {
    if (!apiKey.trim()) throw new Error('RESEND_API_KEY is not configured');
    if (!from.trim()) throw new Error('MAIL_FROM is not configured');
  }

  async send(input: { recipient: string; idempotencyKey: string; retryKey: string; eventType: string; targetId: string; raceId: string; message: LineTextMessage }): Promise<DeliveryOutcome> {
    try {
      const response = await this.request(this.apiEndpoint, {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.retryKey, 'User-Agent': 'umareal-worker/1.0' },
        body: JSON.stringify({ from: this.from, to: [input.recipient], subject: subjects[input.eventType] ?? '会員ページからのお知らせ', text: `${input.message.text}\n\n配信設定は会員ページのアカウント画面から変更できます。` })
      });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { id?: unknown } | null;
        return { kind: 'SENT', providerMessageId: typeof body?.id === 'string' ? body.id : `accepted:${input.retryKey}` };
      }
      if ([408, 429].includes(response.status) || response.status >= 500) return { kind: 'TRANSIENT_FAILURE', errorCode: `EMAIL_HTTP_${response.status}` };
      return { kind: 'PERMANENT_FAILURE', errorCode: `EMAIL_HTTP_${response.status}` };
    } catch (error) {
      return { kind: 'TRANSIENT_FAILURE', errorCode: error instanceof Error && error.name === 'TimeoutError' ? 'EMAIL_TIMEOUT' : 'EMAIL_NETWORK_ERROR' };
    }
  }
}
