import { afterEach, describe, expect, it, vi } from 'vitest';
import { blankAssessment } from '@keiba/domain';
import type { DbService } from './db.service';
import { AdminOperationsQueryService } from './admin-operations-query.service';

const originalLaunchMode = process.env.LAUNCH_MODE;
const originalNotificationTransport = process.env.NOTIFICATION_TRANSPORT;

afterEach(() => {
  process.env.LAUNCH_MODE = originalLaunchMode;
  process.env.NOTIFICATION_TRANSPORT = originalNotificationTransport;
});

describe('AdminOperationsQueryService', () => {
  it('preserves race-day workflow state while limiting selected database fields', async () => {
    process.env.LAUNCH_MODE = 'FULL';
    process.env.NOTIFICATION_TRANSPORT = 'test';
    const now = new Date('2026-10-06T03:00:00.000Z');
    const startsAt = new Date('2026-10-06T03:10:00.000Z');
    const raceId = '11111111-1111-4111-8111-111111111111';
    const staffId = '22222222-2222-4222-8222-222222222222';
    const publishedAt = new Date('2026-10-05T12:00:00.000Z');
    const findMany = vi.fn().mockResolvedValue([{
      id: raceId,
      raceDate: '2026-10-06',
      venue: '東京',
      number: 8,
      name: '運用確認レース',
      status: 'SCHEDULED',
      startsAt,
      assignments: [{ user: { id: staffId, displayName: '担当者', disabledAt: null } }],
      entries: [
        { assessment: { content: { ...blankAssessment, body: 4, walk: 4, coat: 4, focus: 4, calm: 4, change: 'UP' } } },
        { assessment: null },
      ],
      announcements: [{ version: 1, publishedAt, notificationEvent: { status: 'FAILED', deliveries: [{ status: 'FAILED' }] } }],
      prediction: null,
      resultVersions: [],
    }]);
    const settings = {
      csvImportEnabled: true,
      predictionPublicationEnabled: true,
      lineNotificationsEnabled: true,
      lineChannelId: 'channel',
      lineChannelSecretEncrypted: 'encrypted-secret',
      lineAccessTokenEncrypted: 'encrypted-token',
    };
    const service = new AdminOperationsQueryService({
      race: { findMany },
      systemSetting: { findUniqueOrThrow: vi.fn().mockResolvedValue(settings) },
    } as unknown as DbService);

    const result = await service.get('2026-10-06', now);

    expect(result).toMatchObject({
      date: '2026-10-06',
      generatedAt: now.toISOString(),
      alerts: 3,
      items: [{
        id: raceId,
        secondsRemaining: 600,
        deadlineState: 'DUE_SOON',
        assignments: [{ id: staffId, displayName: '担当者', active: true }],
        entries: { total: 2, paddockCompleted: 1 },
        announcement: { version: 1, publishedAt: publishedAt.toISOString(), eventStatus: 'FAILED' },
        prediction: null,
        notification: { queued: 0, sent: 0, failed: 1 },
        warnings: ['パドック未完了 1頭', '最終予想未公開', '通知失敗 1件'],
        rehearsal: { status: 'BLOCKED', done: 2, total: 6, nextStep: 'PADDOCK' },
      }],
      attention: { critical: 2, warning: 0 },
      rehearsal: {
        ready: 0,
        blocked: 1,
        total: 1,
        preflight: {
          csvImportEnabled: true,
          predictionPublicationEnabled: true,
          lineAvailable: true,
          lineNotificationsEnabled: true,
          lineConfigured: true,
        },
      },
    });
    expect(result.attention.items.map(item => item.code)).toEqual(['DELIVERY_FAILED', 'PADDOCK_INCOMPLETE']);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { raceDate: '2026-10-06' },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: expect.objectContaining({
        id: true,
        entries: { where: { status: 'ACTIVE' }, orderBy: { number: 'asc' }, select: { assessment: { select: { content: true } } } },
        assignments: { select: { user: { select: { id: true, displayName: true, disabledAt: true } } } },
      }),
    }));
    const selection = findMany.mock.calls[0][0].select;
    expect(selection).not.toHaveProperty('horseName');
    expect(selection).not.toHaveProperty('email');
    expect(JSON.stringify(result)).not.toMatch(/encrypted-secret|encrypted-token|assessmentContent|horseName/);
  });
});
