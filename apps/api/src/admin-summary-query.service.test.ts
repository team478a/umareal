import { describe, expect, it, vi } from 'vitest';
import type { DbService } from './db.service';
import { AdminSummaryQueryService } from './admin-summary-query.service';

describe('AdminSummaryQueryService', () => {
  it('preserves dashboard aggregates, cohort boundaries and limited acquisition selection', async () => {
    const now = new Date('2026-10-06T03:00:00.000Z');
    const cohortStartsAt = new Date('2026-09-06T03:00:00.000Z');
    const trackingStartsAt = new Date('2026-08-01T00:00:00.000Z');
    const userCount = vi.fn();
    for (const value of [100, 20, 100, 90, 80, 70, 60, 50, 30, 25, 20, 15, 10, 5, 7]) {
      userCount.mockResolvedValueOnce(value);
    }
    const raceCount = vi.fn()
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2);
    const acquisitionFindMany = vi.fn().mockResolvedValue([
      { source: 'lp', medium: 'owned', campaign: 'launch', user: { paymentTransactions: [{ id: 'payment-1' }] } },
      { source: 'lp', medium: 'owned', campaign: 'launch', user: { paymentTransactions: [] } },
      { source: 'line', medium: null, campaign: null, user: { paymentTransactions: [{ id: 'payment-2' }] } },
    ]);
    const operations = {
      newRegistrationsEnabled: true,
      emailNotificationsEnabled: true,
      predictionPublicationEnabled: true,
      csvImportEnabled: true,
      lineNotificationsEnabled: false,
      lineLoginEnabled: true,
      newPurchasesEnabled: false,
    };
    const service = new AdminSummaryQueryService({
      user: { count: userCount },
      race: { count: raceCount },
      auditLog: { count: vi.fn().mockResolvedValue(40) },
      notificationDelivery: { count: vi.fn().mockResolvedValue(4) },
      systemSetting: { findUnique: vi.fn().mockResolvedValue(operations) },
      memberJourneyEvent: { findFirst: vi.fn().mockResolvedValue({ occurredAt: trackingStartsAt }) },
      memberAcquisition: { findMany: acquisitionFindMany },
    } as unknown as DbService);

    const result = await service.get(now);

    expect(result).toEqual({
      members: 100,
      entitled: 20,
      races: 12,
      auditCount: 40,
      queuedNotifications: 4,
      racesNeedingPrediction: 3,
      resultsPending: 2,
      operations,
      funnel: {
        all: { registered: 100, identityReady: 90, lineReady: 80, planViewed: 70, checkoutReviewed: 60, paid: 50 },
        last30Days: { registered: 30, identityReady: 25, lineReady: 20, planViewed: 15, checkoutReviewed: 10, paid: 5, cohortStartsAt: cohortStartsAt.toISOString() },
        trackingStartsAt: trackingStartsAt.toISOString(),
      },
      acquisition: {
        last30Days: [
          { source: 'lp', medium: 'owned', campaign: 'launch', registered: 2, paid: 1 },
          { source: 'line', medium: null, campaign: null, registered: 1, paid: 1 },
        ],
        cohortStartsAt: cohortStartsAt.toISOString(),
        legacyMembers: 7,
      },
    });
    expect(acquisitionFindMany).toHaveBeenCalledWith({
      where: { capturedAt: { gte: cohortStartsAt } },
      select: {
        source: true,
        medium: true,
        campaign: true,
        user: {
          select: {
            paymentTransactions: {
              where: { status: 'SUCCEEDED' },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });
    expect(result).not.toHaveProperty('users');
    expect(result).not.toHaveProperty('auditLogs');
    expect(result.acquisition.last30Days[0]).not.toHaveProperty('memberIds');
  });
});
