import { describe, expect, it, vi } from 'vitest';
import type { DbService } from './db.service';
import { AdminIncidentQueryService } from './admin-incident-query.service';

describe('AdminIncidentQueryService', () => {
  it('preserves incident thresholds and returns no notification credentials', async () => {
    const now = new Date('2026-10-06T03:00:00.000Z');
    const settings = {
      emailNotificationsEnabled: true,
      predictionPublicationEnabled: true,
      csvImportEnabled: true,
      lineNotificationsEnabled: true,
      newPurchasesEnabled: false,
      maintenanceMessage: '',
      lineChannelId: 'configured',
      lineChannelSecretEncrypted: 'configured',
      lineAccessTokenEncrypted: 'configured',
      mailApiKeyEncrypted: null,
      mailWebhookSecretEncrypted: null,
      mailFrom: null,
      updatedAt: new Date('2026-10-06T02:00:00.000Z'),
    };
    const deliveryCount = vi.fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    const lineCount = vi.fn().mockResolvedValue(4);
    const emailCount = vi.fn()
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(6);
    const transaction = vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations));
    const service = new AdminIncidentQueryService({
      systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue(settings) },
      notificationDelivery: { count: deliveryCount },
      lineWebhookEvent: {
        findFirst: vi.fn().mockResolvedValue({
          receivedAt: new Date('2026-10-06T02:30:00.000Z'),
          eventType: 'follow',
          outcome: 'MATCHED',
        }),
        count: lineCount,
      },
      emailWebhookEvent: { count: emailCount },
      $transaction: transaction,
    } as unknown as DbService);

    const result = await service.get(now, {
      LAUNCH_MODE: 'FREE_REGISTRATION',
      NOTIFICATION_TRANSPORT: 'line',
      MAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 'test-key',
      RESEND_WEBHOOK_SECRET: 'test-secret',
      MAIL_FROM: 'UMAREAL <noreply@example.test>',
    });

    expect(deliveryCount.mock.calls).toEqual([
      [{ where: { status: 'FAILED' } }],
      [{ where: { status: 'QUEUED', attemptCount: 0, createdAt: { lt: new Date('2026-10-06T02:59:00.000Z') }, nextAttemptAt: { lte: now } } }],
      [{ where: { status: 'SENDING', lockedAt: { lt: new Date('2026-10-06T02:55:00.000Z') } } }],
    ]);
    expect(lineCount).toHaveBeenCalledWith({
      where: { receivedAt: { gte: new Date('2026-10-05T03:00:00.000Z') }, outcome: 'UNMATCHED' },
    });
    expect(result).toMatchObject({
      generatedAt: now.toISOString(),
      status: 'INCIDENT',
      counts: { critical: 2, warning: 4, total: 6 },
      monitoring: {
        failedDeliveries: 1,
        delayedDeliveries: 2,
        stuckDeliveries: 3,
        unmatchedWebhooks24h: 4,
        emailRecipientFailures24h: 5,
        emailProviderFailures24h: 6,
        newPurchasesEnabled: false,
      },
    });
    expect(result.issues.map(issue => issue.code)).toEqual([
      'DELIVERY_STUCK',
      'DELIVERY_FAILED',
      'DELIVERY_DELAYED',
      'WEBHOOK_UNMATCHED',
      'EMAIL_RECIPIENT_REJECTED',
      'EMAIL_PROVIDER_FAILURE',
    ]);
    expect(JSON.stringify(result)).not.toMatch(/lineChannel|AccessToken|ApiKey|WebhookSecret|test-secret|test-key/);
  });

  it('returns NORMAL when enabled transports and queues have no detected issue', async () => {
    const now = new Date('2026-10-06T03:00:00.000Z');
    const transaction = vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations));
    const service = new AdminIncidentQueryService({
      systemSetting: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          emailNotificationsEnabled: true,
          predictionPublicationEnabled: true,
          csvImportEnabled: true,
          lineNotificationsEnabled: true,
          newPurchasesEnabled: true,
          maintenanceMessage: '',
          lineChannelId: 'configured',
          lineChannelSecretEncrypted: 'configured',
          lineAccessTokenEncrypted: 'configured',
          mailApiKeyEncrypted: null,
          mailWebhookSecretEncrypted: null,
          mailFrom: null,
          updatedAt: now,
        }),
      },
      notificationDelivery: { count: vi.fn().mockResolvedValue(0) },
      lineWebhookEvent: { findFirst: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0) },
      emailWebhookEvent: { count: vi.fn().mockResolvedValue(0) },
      $transaction: transaction,
    } as unknown as DbService);

    const result = await service.get(now, {
      LAUNCH_MODE: 'FREE_REGISTRATION',
      NOTIFICATION_TRANSPORT: 'line',
      MAIL_TRANSPORT: 'test',
    });

    expect(result).toMatchObject({
      status: 'NORMAL',
      counts: { critical: 0, warning: 0, total: 0 },
      issues: [],
      publicMessage: '現在、確認されている公開・通知障害はありません。',
    });
  });
});
