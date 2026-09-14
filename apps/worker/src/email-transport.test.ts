import { describe, expect, it, vi } from 'vitest';
import { ResendEmailTransport } from './email-transport';

const message = { type: 'text' as const, text: '予想対象レースのお知らせ\n2098-08-01 東京 3R\nテスト競走\n内容は会員ページでご確認ください。\nhttps://example.test/races/race-id' };

describe('ResendEmailTransport', () => {
  it('sends a text-only metadata notice with provider idempotency', async () => {
    let captured: RequestInit | undefined;
    const request = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => { captured = options; return new Response(JSON.stringify({ id: 'email-provider-id' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); });
    const transport = new ResendEmailTransport('re_test_key', '競馬会員メディア <notice@example.test>', request as typeof fetch, 'https://resend.test/emails');
    await expect(transport.send({ recipient: 'member@example.test', idempotencyKey: 'EMAIL:event', retryKey: 'delivery-id', eventType: 'RACE_ANNOUNCED', targetId: 'target-id', raceId: 'race-id', message })).resolves.toEqual({ kind: 'SENT', providerMessageId: 'email-provider-id' });
    expect(captured?.headers).toMatchObject({ Authorization: 'Bearer re_test_key', 'Idempotency-Key': 'delivery-id' });
    const body = JSON.parse(String(captured?.body));
    expect(body).toMatchObject({ to: ['member@example.test'], subject: '予想対象レースのお知らせ' });
    expect(body.text).toContain('内容は会員ページでご確認ください。');
    expect(body.text).not.toMatch(/買い目|本命|円/);
  });

  it('classifies retryable and permanent provider errors', async () => {
    const retryable = new ResendEmailTransport('key', 'notice@example.test', async () => new Response('', { status: 429 }), 'https://resend.test/emails');
    const permanent = new ResendEmailTransport('key', 'notice@example.test', async () => new Response('', { status: 422 }), 'https://resend.test/emails');
    const input = { recipient: 'member@example.test', idempotencyKey: 'EMAIL:event', retryKey: 'delivery-id', eventType: 'PREDICTION_PUBLISHED', targetId: 'target-id', raceId: 'race-id', message };
    await expect(retryable.send(input)).resolves.toEqual({ kind: 'TRANSIENT_FAILURE', errorCode: 'EMAIL_HTTP_429' });
    await expect(permanent.send(input)).resolves.toEqual({ kind: 'PERMANENT_FAILURE', errorCode: 'EMAIL_HTTP_422' });
  });
});
