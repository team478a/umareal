import { describe, expect, it, vi } from 'vitest';
import { LineMessagingTransport } from './line-transport';

const input = { recipient: 'U-member', idempotencyKey: 'business-key', retryKey: '38bbc51a-2aa4-4b43-8661-c3c6164e2f64', eventType: 'PREDICTION_PUBLISHED', versionId: 'version', raceId: 'race', message: { type: 'text' as const, text: '公開しました' } };
describe('LINE Messaging API transport', () => {
  it('sends the exact push envelope with authorization and retry key', async () => {
    let requestedUrl = ''; let requestedOptions: RequestInit | undefined;
    const request = (async (url: string | URL | Request, options?: RequestInit) => { requestedUrl = String(url); requestedOptions = options; return new Response('{}', { status: 200, headers: { 'x-line-request-id': 'line-request-1' } }); }) as typeof fetch;
    const result = await new LineMessagingTransport('test-access-token', request).send(input);
    expect(result).toEqual({ kind: 'SENT', providerMessageId: 'line-request-1' });
    expect(requestedUrl).toBe('https://api.line.me/v2/bot/message/push');
    expect(requestedOptions?.headers).toMatchObject({ Authorization: 'Bearer test-access-token', 'X-Line-Retry-Key': input.retryKey });
    expect(JSON.parse(String(requestedOptions?.body))).toEqual({ to: input.recipient, messages: [input.message] });
  });
  it('treats an accepted retry as sent and classifies failures without response bodies', async () => {
    const accepted = vi.fn(async () => new Response('{}', { status: 409, headers: { 'x-line-accepted-request-id': 'accepted-request' } }));
    expect(await new LineMessagingTransport('token', accepted).send(input)).toEqual({ kind: 'SENT', providerMessageId: 'accepted-request' });
    for (const [status, kind] of [[400, 'PERMANENT_FAILURE'], [401, 'PERMANENT_FAILURE'], [429, 'PERMANENT_FAILURE'], [500, 'TRANSIENT_FAILURE'], [503, 'TRANSIENT_FAILURE']] as const) {
      const request = vi.fn(async () => new Response('sensitive provider response', { status }));
      expect(await new LineMessagingTransport('token', request).send(input)).toEqual({ kind, errorCode: `LINE_HTTP_${status}` });
    }
  });
  it('retries network failures using a safe error code', async () => {
    const request = vi.fn(async () => { throw new Error('response may contain a secret'); });
    expect(await new LineMessagingTransport('token', request).send(input)).toEqual({ kind: 'TRANSIENT_FAILURE', errorCode: 'LINE_NETWORK_ERROR' });
  });
});
