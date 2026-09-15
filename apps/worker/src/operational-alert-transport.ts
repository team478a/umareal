import type { OperationalAlertOutcome, OperationalAlertTransport } from './operational-alert-runner';

type Fetch = typeof fetch;
export class ResendOperationalAlertTransport implements OperationalAlertTransport {
  constructor(private readonly apiKey: string, private readonly from: string, private readonly request: Fetch = fetch, private readonly endpoint = 'https://api.resend.com/emails') {}
  async send(input: { recipient: string; retryKey: string; severity: 'CRITICAL' | 'WARNING'; code: string; title: string; text: string }): Promise<OperationalAlertOutcome> {
    try {
      const response = await this.request(this.endpoint, { method: 'POST', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.retryKey, 'User-Agent': 'umareal-worker/1.0' }, body: JSON.stringify({ from: this.from, to: [input.recipient], subject: `【${input.severity === 'CRITICAL' ? '重大' : '警告'}】${input.title}`, text: input.text }) });
      if (response.ok) { const body = await response.json().catch(() => null) as { id?: unknown } | null; return { kind: 'SENT', providerMessageId: typeof body?.id === 'string' ? body.id : `accepted:${input.retryKey}` }; }
      if ([408, 429].includes(response.status) || response.status >= 500) return { kind: 'TRANSIENT_FAILURE', errorCode: `ALERT_EMAIL_HTTP_${response.status}` };
      return { kind: 'PERMANENT_FAILURE', errorCode: `ALERT_EMAIL_HTTP_${response.status}` };
    } catch (error) { return { kind: 'TRANSIENT_FAILURE', errorCode: error instanceof Error && error.name === 'TimeoutError' ? 'ALERT_EMAIL_TIMEOUT' : 'ALERT_EMAIL_NETWORK_ERROR' }; }
  }
}
