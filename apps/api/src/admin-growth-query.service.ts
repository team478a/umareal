import { Inject, Injectable } from '@nestjs/common';
import {
  adminAcquisitionReportResponseSchema,
  launchCapabilities,
  onboardingFunnelResponseSchema,
  resolveLaunchMode,
} from '@keiba/domain';
import type {
  AdminAcquisitionBreakdown,
  AdminAcquisitionReportResponse,
  OnboardingFunnelResponse,
} from '@keiba/domain';
import type { Prisma } from '@keiba/db';
import { AdminSummaryQueryService } from './admin-summary-query.service';
import { DbService } from './db.service';

type OnboardingFunnelQuery = {
  days: number;
  source?: string;
};

type CampaignUrlInput = {
  code: string;
  source: string;
  medium: string;
  content: string | null;
  landingPath: string;
  referralCode: string | null;
};

@Injectable()
export class AdminGrowthQueryService {
  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(AdminSummaryQueryService) private readonly summaryQuery: AdminSummaryQueryService,
  ) {}

  async acquisition(days: number, now = new Date()): Promise<AdminAcquisitionReportResponse> {
    const since = new Date(now.getTime() - days * 86_400_000);
    const [campaigns, breakdown, legacyMembers] = await Promise.all([
      this.db.acquisitionCampaign.findMany({
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
      }),
      this.summaryQuery.acquisitionBreakdown(since),
      this.db.user.count({ where: { role: 'MEMBER', acquisition: null } }),
    ]);

    return adminAcquisitionReportResponseSchema.parse({
      days,
      since,
      legacyMembers,
      breakdown,
      campaigns: campaigns.map(campaign => ({
        ...campaign,
        registrationUrl: this.campaignUrl(campaign),
      })),
    });
  }

  acquisitionBreakdown(since: Date): Promise<AdminAcquisitionBreakdown[]> {
    return this.summaryQuery.acquisitionBreakdown(since);
  }

  async onboarding(
    input: OnboardingFunnelQuery,
    now = new Date(),
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<OnboardingFunnelResponse> {
    const { days, source } = input;
    const since = new Date(now.getTime() - days * 86_400_000);
    const where: Prisma.UserWhereInput = {
      role: 'MEMBER',
      createdAt: { gte: since },
      ...(source ? { acquisition: { is: { source } } } : {}),
    };
    const stageWhere = (extra: Prisma.UserWhereInput = {}) => ({
      AND: [where, extra],
    } satisfies Prisma.UserWhereInput);
    const count = (extra: Prisma.UserWhereInput = {}) => this.db.user.count({ where: stageWhere(extra) });
    const identityReadyWhere: Prisma.UserWhereInput = {
      OR: [{ emailVerifiedAt: { not: null } }, { registrationMethod: 'LINE' }],
    };
    const firstLoginWhere: Prisma.UserWhereInput = {
      AND: [
        identityReadyWhere,
        { OR: [{ journeyEvents: { some: { eventType: 'FIRST_LOGIN' } } }, { lineAccount: { isNot: null } }] },
      ],
    };
    const lineGuidanceWhere: Prisma.UserWhereInput = {
      AND: [
        firstLoginWhere,
        { OR: [{ journeyEvents: { some: { eventType: 'LINE_GUIDANCE_VIEWED' } } }, { lineAccount: { isNot: null } }] },
      ],
    };
    const [registered, identityReady, firstLogin, lineGuidanceViewed, lineReady, paid, sources, tracking] = await Promise.all([
      count(),
      count(identityReadyWhere),
      count(firstLoginWhere),
      count(lineGuidanceWhere),
      count({
        AND: [
          lineGuidanceWhere,
          {
            lineAccount: { is: { unlinkedAt: null, notificationDisabledAt: null } },
            preferences: { is: { predictions: true } },
          },
        ],
      }),
      count({ paymentTransactions: { some: { status: 'SUCCEEDED' } } }),
      this.db.memberAcquisition.findMany({
        where: { user: { role: 'MEMBER' } },
        distinct: ['source'],
        orderBy: { source: 'asc' },
        select: { source: true },
      }),
      this.db.memberJourneyEvent.findFirst({
        where: {
          eventType: { in: ['FIRST_LOGIN', 'LINE_GUIDANCE_VIEWED'] },
          user: { role: 'MEMBER' },
        },
        orderBy: { occurredAt: 'asc' },
        select: { occurredAt: true },
      }),
    ]);
    const values = [registered, identityReady, firstLogin, lineGuidanceViewed, lineReady];
    const keys = ['REGISTERED', 'IDENTITY_READY', 'FIRST_LOGIN', 'LINE_GUIDANCE_VIEWED', 'LINE_READY'] as const;
    const labels = ['無料登録', '本人確認', '初回ログイン', 'LINE案内到達', 'LINE受信準備'];
    const stages = values.map((value, index) => ({
      key: keys[index],
      label: labels[index],
      value,
      rateFromRegistered: registered ? Math.round(value / registered * 1000) / 10 : 0,
      dropOffFromPrevious: index === 0 ? 0 : Math.max(0, values[index - 1] - value),
      rateFromPrevious: index === 0 ? 100 : values[index - 1] ? Math.round(value / values[index - 1] * 1000) / 10 : 0,
    }));

    return onboardingFunnelResponseSchema.parse({
      days,
      since,
      source: source ?? null,
      sources: sources.map(item => item.source),
      stages,
      paid,
      lineAvailable: launchCapabilities(resolveLaunchMode(environment.LAUNCH_MODE)).lineNotifications,
      trackingStartsAt: tracking?.occurredAt ?? null,
      generatedAt: now,
    });
  }

  campaignUrl(campaign: CampaignUrlInput) {
    const url = new URL(campaign.landingPath, process.env.APP_BASE_URL);
    url.searchParams.set('utm_source', campaign.source);
    url.searchParams.set('utm_medium', campaign.medium);
    url.searchParams.set('utm_campaign', campaign.code);
    if (campaign.content) url.searchParams.set('utm_content', campaign.content);
    if (campaign.referralCode) url.searchParams.set('ref', campaign.referralCode);
    return url.toString();
  }
}
