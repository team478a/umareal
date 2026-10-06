import { Inject, Injectable } from '@nestjs/common';
import { adminSummaryResponseSchema } from '@keiba/domain';
import type { AdminSummaryResponse } from '@keiba/domain';
import type { Prisma } from '@keiba/db';
import { DbService } from './db.service';

@Injectable()
export class AdminSummaryQueryService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async get(now = new Date()): Promise<AdminSummaryResponse> {
    const cohortStartsAt = new Date(now.getTime() - 30 * 86_400_000);
    const [
      members,
      entitled,
      races,
      auditCount,
      queuedNotifications,
      racesNeedingPrediction,
      resultsPending,
      settings,
      funnelAll,
      funnel30Days,
      tracking,
      acquisition30Days,
      legacyMembers,
    ] = await Promise.all([
      this.db.user.count({ where: { role: 'MEMBER' } }),
      this.db.user.count({ where: { role: 'MEMBER', entitlements: { some: { revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } } } } }),
      this.db.race.count(),
      this.db.auditLog.count(),
      this.db.notificationDelivery.count({ where: { status: { in: ['QUEUED', 'SENDING'] } } }),
      this.db.race.count({ where: { startsAt: { gt: now }, status: { in: ['SCHEDULED', 'ACTIVE', 'DELAYED'] }, OR: [{ prediction: null }, { prediction: { versions: { none: {} } } }] } }),
      this.db.race.count({ where: { startsAt: { lte: now }, prediction: { versions: { some: {} } }, resultVersions: { none: {} } } }),
      this.db.systemSetting.findUnique({ where: { id: 'global' }, select: { newRegistrationsEnabled: true, emailNotificationsEnabled: true, predictionPublicationEnabled: true, csvImportEnabled: true, lineNotificationsEnabled: true, lineLoginEnabled: true, newPurchasesEnabled: true } }),
      this.memberFunnel(),
      this.memberFunnel(cohortStartsAt),
      this.db.memberJourneyEvent.findFirst({ orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
      this.acquisitionBreakdown(cohortStartsAt),
      this.db.user.count({ where: { role: 'MEMBER', acquisition: null } }),
    ]);

    return adminSummaryResponseSchema.parse({
      members,
      entitled,
      races,
      auditCount,
      queuedNotifications,
      racesNeedingPrediction,
      resultsPending,
      operations: settings,
      funnel: {
        all: funnelAll,
        last30Days: { ...funnel30Days, cohortStartsAt },
        trackingStartsAt: tracking?.occurredAt ?? null,
      },
      acquisition: {
        last30Days: acquisition30Days.slice(0, 20),
        cohortStartsAt,
        legacyMembers,
      },
    });
  }

  private async memberFunnel(since?: Date) {
    const base: Prisma.UserWhereInput = { role: 'MEMBER', ...(since ? { createdAt: { gte: since } } : {}) };
    const count = (extra: Prisma.UserWhereInput = {}) => this.db.user.count({ where: { AND: [base, extra] } });
    const [registered, identityReady, lineReady, planViewed, checkoutReviewed, paid] = await Promise.all([
      count(),
      count({ OR: [{ emailVerifiedAt: { not: null } }, { registrationMethod: 'LINE' }] }),
      count({ lineAccount: { is: { unlinkedAt: null, notificationDisabledAt: null } }, preferences: { is: { predictions: true } } }),
      count({ journeyEvents: { some: { eventType: 'PLAN_VIEWED' } } }),
      count({ journeyEvents: { some: { eventType: 'CHECKOUT_REVIEWED' } } }),
      count({ paymentTransactions: { some: { status: 'SUCCEEDED' } } }),
    ]);
    return { registered, identityReady, lineReady, planViewed, checkoutReviewed, paid };
  }

  async acquisitionBreakdown(since: Date) {
    const rows = await this.db.memberAcquisition.findMany({
      where: { capturedAt: { gte: since } },
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
    const groups = new Map<string, { source: string; medium: string | null; campaign: string | null; registered: number; paid: number }>();
    for (const row of rows) {
      const key = JSON.stringify([row.source, row.medium, row.campaign]);
      const item = groups.get(key) ?? { source: row.source, medium: row.medium, campaign: row.campaign, registered: 0, paid: 0 };
      item.registered++;
      if (row.user.paymentTransactions.length) item.paid++;
      groups.set(key, item);
    }
    return [...groups.values()].sort((a, b) => b.registered - a.registered || b.paid - a.paid || a.source.localeCompare(b.source));
  }
}
