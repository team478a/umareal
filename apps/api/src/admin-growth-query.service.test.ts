import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbService } from './db.service';
import type { AdminSummaryQueryService } from './admin-summary-query.service';
import { AdminGrowthQueryService } from './admin-growth-query.service';

const campaignId = '11111111-1111-4111-8111-111111111111';
const adminId = '22222222-2222-4222-8222-222222222222';
const originalAppBaseUrl = process.env.APP_BASE_URL;

describe('AdminGrowthQueryService', () => {
  afterEach(() => {
    if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = originalAppBaseUrl;
  });

  it('returns the acquisition report from limited campaign fields and aggregate rows', async () => {
    process.env.APP_BASE_URL = 'https://app.example.test';
    const now = new Date('2026-10-06T03:00:00.000Z');
    const since = new Date('2026-09-06T03:00:00.000Z');
    const findMany = vi.fn().mockResolvedValue([{
      id: campaignId,
      name: '公開LP',
      code: 'launch',
      source: 'lp',
      medium: 'owned',
      content: null,
      landingPath: '/register',
      referralCode: null,
      createdBy: adminId,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    }]);
    const breakdown = [{ source: 'lp', medium: 'owned', campaign: 'launch', registered: 3, paid: 1 }];
    const acquisitionBreakdown = vi.fn().mockResolvedValue(breakdown);
    const service = new AdminGrowthQueryService({
      acquisitionCampaign: { findMany },
      user: { count: vi.fn().mockResolvedValue(2) },
    } as unknown as DbService, { acquisitionBreakdown } as unknown as AdminSummaryQueryService);

    const result = await service.acquisition(30, now);

    expect(acquisitionBreakdown).toHaveBeenCalledWith(since);
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        name: true,
        code: true,
        source: true,
        medium: true,
        content: true,
        landingPath: true,
        referralCode: true,
        createdBy: true,
        createdAt: true,
      },
    });
    expect(result).toMatchObject({
      days: 30,
      since: since.toISOString(),
      legacyMembers: 2,
      breakdown,
      campaigns: [{
        id: campaignId,
        registrationUrl: 'https://app.example.test/register?utm_source=lp&utm_medium=owned&utm_campaign=launch',
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|authSubject|paymentTransactions|creator/);
  });

  it('preserves aggregate-only onboarding stages and source filtering', async () => {
    const now = new Date('2026-10-06T03:00:00.000Z');
    const since = new Date('2026-09-06T03:00:00.000Z');
    const count = vi.fn();
    for (const value of [10, 8, 7, 6, 5, 2]) count.mockResolvedValueOnce(value);
    const sourceFindMany = vi.fn().mockResolvedValue([{ source: 'direct' }, { source: 'lp' }]);
    const trackingAt = new Date('2026-09-07T01:00:00.000Z');
    const service = new AdminGrowthQueryService({
      user: { count },
      memberAcquisition: { findMany: sourceFindMany },
      memberJourneyEvent: { findFirst: vi.fn().mockResolvedValue({ occurredAt: trackingAt }) },
    } as unknown as DbService, {} as AdminSummaryQueryService);

    const result = await service.onboarding(
      { days: 30, source: 'lp' },
      now,
      { LAUNCH_MODE: 'FREE_REGISTRATION' },
    );

    expect(result).toEqual({
      days: 30,
      since: since.toISOString(),
      source: 'lp',
      sources: ['direct', 'lp'],
      stages: [
        { key: 'REGISTERED', label: '無料登録', value: 10, rateFromRegistered: 100, dropOffFromPrevious: 0, rateFromPrevious: 100 },
        { key: 'IDENTITY_READY', label: '本人確認', value: 8, rateFromRegistered: 80, dropOffFromPrevious: 2, rateFromPrevious: 80 },
        { key: 'FIRST_LOGIN', label: '初回ログイン', value: 7, rateFromRegistered: 70, dropOffFromPrevious: 1, rateFromPrevious: 87.5 },
        { key: 'LINE_GUIDANCE_VIEWED', label: 'LINE案内到達', value: 6, rateFromRegistered: 60, dropOffFromPrevious: 1, rateFromPrevious: 85.7 },
        { key: 'LINE_READY', label: 'LINE受信準備', value: 5, rateFromRegistered: 50, dropOffFromPrevious: 1, rateFromPrevious: 83.3 },
      ],
      paid: 2,
      lineAvailable: true,
      trackingStartsAt: trackingAt.toISOString(),
      generatedAt: now.toISOString(),
    });
    expect(count.mock.calls[0][0]).toEqual({
      where: {
        AND: [{ role: 'MEMBER', createdAt: { gte: since }, acquisition: { is: { source: 'lp' } } }, {}],
      },
    });
    expect(sourceFindMany).toHaveBeenCalledWith({
      where: { user: { role: 'MEMBER' } },
      distinct: ['source'],
      orderBy: { source: 'asc' },
      select: { source: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/userId|email|displayName/);
  });
});
