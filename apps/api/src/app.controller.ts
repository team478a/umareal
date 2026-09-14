import { Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { acquisitionCampaignCreateSchema, acquisitionReportQuerySchema, assessmentSchema, canEditRace, canManage, consentVersions, jstDate, launchCapabilities, legalDocumentReleaseErrors, paddockComplete, preferencesSchema, requiresMfa, resolveLaunchMode } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { z } from 'zod';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken, verifyPassword } from './security';
import { Prisma } from '@keiba/db';
import { databaseRuntimeAccessRestricted } from '@keiba/db';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadStripeConfig } from './stripe-config';

const pagination = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(50).default(20) });
const journeyEventSchema = z.object({ eventType: z.enum(['PLAN_VIEWED', 'CHECKOUT_REVIEWED']) }).strict();
const verifiedBackupSchema = z.object({ status: z.literal('VERIFIED'), verifiedAt: z.string().datetime(), backupId: z.string().regex(/^keiba-physical-\d{14}$/), format: z.literal('postgresql-physical-directory'), postgresMajor: z.literal(16), encrypted: z.literal(false), sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive(), fileCount: z.number().int().positive(), migrations: z.number().int().nonnegative(), requiredTriggers: z.number().int().nonnegative(), restoredDatabaseRemoved: z.literal(true), counts: z.object({ users: z.number().int().nonnegative(), races: z.number().int().nonnegative(), predictionVersions: z.number().int().nonnegative(), freeReportVersions: z.number().int().nonnegative(), audioAssets: z.number().int().nonnegative(), publicationSchedules: z.number().int().nonnegative(), memberAcquisitions: z.number().int().nonnegative(), acquisitionCampaigns: z.number().int().nonnegative(), auditLogs: z.number().int().nonnegative(), notificationEvents: z.number().int().nonnegative() }).strict() }).strict();
const failedBackupSchema = z.object({ status: z.literal('FAILED'), attemptedAt: z.string().datetime(), errorCode: z.literal('BACKUP_VERIFY_FAILED'), backupId: z.string().regex(/^keiba-physical-\d{14}$/).nullable(), restoredDatabaseRemoved: z.boolean() }).strict();
const closeAccountSchema = z.object({ reasonCode: z.enum(['SERVICE_NO_LONGER_NEEDED', 'PRICE', 'CONTENT', 'OTHER']), confirmation: z.literal('退会する'), currentPassword: z.string().max(128).optional() }).strict();
async function readLocalBackupStatus() {
  const statusPath = resolve(__dirname, '../../../.local/backups/status.json');
  try {
    const value: unknown = JSON.parse(await readFile(statusPath, 'utf8'));
    return z.union([verifiedBackupSchema, failedBackupSchema]).parse(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'NOT_RUN' as const, localOnly: true };
    if (error instanceof SyntaxError || error instanceof z.ZodError) return { status: 'INVALID' as const, localOnly: true };
    throw error;
  }
}
function csvCell(value: string | number) {
  let text = String(value); if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
@Controller()
export class AppController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Get('health') async health() { await this.auth.db.$queryRaw`SELECT 1`; return { status: 'ok', phase: '6n-free-registration-launch' }; }
  @Get('me') async me(@Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    const user = await this.auth.db.user.findUniqueOrThrow({ where: { id: identity.id }, include: { preferences: true, lineAccount: true, entitlements: { where: { revokedAt: null, endsAt: { gt: new Date() } } }, consents: { orderBy: { acceptedAt: 'desc' } } } });
    const preferences = {
      emailEnabled: user.preferences?.emailEnabled ?? true,
      predictions: user.preferences?.predictions ?? true, changes: user.preferences?.changes ?? true,
      articles: user.preferences?.articles ?? false, billing: user.preferences?.billing ?? true
    };
    const lineNotificationState = !user.lineAccount || user.lineAccount.unlinkedAt ? 'NOT_LINKED' : user.lineAccount.notificationDisabledAt ? 'BLOCKED' : !preferences.predictions ? 'DISABLED' : 'READY';
    return { id: user.id, email: user.email, emailVerified: !!user.emailVerifiedAt, hasPassword: !!user.passwordHash || (process.env.AUTH_PROVIDER === 'supabase' && !!user.authSubject), registrationMethod: user.registrationMethod, displayName: user.displayName, role: user.role, aal: identity.aal, mfaEnabled: !!user.mfaSecret || !!user.externalMfaFactorId || identity.aal === 2,
      mfaRequired: requiresMfa(user.role), preferences, lineLinked: !!user.lineAccount && !user.lineAccount.unlinkedAt,
      lineNotificationState, lineNotificationReady: lineNotificationState === 'READY',
      entitlements: user.entitlements.map(e => ({ planCode: e.planCode, startsAt: e.startsAt, endsAt: e.endsAt, raceDate: e.raceDate })),
      consents: user.consents.map(c => ({ documentType: c.documentType, version: c.version, acceptedAt: c.acceptedAt })) };
  }
  @Patch('me/preferences') async preferences(@Body() body: unknown, @Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    const input = preferencesSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      const before = await tx.notificationPreference.findUnique({ where: { userId: identity.id } });
      const next = await tx.notificationPreference.upsert({ where: { userId: identity.id }, create: { userId: identity.id, ...input }, update: input });
      await this.auth.audit(tx, req, 'PREFERENCES_UPDATE', identity.id, '通知設定の変更', { before, after: input });
      return { emailEnabled: next.emailEnabled, predictions: next.predictions, changes: next.changes, articles: next.articles, billing: next.billing };
    });
  }
  @Get('me/closure') async closureEligibility(@Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    if (identity.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: 'スタッフアカウントはこの画面から停止できません。' });
    const now = new Date();
    const [subscription, dayPass] = await Promise.all([
      this.auth.db.subscription.findFirst({ where: { userId: identity.id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] }, currentPeriodEndsAt: { gt: now } }, select: { id: true, currentPeriodEndsAt: true, cancelAtPeriodEnd: true } }),
      this.auth.db.dayPass.findFirst({ where: { userId: identity.id, status: { in: ['PENDING', 'ACTIVE'] }, endsAt: { gt: now } }, select: { id: true, endsAt: true } })
    ]);
    const blockers = [
      ...(subscription ? [{ code: 'ACTIVE_SUBSCRIPTION', message: subscription.cancelAtPeriodEnd ? '解約予約済みの月額契約は利用期間終了後に退会できます。' : '有効な月額契約を先に解約予約してください。', href: '/account', endsAt: subscription.currentPeriodEndsAt }] : []),
      ...(dayPass ? [{ code: 'ACTIVE_DAY_PASS', message: '有効な1日利用の終了後に退会できます。', href: '/account', endsAt: dayPass.endsAt }] : [])
    ];
    return { eligible: blockers.length === 0, passwordRequired: !!identity.user.passwordHash, blockers, retentionPolicyVersion: 'development-v1', retained: ['公開・評価履歴との関係', '支払・契約履歴', '同意履歴', '監査履歴'] };
  }
  @Post('me/close') async closeAccount(@Body() body: unknown, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const identity = await this.auth.authenticate(req);
    if (identity.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: 'スタッフアカウントはこの画面から停止できません。' });
    const input = closeAccountSchema.parse(body);
    if (identity.user.passwordHash && (!input.currentPassword || !await verifyPassword(input.currentPassword, identity.user.passwordHash))) throw new UnauthorizedException({ code: 'CURRENT_PASSWORD_INVALID', message: '現在のパスワードを確認してください。' });
    const result = await this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-closure:${identity.id}`}))::text`;
      const previous = await tx.accountClosure.findUnique({ where: { userId: identity.id } });
      if (previous) return { closedAt: previous.accessRevokedAt, alreadyClosed: true };
      const now = new Date();
      const [activeSubscriptions, activeDayPasses] = await Promise.all([
        tx.subscription.count({ where: { userId: identity.id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] }, currentPeriodEndsAt: { gt: now } } }),
        tx.dayPass.count({ where: { userId: identity.id, status: { in: ['PENDING', 'ACTIVE'] }, endsAt: { gt: now } } })
      ]);
      if (activeSubscriptions || activeDayPasses) throw new ConflictException({ code: 'ACTIVE_BILLING_EXISTS', message: '利用期間中の契約があります。解約または利用期間終了後に退会してください。' });
      const closure = await tx.accountClosure.create({ data: { userId: identity.id, reasonCode: input.reasonCode, requestedAt: now, accessRevokedAt: now, retentionPolicyVersion: 'development-v1' } });
      await tx.notificationPreference.updateMany({ where: { userId: identity.id }, data: { predictions: false, changes: false, articles: false, billing: false } });
      await tx.lineAccount.updateMany({ where: { userId: identity.id }, data: { unlinkedAt: now, notificationDisabledAt: now } });
      await tx.entitlement.updateMany({ where: { userId: identity.id, revokedAt: null, endsAt: { gt: now } }, data: { revokedAt: now } });
      await tx.emailVerification.updateMany({ where: { userId: identity.id, usedAt: null }, data: { usedAt: now } });
      await tx.passwordReset.updateMany({ where: { userId: identity.id, usedAt: null }, data: { usedAt: now } });
      await tx.lineOAuthFlow.updateMany({ where: { userId: identity.id, usedAt: null }, data: { usedAt: now } });
      await this.auth.audit(tx, req, 'ACCOUNT_CLOSED', identity.id, '会員本人による退会', { closureId: closure.id, reasonCode: input.reasonCode, retentionPolicyVersion: closure.retentionPolicyVersion });
      await tx.user.update({ where: { id: identity.id }, data: { disabledAt: now } });
      await tx.session.deleteMany({ where: { userId: identity.id } });
      return { closedAt: closure.accessRevokedAt, alreadyClosed: false };
    });
    res.clearCookie('keiba_session', { httpOnly: true, sameSite: 'lax', path: '/' });
    return { ...result, retainedHistory: true };
  }
  @Post('me/journey') async journey(@Body() body: unknown, @Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    if (identity.role !== 'MEMBER') throw new ForbiddenException({ code: 'MEMBER_REQUIRED', message: '会員向けの操作です。' });
    const { eventType } = journeyEventSchema.parse(body);
    const event = await this.auth.db.memberJourneyEvent.upsert({
      where: { userId_eventType: { userId: identity.id, eventType } },
      create: { userId: identity.id, eventType }, update: {}, select: { eventType: true, occurredAt: true }
    });
    return { ...event, recorded: true };
  }
  @Get('races') async races(@Query() query: unknown) {
    const { page, limit, date, publication, venue } = pagination.extend({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(jstDate(new Date())), publication: z.enum(['ALL', 'ANNOUNCED', 'PUBLISHED', 'UNPUBLISHED']).default('ALL'), venue: z.string().trim().min(1).max(60).optional() }).parse(query);
    const where: Prisma.RaceWhereInput = { raceDate: date, ...(venue ? { venue } : {}), ...(publication === 'ANNOUNCED' ? { announcements: { some: {} } } : publication === 'PUBLISHED' ? { prediction: { versions: { some: {} } } } : publication === 'UNPUBLISHED' ? { OR: [{ prediction: null }, { prediction: { versions: { none: {} } } }] } : {}) };
    const [rows, total, venueRows] = await this.auth.db.$transaction([
      this.auth.db.race.findMany({ where, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit, include: { announcements: { orderBy: { version: 'desc' }, take: 1, select: { version: true, publishedAt: true } }, prediction: { select: { versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, status: true, visibility: true, publishedAt: true } } } } } }),
      this.auth.db.race.count({ where }),
      this.auth.db.race.findMany({ where: { raceDate: date }, distinct: ['venue'], select: { venue: true }, orderBy: { venue: 'asc' } })
    ]);
    const items = rows.map(({ announcements, prediction, ...race }) => ({ ...race, latestAnnouncement: announcements[0] ?? null, latestPrediction: prediction?.versions[0] ?? null }));
    return { items, total, page, limit, filters: { date, publication, venue: venue ?? null, venues: venueRows.map(item => item.venue) } };
  }
  @Get('announcements') async announcements() {
    const rows = await this.auth.db.raceAnnouncement.findMany({ where: { race: { startsAt: { gt: new Date(Date.now() - 6 * 3600000) }, status: { notIn: ['CANCELLED'] } } }, include: { race: true }, orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }], take: 50 });
    const seen = new Set<string>();
    const items = rows.filter(row => { if (seen.has(row.raceId)) return false; seen.add(row.raceId); return true; }).slice(0, 10);
    return { items: items.map(row => ({ id: row.id, version: row.version, publishedAt: row.publishedAt, race: { id: row.race.id, raceDate: row.race.raceDate, venue: row.race.venue, number: row.race.number, name: row.race.name, startsAt: row.race.startsAt } })) };
  }
  @Get('expert/races') async assigned(@Req() req: AppRequest) {
    const identity = await this.staff(req, ['EXPERT', 'ADMIN']);
    return { items: await this.auth.db.race.findMany({ where: identity.role === 'ADMIN' ? {} : { assignments: { some: { userId: identity.id } } }, take: 50, orderBy: { startsAt: 'asc' } }) };
  }
  @Get('expert/races/:raceId/workspace') async workspace(@Param('raceId') raceId: string, @Req() req: AppRequest) {
    const identity = await this.auth.authenticate(req);
    z.string().uuid().parse(raceId);
    const race = await this.auth.db.race.findUnique({ where: { id: raceId }, include: { assignments: true } });
    if (!race) throw new NotFoundException();
    if (!canEditRace(identity, race.assignments.map(a => a.userId))) throw new ForbiddenException({ code: 'RACE_ACCESS_DENIED', message: '担当レースと二段階認証を確認してください。' });
    return { race: { id: race.id, name: race.name, startsAt: race.startsAt }, inputEnabled: true };
  }
  @Get('admin/summary') async summary(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    const now = new Date();
    const cohortStartsAt = new Date(now.getTime() - 30 * 86400000);
    const [members, entitled, races, auditCount, queuedNotifications, racesNeedingPrediction, resultsPending, settings, funnelAll, funnel30Days, tracking, acquisition30Days, legacyMembers] = await Promise.all([
      this.auth.db.user.count({ where: { role: 'MEMBER' } }), this.auth.db.user.count({ where: { role: 'MEMBER', entitlements: { some: { revokedAt: null, startsAt: { lte: now }, endsAt: { gt: now } } } } }), this.auth.db.race.count(), this.auth.db.auditLog.count(),
      this.auth.db.notificationDelivery.count({ where: { status: { in: ['QUEUED', 'SENDING'] } } }),
      this.auth.db.race.count({ where: { startsAt: { gt: now }, status: { in: ['SCHEDULED', 'ACTIVE', 'DELAYED'] }, OR: [{ prediction: null }, { prediction: { versions: { none: {} } } }] } }),
      this.auth.db.race.count({ where: { startsAt: { lte: now }, prediction: { versions: { some: {} } }, resultVersions: { none: {} } } }),
      this.auth.db.systemSetting.findUnique({ where: { id: 'global' }, select: { newRegistrationsEnabled: true, emailNotificationsEnabled: true, predictionPublicationEnabled: true, csvImportEnabled: true, lineNotificationsEnabled: true, lineLoginEnabled: true, newPurchasesEnabled: true } }),
      this.memberFunnel(), this.memberFunnel(cohortStartsAt),
      this.auth.db.memberJourneyEvent.findFirst({ orderBy: { occurredAt: 'asc' }, select: { occurredAt: true } }),
      this.acquisitionBreakdown(cohortStartsAt),
      this.auth.db.user.count({ where: { role: 'MEMBER', acquisition: null } })
    ]);
    return { members, entitled, races, auditCount, queuedNotifications, racesNeedingPrediction, resultsPending, operations: settings,
      funnel: { all: funnelAll, last30Days: { ...funnel30Days, cohortStartsAt }, trackingStartsAt: tracking?.occurredAt ?? null },
      acquisition: { last30Days: acquisition30Days.slice(0, 20), cohortStartsAt, legacyMembers } };
  }
  @Get('admin/operations') async operations(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(jstDate(new Date())) }).parse(query);
    const now = new Date();
    const [races, settings] = await Promise.all([
      this.auth.db.race.findMany({ where: { raceDate: date }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], include: {
        assignments: { include: { user: { select: { id: true, displayName: true, disabledAt: true } } } },
        entries: { where: { status: 'ACTIVE' }, orderBy: { number: 'asc' }, include: { assessment: { select: { content: true } } } },
        announcements: { orderBy: { version: 'desc' }, take: 1, include: { notificationEvent: { include: { deliveries: { select: { status: true } } } } } },
        prediction: { include: { versions: { orderBy: { version: 'desc' }, take: 1, include: { notificationEvent: { include: { deliveries: { select: { status: true } } } } } } } },
        resultVersions: { orderBy: { version: 'desc' }, take: 1, select: { version: true, confirmedAt: true } }
      } }),
      this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { csvImportEnabled: true, predictionPublicationEnabled: true, lineNotificationsEnabled: true, lineChannelId: true, lineChannelSecretEncrypted: true, lineAccessTokenEncrypted: true } })
    ]);
    const items = races.map(race => {
      const completed = race.entries.filter(entry => { const parsed = assessmentSchema.safeParse(entry.assessment?.content); return parsed.success && paddockComplete(parsed.data); }).length;
      const announcement = race.announcements[0] ?? null; const prediction = race.prediction?.versions[0] ?? null;
      const deliveries = [announcement?.notificationEvent, prediction?.notificationEvent].flatMap(event => event?.deliveries ?? []);
      const notification = { queued: deliveries.filter(item => ['QUEUED', 'SENDING', 'RETRIED'].includes(item.status)).length, sent: deliveries.filter(item => item.status === 'SENT').length, failed: deliveries.filter(item => item.status === 'FAILED').length };
      const secondsRemaining = Math.floor((race.startsAt.getTime() - now.getTime()) / 1000);
      const warnings: string[] = [];
      if (!race.assignments.length) warnings.push('担当者未設定');
      if (!race.entries.length) warnings.push('出走馬未登録');
      if (!announcement) warnings.push('対象レース未告知');
      if (race.entries.length && completed === 0) warnings.push('パドック未着手');
      else if (completed < race.entries.length) warnings.push(`パドック未完了 ${race.entries.length - completed}頭`);
      if (!prediction) warnings.push(secondsRemaining <= 0 ? '最終予想が期限超過' : '最終予想未公開');
      if (notification.failed) warnings.push(`通知失敗 ${notification.failed}件`);
      if (secondsRemaining <= 0 && prediction && !race.resultVersions.length && race.status !== 'CANCELLED') warnings.push('結果未確定');
      const activeAssignment = race.assignments.some(item => !item.user.disabledAt);
      const setupDone = activeAssignment && race.entries.length > 0;
      const paddockDone = race.entries.length > 0 && completed === race.entries.length;
      const predictionDeliveries = prediction?.notificationEvent?.deliveries ?? [];
      const predictionQueued = predictionDeliveries.some(item => ['QUEUED', 'SENDING', 'RETRIED'].includes(item.status));
      const notificationFailed = notification.failed > 0;
      const predictionSent = predictionDeliveries.some(item => item.status === 'SENT');
      const notificationsConfigured = !!settings.lineChannelId && !!settings.lineChannelSecretEncrypted && !!settings.lineAccessTokenEncrypted;
      const steps: { key: string; label: string; state: 'DONE' | 'CURRENT' | 'WAITING' | 'BLOCKED' | 'NOT_DUE'; detail: string }[] = [
        { key: 'SETUP', label: 'レース準備', state: setupDone ? 'DONE' : 'CURRENT', detail: !activeAssignment ? '有効な担当者を設定してください' : !race.entries.length ? '出走馬を登録してください' : `${race.entries.length}頭・担当者設定済み` },
        { key: 'ANNOUNCEMENT', label: '対象レース告知', state: announcement ? 'DONE' : setupDone ? 'CURRENT' : 'WAITING', detail: announcement ? `公開済み v${announcement.version}` : '無料会員へ対象レースを告知します' },
        { key: 'PADDOCK', label: 'パドック評価', state: paddockDone ? 'DONE' : !setupDone || !announcement ? 'WAITING' : 'CURRENT', detail: `${completed}/${race.entries.length}頭完了` },
        { key: 'PUBLICATION', label: '最終予想公開', state: prediction ? 'DONE' : !settings.predictionPublicationEnabled || secondsRemaining <= 0 ? 'BLOCKED' : !paddockDone ? 'WAITING' : 'CURRENT', detail: prediction ? `公開済み v${prediction.version}` : !settings.predictionPublicationEnabled ? '予想公開が緊急停止中です' : secondsRemaining <= 0 ? '公開締切を経過しています' : 'プレビュー確認後に公開します' },
        { key: 'DELIVERY', label: '通知確認', state: notificationFailed ? 'BLOCKED' : predictionQueued ? 'CURRENT' : predictionSent || prediction?.notificationEvent?.status === 'SKIPPED' ? 'DONE' : prediction && (!settings.lineNotificationsEnabled || !notificationsConfigured) ? 'BLOCKED' : prediction ? 'CURRENT' : 'WAITING', detail: notificationFailed ? '失敗した告知・予想配送を確認してください' : predictionQueued ? '通知処理を待っています' : predictionSent ? '送信済みです' : prediction?.notificationEvent?.status === 'SKIPPED' ? '通知対象なしとして処理済みです' : !settings.lineNotificationsEnabled ? 'LINE通知が緊急停止中です' : !notificationsConfigured ? 'LINE通知設定が未完了です' : '通知イベントを確認します' },
        { key: 'RESULT', label: '結果確定', state: race.resultVersions.length ? 'DONE' : secondsRemaining > 0 ? 'NOT_DUE' : prediction ? 'CURRENT' : 'WAITING', detail: race.resultVersions.length ? `確定済み v${race.resultVersions[0].version}` : secondsRemaining > 0 ? '発走後に確認します' : '着順・払戻を確認して確定します' }
      ];
      const blocking = steps.filter(step => step.state === 'BLOCKED').length;
      const done = steps.filter(step => step.state === 'DONE').length;
      const actionable = steps.find(step => step.state === 'BLOCKED' || step.state === 'CURRENT') ?? null;
      const rehearsalStatus = blocking ? 'BLOCKED' : done === steps.length ? 'COMPLETE' : steps[5].state === 'NOT_DUE' && steps.slice(0, 5).every(step => step.state === 'DONE') ? 'READY' : 'IN_PROGRESS';
      return { id: race.id, raceDate: race.raceDate, venue: race.venue, number: race.number, name: race.name, status: race.status, startsAt: race.startsAt,
        secondsRemaining, deadlineState: secondsRemaining <= 0 ? 'OVERDUE' : secondsRemaining <= 1800 ? 'DUE_SOON' : 'UPCOMING',
        assignments: race.assignments.map(item => ({ id: item.user.id, displayName: item.user.displayName, active: !item.user.disabledAt })),
        entries: { total: race.entries.length, paddockCompleted: completed },
        announcement: announcement ? { version: announcement.version, publishedAt: announcement.publishedAt, eventStatus: announcement.notificationEvent?.status ?? null } : null,
        prediction: prediction ? { version: prediction.version, status: prediction.status, publishedAt: prediction.publishedAt, eventStatus: prediction.notificationEvent?.status ?? null } : null,
        notification, result: race.resultVersions[0] ?? null, warnings,
        rehearsal: { status: rehearsalStatus, done, total: steps.length, nextStep: actionable?.key ?? null, steps } };
    });
    return { date, generatedAt: now, items, alerts: items.reduce((sum, item) => sum + item.warnings.length, 0), rehearsal: {
      ready: items.filter(item => ['READY', 'COMPLETE'].includes(item.rehearsal.status)).length,
      blocked: items.filter(item => item.rehearsal.status === 'BLOCKED').length,
      total: items.length,
      preflight: { csvImportEnabled: settings.csvImportEnabled, predictionPublicationEnabled: settings.predictionPublicationEnabled, lineNotificationsEnabled: settings.lineNotificationsEnabled, lineConfigured: !!settings.lineChannelId && !!settings.lineChannelSecretEncrypted && !!settings.lineAccessTokenEncrypted }
    } };
  }
  @Get('admin/acquisition') async acquisition(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']); const { days } = acquisitionReportQuerySchema.parse(query); const since = new Date(Date.now() - days * 86400000);
    const [campaigns, breakdown, legacyMembers] = await Promise.all([
      this.auth.db.acquisitionCampaign.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
      this.acquisitionBreakdown(since), this.auth.db.user.count({ where: { role: 'MEMBER', acquisition: null } })
    ]);
    return { days, since, legacyMembers, breakdown, campaigns: campaigns.map(campaign => ({ ...campaign, registrationUrl: this.campaignUrl(campaign) })) };
  }
  @Post('admin/acquisition/campaigns') async createAcquisitionCampaign(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req, ['ADMIN']); const input = acquisitionCampaignCreateSchema.parse(body);
    try {
      const campaign = await this.auth.db.$transaction(async tx => {
        const created = await tx.acquisitionCampaign.create({ data: { name: input.name, code: input.code, source: input.source, medium: input.medium, content: input.content, landingPath: input.landingPath, referralCode: input.referralCode, createdBy: actor.id } });
        await this.auth.audit(tx, req, 'ACQUISITION_CAMPAIGN_CREATE', created.id, input.reason, { code: created.code, source: created.source, medium: created.medium, content: created.content, landingPath: created.landingPath, referralCode: created.referralCode }); return created;
      });
      return { ...campaign, registrationUrl: this.campaignUrl(campaign) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'CAMPAIGN_CODE_EXISTS', message: 'このキャンペーンコードは使用済みです。' });
      throw error;
    }
  }
  @Get('admin/acquisition/export.csv') async exportAcquisition(@Req() req: AppRequest, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    await this.staff(req, ['ADMIN']); const { days } = acquisitionReportQuerySchema.parse(query); const since = new Date(Date.now() - days * 86400000); const rows = await this.acquisitionBreakdown(since);
    const header = ['流入元', '媒体', 'キャンペーン', '無料登録数', '有料化数', '有料化率', '集計開始UTC'];
    const body = rows.map(row => [row.source, row.medium ?? '', row.campaign ?? '', row.registered, row.paid, row.registered ? `${Math.round(row.paid / row.registered * 100)}%` : '0%', since.toISOString()]);
    res.type('text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="acquisition-${days}days.csv"`); res.setHeader('Cache-Control', 'no-store');
    return `\uFEFF${[header, ...body].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  }
  @Get('admin/incidents') async incidents(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    const now = new Date(); const delayedAt = new Date(now.getTime() - 60_000); const staleLeaseAt = new Date(now.getTime() - 5 * 60_000); const since = new Date(now.getTime() - 24 * 60 * 60_000);
    const [settings, failed, delayed, stuck, lastWebhook, unmatchedWebhooks] = await this.auth.db.$transaction([
      this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { emailNotificationsEnabled: true, predictionPublicationEnabled: true, csvImportEnabled: true, lineNotificationsEnabled: true, newPurchasesEnabled: true, maintenanceMessage: true, lineChannelId: true, lineChannelSecretEncrypted: true, lineAccessTokenEncrypted: true, updatedAt: true } }),
      this.auth.db.notificationDelivery.count({ where: { status: 'FAILED' } }),
      this.auth.db.notificationDelivery.count({ where: { status: 'QUEUED', attemptCount: 0, createdAt: { lt: delayedAt }, nextAttemptAt: { lte: now } } }),
      this.auth.db.notificationDelivery.count({ where: { status: 'SENDING', lockedAt: { lt: staleLeaseAt } } }),
      this.auth.db.lineWebhookEvent.findFirst({ orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }], select: { receivedAt: true, eventType: true, outcome: true } }),
      this.auth.db.lineWebhookEvent.count({ where: { receivedAt: { gte: since }, outcome: 'UNMATCHED' } })
    ]);
    const lineConfigured = !!settings.lineChannelId && !!settings.lineChannelSecretEncrypted && !!settings.lineAccessTokenEncrypted;
    const issues: { code: string; severity: 'CRITICAL' | 'WARNING' | 'INFO'; title: string; detail: string; action: string; href: string }[] = [];
    if (!settings.predictionPublicationEnabled) issues.push({ code: 'PREDICTION_PAUSED', severity: 'CRITICAL', title: '予想公開が停止中', detail: '新しいプレビュー確認と公開確定が拒否されます。', action: '停止理由を確認し、復旧条件が揃った後に管理者が再開します。', href: '/admin/settings' });
    if (!settings.emailNotificationsEnabled) issues.push({ code: 'EMAIL_PAUSED', severity: 'CRITICAL', title: 'メール通知が停止中', detail: '確認済みメール会員へのレース告知と公開通知は送信されません。', action: 'メール配信基盤とキューを確認してから管理者が再開します。', href: '/admin/settings' });
    if (!settings.lineNotificationsEnabled) issues.push({ code: 'LINE_PAUSED', severity: 'CRITICAL', title: 'LINE通知が停止中', detail: '公開情報はWebへ残りますが、通知キューは処理されません。', action: 'LINE側とキューを確認してから管理者が通知を再開します。', href: '/admin/settings' });
    if (settings.lineNotificationsEnabled && !lineConfigured) issues.push({ code: 'LINE_CONFIGURATION_MISSING', severity: 'CRITICAL', title: 'LINE通知設定が不足', detail: 'Channel ID、secret、access tokenのいずれかが未設定です。', action: '管理者が資格情報を再設定し、外部疎通は別途確認します。', href: '/admin/settings' });
    if (stuck) issues.push({ code: 'DELIVERY_STUCK', severity: 'CRITICAL', title: '送信中の通知が停滞', detail: `5分以上送信中の配送が${stuck}件あります。`, action: 'ワーカー状態を確認します。再起動後は期限切れleaseが自動回収されます。', href: '/admin/notifications' });
    if (failed) issues.push({ code: 'DELIVERY_FAILED', severity: 'WARNING', title: '未解決の通知失敗', detail: `失敗状態の配送が${failed}件あります。`, action: '失敗理由を確認し、原因解消後に理由付きで再送します。', href: '/admin/notifications' });
    if (delayed) issues.push({ code: 'DELIVERY_DELAYED', severity: 'WARNING', title: '通知開始が60秒を超過', detail: `初回処理待ちの配送が${delayed}件あります。`, action: 'ワーカー稼働と通知停止設定を確認します。', href: '/admin/notifications' });
    if (!settings.csvImportEnabled) issues.push({ code: 'CSV_PAUSED', severity: 'WARNING', title: 'CSV取込が停止中', detail: '新しい差分確認と取込確定が拒否されます。', action: '取込元と停止理由を確認し、必要な場合だけ管理者が再開します。', href: '/admin/settings' });
    if (unmatchedWebhooks) issues.push({ code: 'WEBHOOK_UNMATCHED', severity: 'WARNING', title: '未照合のLINE Webhook', detail: `24時間以内に会員と照合できないWebhookが${unmatchedWebhooks}件あります。`, action: 'Webhook受信履歴とLINE連携状態を確認します。', href: '/admin/notifications' });
    if (settings.maintenanceMessage.trim()) issues.push({ code: 'MAINTENANCE_MESSAGE_ACTIVE', severity: 'INFO', title: 'メンテナンス案内を設定中', detail: settings.maintenanceMessage, action: '案内内容と現在の障害状態が一致しているか確認します。', href: '/admin/settings' });
    const critical = issues.filter(issue => issue.severity === 'CRITICAL').length; const warning = issues.filter(issue => issue.severity === 'WARNING').length;
    const status = critical ? 'INCIDENT' : warning ? 'DEGRADED' : 'NORMAL';
    const publicMessage = !settings.predictionPublicationEnabled ? '現在、予想情報の公開準備を確認しています。公開が通常より遅れる可能性があります。状況が確定次第、Web会員ページでご案内します。' : !settings.emailNotificationsEnabled || !settings.lineNotificationsEnabled || !lineConfigured || stuck || failed || delayed ? '現在、通知の配信に遅れが発生しています。公開済みの情報はWeb会員ページでご確認いただけます。復旧後に改めてご案内します。' : '現在、確認されている公開・通知障害はありません。';
    return { generatedAt: now, status, counts: { critical, warning, total: issues.length }, issues, publicMessage, monitoring: { failedDeliveries: failed, delayedDeliveries: delayed, stuckDeliveries: stuck, unmatchedWebhooks24h: unmatchedWebhooks, lastWebhookAt: lastWebhook?.receivedAt ?? null, lastWebhookOutcome: lastWebhook?.outcome ?? null, settingsUpdatedAt: settings.updatedAt, newPurchasesEnabled: settings.newPurchasesEnabled } };
  }
  @Get('admin/backups/status') async backupStatus(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    return readLocalBackupStatus();
  }
  @Get('admin/readiness') async readiness(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN']);
    const launchMode = resolveLaunchMode(process.env.LAUNCH_MODE);
    const capabilities = launchCapabilities(launchMode);
    const [settings, backup, appliedMigrations, stripeConfig, databaseAccessRestricted] = await Promise.all([
      this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { newRegistrationsEnabled: true, emailNotificationsEnabled: true, predictionPublicationEnabled: true, csvImportEnabled: true, lineNotificationsEnabled: true, lineLoginEnabled: true, newPurchasesEnabled: true, lineChannelId: true, lineChannelSecretEncrypted: true, lineAccessTokenEncrypted: true, lineLoginChannelId: true, lineLoginChannelSecretEncrypted: true, lineLoginCallbackUrl: true, updatedAt: true } }),
      readLocalBackupStatus(),
      this.auth.db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`.then(rows => rows[0]?.count ?? 0),
      loadStripeConfig(this.auth.db),
      databaseRuntimeAccessRestricted(this.auth.db)
    ]);
    type Check = { code: string; group: 'APPLICATION' | 'CONNECTIONS' | 'LEGAL_DATA' | 'OPERATIONS'; status: 'READY' | 'BLOCKED' | 'MANUAL'; title: string; evidence: string; action: string; href?: string };
    const checks: Check[] = [];
    const add = (check: Check) => checks.push(check);
    const baseUrl = process.env.APP_BASE_URL ?? '';
    const authConfigured = process.env.AUTH_PROVIDER === 'supabase' && !!process.env.SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY;
    add({ code: 'PRODUCTION_AUTH', group: 'APPLICATION', status: authConfigured ? 'MANUAL' : 'BLOCKED', title: '本番認証', evidence: authConfigured ? 'Supabase PKCE登録、ログイン、Cookie更新、JWT検証、初回管理者CLI、TOTP MFAの実装があります。実環境でのメール到達と一連の操作は未確認です。' : '現在はローカル認証、またはSupabase設定が不足しています。', action: 'Supabaseの許可Redirect URLとSMTPを設定し、登録・メール確認・ログイン・セッション更新・ログアウト・AAL2を実環境で確認します。' });
    add({ code: 'HTTPS_BASE_URL', group: 'APPLICATION', status: /^https:\/\//.test(baseUrl) ? 'READY' : 'BLOCKED', title: '公開URLとHTTPS', evidence: /^https:\/\//.test(baseUrl) ? 'APP_BASE_URLはHTTPSです。' : 'APP_BASE_URLは公開用HTTPSではありません。', action: '公開ドメインとHTTPSを設定し、Origin制御を確認します。' });
    const messagingConfigured = capabilities.lineNotifications && process.env.NOTIFICATION_TRANSPORT === 'line' && !!settings.lineChannelId && !!settings.lineChannelSecretEncrypted && !!settings.lineAccessTokenEncrypted;
    add({ code: 'LINE_MESSAGING', group: 'CONNECTIONS', status: !capabilities.lineNotifications || messagingConfigured ? 'READY' : 'BLOCKED', title: 'LINE Messaging API', evidence: !capabilities.lineNotifications ? '無料会員募集モードでは対象外です。' : messagingConfigured ? '本番transportと必要な資格情報が設定済みです。' : '本番transportまたは必要な資格情報が未設定です。', action: capabilities.lineNotifications ? '管理設定を保存し、実アカウントへの送信リハーサルを行います。' : 'FULLへ切り替える前にLINE設定と送信リハーサルを完了します。', href: '/admin/settings' });
    const loginConfigured = capabilities.lineLogin && process.env.LINE_OAUTH_TRANSPORT === 'line' && !!settings.lineLoginChannelId && !!settings.lineLoginChannelSecretEncrypted && !!settings.lineLoginCallbackUrl && /^https:\/\//.test(settings.lineLoginCallbackUrl);
    add({ code: 'LINE_LOGIN', group: 'CONNECTIONS', status: !capabilities.lineLogin || loginConfigured ? 'READY' : 'BLOCKED', title: 'LINE Login', evidence: !capabilities.lineLogin ? '無料会員募集モードでは対象外です。' : loginConfigured ? '本番transportとHTTPS Callbackが設定済みです。' : '本番transport、資格情報、HTTPS Callbackのいずれかが不足しています。', action: capabilities.lineLogin ? 'LINE DevelopersのCallback URLと管理設定を一致させます。' : 'FULLへ切り替える前にLINE Loginの実アカウント試験を完了します。', href: '/admin/settings' });
    const mailConfigured = process.env.MAIL_TRANSPORT === 'resend' && !!process.env.RESEND_API_KEY && !!process.env.MAIL_FROM;
    add({ code: 'TRANSACTIONAL_MAIL', group: 'CONNECTIONS', status: mailConfigured ? 'READY' : 'BLOCKED', title: '確認・再設定メール', evidence: mailConfigured ? '外部メールtransportと送信元が設定済みです。' : '現在はテスト配信、または外部メール設定が不足しています。', action: '送信ドメインを認証し、登録・再設定メールを実送信で確認します。' });
    const stripeConfigured = capabilities.billing && process.env.BILLING_TRANSPORT === 'stripe' && stripeConfig.usable;
    add({ code: 'EXTERNAL_BILLING', group: 'CONNECTIONS', status: !capabilities.billing ? 'READY' : stripeConfigured ? 'MANUAL' : 'BLOCKED', title: '外部決済', evidence: !capabilities.billing ? '無料会員募集モードでは購入機能を停止しています。' : stripeConfigured ? `Stripe Checkoutと署名付きWebhookの設定があります（設定元: ${stripeConfig.source === 'ADMIN' ? '管理画面' : '環境変数'}）。ライブ疎通は人による確認が必要です。` : '現在はローカル決済試験、またはStripe設定が不足・不整合です。', action: !capabilities.billing ? 'FULLへ切り替える前に本番決済リハーサルを完了します。' : stripeConfigured ? 'テスト環境で決済成功・重複Webhook・金額不一致を確認します。' : '管理画面でStripe資格情報、動作モード、3プランのPrice IDを設定します。', href: '/admin/settings' });
    const legalReady = legalDocumentReleaseErrors().length === 0;
    add({ code: 'LEGAL_DOCUMENTS', group: 'LEGAL_DATA', status: legalReady ? 'READY' : 'BLOCKED', title: '利用規約・プライバシー', evidence: legalReady ? '正式版の文書バージョンを使用しています。' : `同意文書は開発版（${consentVersions.terms} / ${consentVersions.privacy}）です。`, action: '正式文書を確定し、バージョンを更新して同意を取得します。' });
    add({ code: 'DATA_RETENTION', group: 'LEGAL_DATA', status: 'BLOCKED', title: '個人情報の保持・匿名化', evidence: '退会処理はdevelopment-v1方針で履歴を保持しています。', action: '保持期間、匿名化範囲、開示・削除請求、再登録の扱いを確定します。', href: '/admin/account-closures' });
    add({ code: 'DATABASE_LEAST_PRIVILEGE', group: 'LEGAL_DATA', status: databaseAccessRestricted ? 'READY' : 'BLOCKED', title: 'DB実行権限の分離', evidence: databaseAccessRestricted ? 'API接続はCRUD限定で、所有権、DDL、TRUNCATE、トリガー操作権限を持ちません。' : '現在のAPI接続は所有者または必要以上のDB権限を持っています。', action: '`pnpm db:access:configure` でruntimeロールを構成し、APIとworkerにruntime接続だけを設定します。' });
    const backupFresh = backup.status === 'VERIFIED' && backup.migrations === appliedMigrations && Date.now() - new Date(backup.verifiedAt).getTime() <= 7 * 86400000;
    add({ code: 'LOCAL_RESTORE_TEST', group: 'OPERATIONS', status: backupFresh ? 'READY' : 'BLOCKED', title: 'ローカル復元試験', evidence: backupFresh ? `${backup.migrations}件のマイグレーションを含む隔離復元を7日以内に確認済みです。` : '現在のDB構成について、7日以内の正常な隔離復元結果がありません。', action: '開発端末で復元検証を実行します。', href: '/admin/backups' });
    add({ code: 'PRODUCTION_BACKUP', group: 'OPERATIONS', status: 'MANUAL', title: '本番バックアップ運用', evidence: '暗号化、別拠点保管、保持世代、RPO/RTOは未確認です。', action: 'DB基盤のバックアップ設定と定期復元試験の責任者を確認します。', href: '/admin/backups' });
    const monitoringReady = !!process.env.SENTRY_DSN;
    add({ code: 'EXTERNAL_MONITORING', group: 'OPERATIONS', status: monitoringReady ? 'MANUAL' : 'BLOCKED', title: '外部監視・連絡', evidence: monitoringReady ? '監視先の設定があります。通知先と発報を人が確認する必要があります。' : '外部監視先が未設定です。', action: '死活・エラー・通知遅延の監視と連絡先を設定し、発報試験を行います。', href: '/admin/incidents' });
    const unsafePurchases = capabilities.billing && settings.newPurchasesEnabled && !stripeConfigured;
    add({ code: 'SAFE_FEATURE_FLAGS', group: 'OPERATIONS', status: unsafePurchases ? 'BLOCKED' : 'READY', title: '公開前の機能状態', evidence: unsafePurchases ? '外部決済未接続のまま新規購入が有効です。' : `公開モード ${launchMode}、新規登録 ${settings.newRegistrationsEnabled ? '有効' : '停止'}、メール通知 ${settings.emailNotificationsEnabled ? '有効' : '停止'}、予想公開 ${settings.predictionPublicationEnabled ? '有効' : '停止'}、CSV ${settings.csvImportEnabled ? '有効' : '停止'}、新規購入 ${capabilities.billing && settings.newPurchasesEnabled ? '有効' : '停止'}です。`, action: unsafePurchases ? '新規購入を停止します。' : '公開当日に緊急停止と復旧手順を再確認します。', href: '/admin/settings' });
    const counts = { ready: checks.filter(item => item.status === 'READY').length, blocked: checks.filter(item => item.status === 'BLOCKED').length, manual: checks.filter(item => item.status === 'MANUAL').length, total: checks.length };
    return { generatedAt: new Date(), status: counts.blocked ? 'NOT_READY' : counts.manual ? 'MANUAL_REVIEW' : 'READY_FOR_REVIEW', counts, checks, nextActions: checks.filter(item => item.status !== 'READY').map(item => item.code), settingsUpdatedAt: settings.updatedAt, declaration: 'この自動判定だけで本番公開を承認しません。' };
  }
  @Get('admin/account-closures') async accountClosures(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']);
    const { page, limit } = pagination.parse(query);
    const [items, total] = await this.auth.db.$transaction([
      this.auth.db.accountClosure.findMany({ include: { user: { select: { id: true, displayName: true, email: true, registrationMethod: true, disabledAt: true } } }, orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
      this.auth.db.accountClosure.count()
    ]);
    return { items: items.map(item => ({ id: item.id, reasonCode: item.reasonCode, requestedAt: item.requestedAt, accessRevokedAt: item.accessRevokedAt, retentionPolicyVersion: item.retentionPolicyVersion, status: item.user.disabledAt ? 'CLOSED' : 'REVIEW_REQUIRED', user: item.user })), total, page, limit };
  }
  @Get('admin/users') async users(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']);
    const { page, limit } = pagination.parse(query);
    const [items, total] = await this.auth.db.$transaction([
      this.auth.db.user.findMany({ select: { id: true, email: true, emailVerifiedAt: true, registrationMethod: true, lineAccount: { select: { unlinkedAt: true } }, displayName: true, role: true, createdAt: true }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }), this.auth.db.user.count()
    ]);
    return { items, total, page, limit };
  }
  @Get('admin/audit') async audit(@Req() req: AppRequest, @Query() query: unknown) {
    await this.staff(req, ['ADMIN']);
    const { page, limit } = pagination.parse(query);
    const [items, total] = await this.auth.db.$transaction([
      this.auth.db.auditLog.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }), this.auth.db.auditLog.count()
    ]);
    return { items, total, page, limit };
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
  private async memberFunnel(since?: Date) {
    const base: Prisma.UserWhereInput = { role: 'MEMBER', ...(since ? { createdAt: { gte: since } } : {}) };
    const count = (extra: Prisma.UserWhereInput = {}) => this.auth.db.user.count({ where: { AND: [base, extra] } });
    const [registered, identityReady, lineReady, planViewed, checkoutReviewed, paid] = await Promise.all([
      count(),
      count({ OR: [{ emailVerifiedAt: { not: null } }, { registrationMethod: 'LINE' }] }),
      count({ lineAccount: { is: { unlinkedAt: null, notificationDisabledAt: null } }, preferences: { is: { predictions: true } } }),
      count({ journeyEvents: { some: { eventType: 'PLAN_VIEWED' } } }),
      count({ journeyEvents: { some: { eventType: 'CHECKOUT_REVIEWED' } } }),
      count({ paymentTransactions: { some: { status: 'SUCCEEDED' } } })
    ]);
    return { registered, identityReady, lineReady, planViewed, checkoutReviewed, paid };
  }
  private async acquisitionBreakdown(since: Date) {
    const rows = await this.auth.db.memberAcquisition.findMany({ where: { capturedAt: { gte: since } }, select: { source: true, medium: true, campaign: true, user: { select: { paymentTransactions: { where: { status: 'SUCCEEDED' }, select: { id: true }, take: 1 } } } } });
    const groups = new Map<string, { source: string; medium: string | null; campaign: string | null; registered: number; paid: number }>();
    for (const row of rows) {
      const key = JSON.stringify([row.source, row.medium, row.campaign]);
      const item = groups.get(key) ?? { source: row.source, medium: row.medium, campaign: row.campaign, registered: 0, paid: 0 };
      item.registered++; if (row.user.paymentTransactions.length) item.paid++; groups.set(key, item);
    }
    return [...groups.values()].sort((a, b) => b.registered - a.registered || b.paid - a.paid || a.source.localeCompare(b.source));
  }
  private campaignUrl(campaign: { code: string; source: string; medium: string; content: string | null; landingPath: string; referralCode: string | null }) {
    const url = new URL(campaign.landingPath, process.env.APP_BASE_URL); url.searchParams.set('utm_source', campaign.source); url.searchParams.set('utm_medium', campaign.medium); url.searchParams.set('utm_campaign', campaign.code);
    if (campaign.content) url.searchParams.set('utm_content', campaign.content); if (campaign.referralCode) url.searchParams.set('ref', campaign.referralCode); return url.toString();
  }
}
