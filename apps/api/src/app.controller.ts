import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { accountClosureCompletionResponseSchema, accountClosureEligibilityResponseSchema, acquisitionCampaignCreateSchema, acquisitionReportQuerySchema, adminAuditQuerySchema, adminBackupStatusResponseSchema, adminLocalRestoreAttestationInputSchema, adminLocalRestoreAttestationResponseSchema, adminProductionBackupAttestationInputSchema, adminProductionBackupAttestationResponseSchema, adminReadinessResponseSchema, adminRetentionPolicyInputSchema, adminRetentionPolicyResponseSchema, adminRetentionPolicySchema, adminRetentionPreviewResponseSchema, canEditRace, canManage, deploymentConsistency, jstDate, memberJourneyEventSchema, memberJourneyResponseSchema, notificationPreferencesResponseSchema, preferencesSchema, publicDeploymentRelease, publicRaceListQuerySchema, requiresMfa, workerHeartbeatStatus } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken, verifyPassword } from './security';
import { Prisma } from '@keiba/db';
import { ReadinessService } from './readiness.service';
import { AuthSessionService } from './auth-session.service';
import { MemberAccountQueryService } from './member-account-query.service';
import { AccountClosureService } from './account-closure.service';
import { AdminDirectoryQueryService } from './admin-directory-query.service';
import { AdminSummaryQueryService } from './admin-summary-query.service';
import { AdminOperationsQueryService } from './admin-operations-query.service';
import { PublicRaceQueryService } from './public-race-query.service';
import { ExpertRaceQueryService } from './expert-race-query.service';
import { AdminGrowthQueryService } from './admin-growth-query.service';
import { AdminIncidentQueryService } from './admin-incident-query.service';

