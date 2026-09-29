import { describe, expect, it } from 'vitest';
import { adminSummaryResponseSchema } from './admin-summary';

describe('admin summary response contract', () => {
  const funnel = { registered: 10, identityReady: 9, lineReady: 8, planViewed: 7, checkoutReviewed: 6, paid: 5 };
  const response = {
    members: 10,
    entitled: 5,
    races: 4,
    auditCount: 3,
    queuedNotifications: 2,
    racesNeedingPrediction: 1,
    resultsPending: 1,
    operations: {
      newRegistrationsEnabled: true,
      emailNotificationsEnabled: true,
      predictionPublicationEnabled: true,
      csvImportEnabled: true,
      lineNotificationsEnabled: false,
      lineLoginEnabled: false,
      newPurchasesEnabled: true
    },
    funnel: {
      all: funnel,
      last30Days: { ...funnel, cohortStartsAt: new Date('2026-08-30T00:00:00.000Z') },
      trackingStartsAt: new Date('2026-08-01T00:00:00.000Z')
    },
    acquisition: {
      last30Days: [{ source: 'lp', medium: 'owned', campaign: 'launch', registered: 4, paid: 2 }],
      cohortStartsAt: new Date('2026-08-30T00:00:00.000Z'),
      legacyMembers: 1
    }
  };

  it('preserves aggregate counts and normalizes database dates', () => {
    expect(adminSummaryResponseSchema.parse(response)).toEqual({
      ...response,
      funnel: {
        ...response.funnel,
        last30Days: { ...funnel, cohortStartsAt: '2026-08-30T00:00:00.000Z' },
        trackingStartsAt: '2026-08-01T00:00:00.000Z'
      },
      acquisition: { ...response.acquisition, cohortStartsAt: '2026-08-30T00:00:00.000Z' }
    });
  });

  it('rejects member, payment, audit-detail and secret fields', () => {
    for (const privateField of ['users', 'email', 'userId', 'paymentIds', 'auditLogs', 'databaseUrl']) {
      expect(adminSummaryResponseSchema.safeParse({ ...response, [privateField]: 'private' }).success).toBe(false);
    }
    expect(adminSummaryResponseSchema.safeParse({ ...response, operations: { ...response.operations, stripeSecretKey: 'secret' } }).success).toBe(false);
    expect(adminSummaryResponseSchema.safeParse({ ...response, acquisition: { ...response.acquisition, last30Days: [{ ...response.acquisition.last30Days[0], memberIds: ['private'] }] } }).success).toBe(false);
  });
});
