import { describe, expect, it } from 'vitest';
import { ResendOperationalAlertTransport } from './operational-alert-transport';

describe('Resend operational alert transport', () => {
  it('sends the server-built alert with provider idempotency', async () => {
    let captured: RequestInit | undefined;
    const request: typeof fetch = async (_input, init) => { captured = init; return new Response(JSON.stringify({ id: 'email_alert_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
    const transport = new ResendOperationalAlertTransport('re_test_key', 'ops@example.test', request, 'https://resend.test/emails');
    const result = await transport.send({ recipient: 'owner@example.test', retryKey: 'alert-delivery-id', severity: 'CRITICAL', code: 'PUBLICATION_SCHEDULE_FAILED', title: '予約公開に失敗', text: '安全な運用要約' });
    expect(result).toEqual({ kind: 'SENT', providerMessageId: 'email_alert_1' });
    const body = JSON.parse(String(captured?.body));
    expect(captured?.headers).toMatchObject({ 'Idempotency-Key': 'alert-delivery-id' });
    expect(body).toEqual({ from: 'ops@example.test', to: ['owner@example.test'], subject: '【重大】予約公開に失敗', text: '安全な運用要約' });
  });

  it('classifies retryable and permanent provider failures', async () => {
    const retryable = new ResendOperationalAlertTransport('re_test_key', 'ops@example.test', (async () => new Response(null, { status: 503 })) as typeof fetch);
    const permanent = new ResendOperationalAlertTransport('re_test_key', 'ops@example.test', (async () => new Response(null, { status: 422 })) as typeof fetch);
    const input = { recipient: 'owner@example.test', retryKey: 'delivery-id', severity: 'WARNING' as const, code: 'DELIVERY_FAILED', title: '通知失敗', text: '安全な運用要約' };
    expect(await retryable.send(input)).toEqual({ kind: 'TRANSIENT_FAILURE', errorCode: 'ALERT_EMAIL_HTTP_503' });
    expect(await permanent.send(input)).toEqual({ kind: 'PERMANENT_FAILURE', errorCode: 'ALERT_EMAIL_HTTP_422' });
  });
});