const pagination = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) });
const onboardingFunnelQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), source: z.string().trim().min(1).max(100).optional() }).strict();
const closeAccountSchema = z.object({ reasonCode: z.enum(['SERVICE_NO_LONGER_NEEDED', 'PRICE', 'CONTENT', 'OTHER']), confirmation: z.literal('退会する'), currentPassword: z.string().max(128).optional() }).strict();
function csvCell(value: string | number) {
  let text = String(value); if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
@Controller()
export class AppController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ReadinessService) private readonly readinessQuery: ReadinessService,
    @Inject(AuthSessionService) private readonly sessions: AuthSessionService,
    @Inject(MemberAccountQueryService) private readonly memberAccountQuery: MemberAccountQueryService,
    @Inject(AccountClosureService) private readonly accountClosure: AccountClosureService,
    @Inject(AdminDirectoryQueryService) private readonly adminDirectoryQuery: AdminDirectoryQueryService,
    @Inject(AdminSummaryQueryService) private readonly adminSummaryQuery: AdminSummaryQueryService,
    @Inject(AdminOperationsQueryService) private readonly adminOperationsQuery: AdminOperationsQueryService,
    @Inject(PublicRaceQueryService) private readonly publicRaceQuery: PublicRaceQueryService,
    @Inject(ExpertRaceQueryService) private readonly expertRaceQuery: ExpertRaceQueryService,
    @Inject(AdminGrowthQueryService) private readonly adminGrowthQuery: AdminGrowthQueryService,
    @Inject(AdminIncidentQueryService) private readonly adminIncidentQuery: AdminIncidentQueryService
  ) {}
  @Get('health') async health() {
    const now = new Date();
    const [, heartbeat] = await Promise.all([
      this.auth.db.$queryRaw`SELECT 1`,
      this.auth.db.serviceHeartbeat.findUnique({ where: { service: 'worker' } })
    ]);
    const api = publicDeploymentRelease('api');
    const worker = publicDeploymentRelease('worker', heartbeat?.releaseCommit ?? null);
    return {
      status: 'ok',
      phase: 'win5-phase4-notifications',
      deployment: {
        consistency: deploymentConsistency([api.commit, worker.commit]),
        api,
        worker: {
          ...worker,
          status: workerHeartbeatStatus({ heartbeatAt: heartbeat?.heartbeatAt ?? null, now }),
          heartbeatAt: heartbeat?.heartbeatAt.toISOString() ?? null
        }
      }
    };
  }
  @Get('me') async me(@Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    return this.memberAccountQuery.current(identity);
  }
  @Patch('me/preferences') async preferences(@Body() body: unknown, @Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    const input = preferencesSchema.parse(body);
    const result = await this.auth.db.$transaction(async tx => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: identity.id }, select: { emailDeliveryDisabledAt: true } });
      if (input.emailEnabled && user.emailDeliveryDisabledAt) throw new ConflictException({ code: 'EMAIL_DELIVERY_BLOCKED', message: '配信先で受信拒否が確認されたため、メール通知を再開できません。メールアドレスを変更してください。' });
      const before = await tx.notificationPreference.findUnique({ where: { userId: identity.id } });
      const next = await tx.notificationPreference.upsert({ where: { userId: identity.id }, create: { userId: identity.id, ...input }, update: input });
      await this.auth.audit(tx, req, 'PREFERENCES_UPDATE', identity.id, '通知設定の変更', { before, after: input });
      return { emailEnabled: next.emailEnabled, predictions: next.predictions, changes: next.changes, articles: next.articles, billing: next.billing };
    });
    return notificationPreferencesResponseSchema.parse(result);
  }
  @Get('me/closure') async closureEligibility(@Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    if (identity.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: 'スタッフアカウントはこの画面から停止できません。' });
    const result = await this.accountClosure.eligibility(identity.id, !!identity.user.passwordHash);
    return accountClosureEligibilityResponseSchema.parse(result);
  }
  @Post('me/close') async closeAccount(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const identity = await this.auth.authenticate(req);
    if (identity.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: 'スタッフアカウントはこの画面から停止できません。' });
    const input = closeAccountSchema.parse(body);
    if (identity.user.passwordHash && (!input.currentPassword || !await verifyPassword(input.currentPassword, identity.user.passwordHash))) throw new UnauthorizedException({ code: 'CURRENT_PASSWORD_INVALID', message: '現在のパスワードを確認してください。' });
    const result = await this.accountClosure.close(identity.id, input.reasonCode, req);
    this.sessions.clearLocalSession(res);
    return accountClosureCompletionResponseSchema.parse(result);
  }
  @Post('me/journey') async journey(@Body() body: unknown, @Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    if (identity.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員向けの操作です。' });
    const { eventType } = memberJourneyEventSchema.parse(body);
    const event = await this.auth.db.$transaction(async tx => {
      await this.auth.journey(tx, identity.id, 'FIRST_LOGIN');
      return this.auth.journey(tx, identity.id, eventType);
    });
    return memberJourneyResponseSchema.parse({ ...event, recorded: true });
  }
  @Get('races') async races(@Query() query: unknown) {
    return this.publicRaceQuery.list(publicRaceListQuerySchema.parse(query));
  }
  @Get('announcements') async announcements() {
    return this.publicRaceQuery.announcements();
  }
  @Get('expert/races') async assigned(@Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    if (!['EXPERT', 'OPERATOR', 'ADMIN'].includes(identity.role) || identity.aal !== 2) {
      throw new ForbiddenException({ code: identity.aal !== 2 && ['EXPERT', 'OPERATOR', 'ADMIN'].includes(identity.role) ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '予想作業には担当権限と二段階認証が必要です。' });
    }
    return this.expertRaceQuery.list({ id: identity.id, role: identity.role });
  }
  @Get('expert/races/:raceId/workspace') async workspace(@Param('raceId') raceId: string, @Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    z.string().uuid().parse(raceId);
    const workspace = await this.expertRaceQuery.workspace(raceId);
    if (!workspace) throw new NotFoundException();
    if (!canEditRace(identity, workspace.assignedUserIds)) throw new ForbiddenException({ code: 'RACE_ACCESS_DENIED', message: '予想権限と二段階認証を確認してください。' });
    return workspace.response;
  }
  @Get('admin/summary') async summary(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    return this.adminSummaryQuery.get();
  }
  @Get('admin/operations') async operations(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(jstDate(new Date())) }).parse(query);
    return this.adminOperationsQuery.get(date);
  }
  @Get('admin/acquisition') async acquisition(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']);
    const { days } = acquisitionReportQuerySchema.parse(query);
    return this.adminGrowthQuery.acquisition(days);
  }
  @Get('admin/onboarding-funnel') async onboardingFunnel(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']);
    return this.adminGrowthQuery.onboarding(onboardingFunnelQuerySchema.parse(query));
  }
  @Post('admin/acquisition/campaigns') async createAcquisitionCampaign(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req, ['ADMIN']); const input = acquisitionCampaignCreateSchema.parse(body);
    try {
      const campaign = await this.auth.db.$transaction(async tx => {
        const created = await tx.acquisitionCampaign.create({ data: { name: input.name, code: input.code, source: input.source, medium: input.medium, content: input.content, landingPath: input.landingPath, referralCode: input.referralCode, createdBy: actor.id } });
        await this.auth.audit(tx, req, 'ACQUISITION_CAMPAIGN_CREATE', created.id, input.reason, { code: created.code, source: created.source, medium: created.medium, content: created.content, landingPath: created.landingPath, referralCode: created.referralCode }); return created;
      });
      return { ...campaign, registrationUrl: this.adminGrowthQuery.campaignUrl(campaign) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'CAMPAIGN_CODE_EXISTS', message: 'このキャンペーンコードは使用済みです。' });
      throw error;
    }
  }
  @Get('admin/acquisition/export.csv') async exportAcquisition(@Req() req: AppRequest, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    await this.staff(req, ['ADMIN']); const { days } = acquisitionReportQuerySchema.parse(query); const since = new Date(Date.now() - days * 86400000); const rows = await this.adminGrowthQuery.acquisitionBreakdown(since);
    const header = ['流入元', '媒体', 'キャンペーン', '無料登録数', '有料化数', '有料化率', '集計開始UTC'];
    const body = rows.map(row => [row.source, row.medium ?? '', row.campaign ?? '', row.registered, row.paid, row.registered ? `${Math.round(row.paid / row.registered * 100)}%` : '0%', since.toISOString()]);
    res.type('text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="acquisition-${days}days.csv"`); res.setHeader('Cache-Control', 'no-store');
    return `\uFEFF${[header, ...body].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }
  @Get('admin/incidents') async incidents(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    return this.adminIncidentQuery.get();
  }
  @Get('admin/backups/status') async backupStatus(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    return adminBackupStatusResponseSchema.parse(await this.readinessQuery.localBackupStatus());
  }
  @Get('admin/readiness/local-restore-attestation') async localRestoreAttestation(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    return adminLocalRestoreAttestationResponseSchema.parse({ latest: await this.readinessQuery.latestLocalRestoreAttestation() });
  }
  @Post('admin/readiness/local-restore-attestation') async attestLocalRestore(@Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    const input = adminLocalRestoreAttestationInputSchema.parse(body);
    const verification = await this.readinessQuery.validateLocalRestoreAttestation(input);
    const audit = await this.auth.db.$transaction(tx => this.auth.audit(
      tx,
      req,
      'LOCAL_RESTORE_ATTESTED',
      'LOCAL_RESTORE_TEST',
      input.reason,
      { verification, recordedByDisplayName: actor.user.displayName },
      'READINESS_CHECK'
    ));
    return adminLocalRestoreAttestationResponseSchema.parse({ latest: { id: audit.id, recordedAt: audit.createdAt, recordedBy: { id: actor.id, displayName: actor.user.displayName }, reason: audit.reason, verification } });
  }
  @Get('admin/readiness/production-backup-attestation') async productionBackupAttestation(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    return adminProductionBackupAttestationResponseSchema.parse({ latest: await this.readinessQuery.latestProductionBackupAttestation() });
  }
  @Post('admin/readiness/production-backup-attestation') async attestProductionBackup(@Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    const input = await this.readinessQuery.validateProductionBackupAttestation(adminProductionBackupAttestationInputSchema.parse(body));
    const { reason, ...evidence } = input;
    const audit = await this.auth.db.$transaction(tx => this.auth.audit(
      tx, req, 'PRODUCTION_BACKUP_ATTESTED', 'PRODUCTION_BACKUP', reason,
      { ...evidence, recordedByDisplayName: actor.user.displayName }, 'READINESS_CHECK'
    ));
    return adminProductionBackupAttestationResponseSchema.parse({ latest: { id: audit.id, recordedAt: audit.createdAt, recordedBy: { id: actor.id, displayName: actor.user.displayName }, reason, ...evidence, reviewStatus: 'CURRENT' } });
  }
  @Get('admin/readiness') async readiness(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    return adminReadinessResponseSchema.parse(await this.readinessQuery.getReadiness());
  }
  @Get('admin/account-closures') async accountClosures(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']);
    const { page, limit } = pagination.parse(query);
    return this.accountClosure.list(page, limit);
  }
  @Get('admin/account-closures/retention-policy') async retentionPolicy(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    return adminRetentionPolicyResponseSchema.parse(await this.accountClosure.retentionPolicyStatus());
  }
  @Get('admin/account-closures/retention-preview') async retentionPreview(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']);
    const { page, limit } = pagination.parse(query);
    return adminRetentionPreviewResponseSchema.parse(await this.accountClosure.retentionPreview(page, limit));
  }
  @Post('admin/account-closures/retention-policy') async approveRetentionPolicy(@Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    const input = adminRetentionPolicyInputSchema.parse(body);
    return adminRetentionPolicySchema.parse(await this.accountClosure.approveRetentionPolicy(input, actor, req));
  }
  @Get('admin/users') async users(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']);
    const { page, limit } = pagination.parse(query);
    return this.adminDirectoryQuery.users(page, limit);
  }
  @Get('admin/audit') async audit(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']);
    return this.adminDirectoryQuery.audit(adminAuditQuerySchema.parse(query));
  }
  @Post('admin/users/:userId/entitlements') async grant(@Param('userId') userId: string, @Body() body: unknown, @Req() req: AppRequest) {
    const actor = await this.staff(req, ['ADMIN']);
    z.string().uuid().parse(userId);
    const input = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), reason: z.string().trim().min(1).max(500), planCode: z.literal('MANUAL') }).strict().refine(v => new Date(v.endsAt) > new Date(v.startsAt), { message: '終了日時は開始日時より後にしてください。' }).parse(body);
    const header = z.string().uuid().parse(req.headers['idempotency-key']);
    const key = `grant:${actor.id}:${header}`;
    const requestHash = hashToken(JSON.stringify({ userId, ...input }));
    try {
      return await this.auth.db.$transaction(async tx => {
        await tx.idempotencyKey.create({ data: { key, requestHash, response: {} } });
        const grant = await tx.entitlement.create({ data: { ...input, userId, grantedBy: actor.id } });
        await this.auth.audit(tx, req, 'ENTITLEMENT_GRANT', userId, input.reason, { entitlementId: grant.id, ...input });
        const response = { id: grant.id };
        await tx.idempotencyKey.update({ where: { key }, data: { response } });
        return response;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const previous = await this.auth.db.idempotencyKey.findUnique({ where: { key } });
      if (!previous || previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_CONFLICT', message: '同じリクエストキーが異なる内容で使用されています。' });
      return previous.response;
    }
  }
  private async staff(req: AppRequest, roles: Role[]) {
    const identity = await this.auth.authenticate(req);
    if (!canManage(identity, roles)) throw new ForbiddenException({ code: requiresMfa(identity.role) && identity.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: 'この操作には権限と、必要な場合は二段階認証が必要です。' });
    return identity;
  }
}
