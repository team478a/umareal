import { describe, expect, it } from 'vitest';
import { adminIncidentResponseSchema } from './incidents';

const now = new Date('2026-09-27T00:00:00.000Z');

function response() {
  return {
    generatedAt: now,
    status: 'INCIDENT',
    counts: { critical: 1, warning: 0, total: 1 },
    issues: [{ code: 'DELIVERY_STUCK', severity: 'CRITICAL', title: '送信中の通知が停滞', detail: '5分以上送信中の配送が1件あります。', action: 'ワーカー状態を確認します。', href: '/admin/notifications' }],
    publicMessage: '公開済みの情報はWeb会員ページでご確認いただけます。',
    monitoring: {
      failedDeliveries: 0,
      delayedDeliveries: 0,
      stuckDeliveries: 1,
      unmatchedWebhooks24h: 0,
      emailRecipientFailures24h: 0,
      emailProviderFailures24h: 0,
      lastWebhookAt: now,
      lastWebhookOutcome: 'PROCESSED',
      settingsUpdatedAt: now,
      newPurchasesEnabled: true
    }
  } as const;
}

describe('admin incident response contract', () => {
  it('normalizes the existing response timestamps', () => {
    const parsed = adminIncidentResponseSchema.parse(response());
    expect(parsed.generatedAt).toBe(now.toISOString());
    expect(parsed.monitoring.lastWebhookAt).toBe(now.toISOString());
    expect(parsed.monitoring.settingsUpdatedAt).toBe(now.toISOString());
  });

  it('rejects invalid states and internal operational data', () => {
    const value = response();
    expect(adminIncidentResponseSchema.safeParse({ ...value, status: 'UNKNOWN' }).success).toBe(false);
    expect(adminIncidentResponseSchema.safeParse({ ...value, issues: [{ ...value.issues[0], severity: 'FATAL' }] }).success).toBe(false);
    expect(adminIncidentResponseSchema.safeParse({ ...value, lineAccessToken: 'secret' }).success).toBe(false);
    expect(adminIncidentResponseSchema.safeParse({ ...value, monitoring: { ...value.monitoring, leaseToken: 'secret' } }).success).toBe(false);
  });
});
