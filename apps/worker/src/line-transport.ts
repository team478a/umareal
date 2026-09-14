import type { LineTextMessage } from '@keiba/domain';
import type { DeliveryOutcome, NotificationTransport } from './notification-runner';

type Fetch = typeof fetch;
const endpoint = 'https://api.line.me/v2/bot/message/push';

export class LineMessagingTransport implements NotificationTransport {
  constructor(private readonly accessToken: string, private readonly request: Fetch = fetch, private readonly apiEndpoint = endpoint) {
    if (!accessToken.trim()) throw new Error('LINE access token is not configured');
  }

  async send(input: { recipient: string; retryKey: string; message: LineTextMessage }): Promise<DeliveryOutcome> {
    try {
      const response = await this.request(this.apiEndpoint, {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json', 'X-Line-Retry-Key': input.retryKey },
        body: JSON.stringify({ to: input.recipient, messages: [input.message] })
      });
      const requestId = response.headers.get('x-line-request-id');
      if (response.ok) return { kind: 'SENT', providerMessageId: requestId ?? `accepted:${input.retryKey}` };
      if (response.status === 409) {
        const acceptedId = response.headers.get('x-line-accepted-request-id');
        if (acceptedId) return { kind: 'SENT', providerMessageId: acceptedId };
      }
      if (response.status >= 500) return { kind: 'TRANSIENT_FAILURE', errorCode: `LINE_HTTP_${response.status}` };
      return { kind: 'PERMANENT_FAILURE', errorCode: `LINE_HTTP_${response.status}` };
    } catch (error) {
      return { kind: 'TRANSIENT_FAILURE', errorCode: error instanceof Error && error.name === 'TimeoutError' ? 'LINE_TIMEOUT' : 'LINE_NETWORK_ERROR' };
    }
  }
}
