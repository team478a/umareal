import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@keiba/db';
import { adminAccountClosuresResponseSchema, adminAccountRestoreResponseSchema, adminRetentionPolicySchema, type AdminAccountClosuresResponse, type AdminAccountRestoreInput, type AdminAccountRestoreResponse, type AdminRetentionPolicy, type AdminRetentionPolicyInput } from '@keiba/domain';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { hashToken } from './security';

export type AccountClosureReason = 'SERVICE_NO_LONGER_NEEDED' | 'PRICE' | 'CONTENT' | 'OTHER';

const retentionPolicyVersion = 'development-v1';
const retainedHistory = ['公開・評価履歴との関係', '支払・契約履歴', '同意履歴', '監査履歴'];
const retentionPolicyAudit = { action: 'DATA_RETENTION_POLICY_APPROVED', targetType: 'DATA_RETENTION_POLICY' } as const;

@Injectable()
export class AccountClosureService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async list(page: number, limit: number): Promise<AdminAccountClosuresResponse> {
    const [items, total] = await this.auth.db.$transaction([
      this.auth.db.accountClosure.findMany({
        select: {
          id: true,
          reasonCode: true,
          requestedAt: true,
          accessRevokedAt: true,
          retentionPolicyVersion: true,
          user: {
            select: {
              id: true,
              displayName: true,
              email: true,
              registrationMethod: true,
              disabledAt: true,
            },
          },
        },
        orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.auth.db.accountClosure.count(),
    ]);

    return adminAccountClosuresResponseSchema.parse({
      items: items.map(item => ({
        ...item,
        status: item.user.disabledAt ? 'CLOSED' : 'RESTORED',
      })),
      total,
      page,
      limit,
    });
  }

  private async approvedPolicies(client: Prisma.TransactionClient | AuthService['db'] = this.auth.db): Promise<AdminRetentionPolicy[]> {
    const records = await client.auditLog.findMany({ where: retentionPolicyAudit, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const policies: AdminRetentionPolicy[] = [];
    const versions = new Set<string>();
    for (const record of records) {
      const parsed = adminRetentionPolicySchema.safeParse(record.details);
      if (parsed.success && !versions.has(parsed.data.version)) { policies.push(parsed.data); versions.add(parsed.data.version); }
    }
    return policies;
  }

  private async currentPolicy(client: Prisma.TransactionClient | AuthService['db'] = this.auth.db): Promise<AdminRetentionPolicy | null> {
    return (await this.approvedPolicies(client))[0] ?? null;
  }

  async retentionPolicyStatus() {
    const policies = await this.approvedPolicies();
    const current = policies[0] ?? null;
    const approvedVersions = policies.map(policy => policy.version);
    const unmappedClosures = await this.auth.db.accountClosure.count({ where: approvedVersions.length ? { retentionPolicyVersion: { notIn: approvedVersions } } : {} });
    if (!current) return { current: null, dryRun: null, unmappedClosures, executionEnabled: false as const };
    const cutoffAt = new Date(Date.now() - current.identityRetentionDays * 86400000);
    const [eligibleClosures, oldest] = await Promise.all([
      this.auth.db.accountClosure.count({ where: { retentionPolicyVersion: current.version, accessRevokedAt: { lte: cutoffAt } } }),
      this.auth.db.accountClosure.findFirst({ where: { retentionPolicyVersion: current.version, accessRevokedAt: { lte: cutoffAt } }, orderBy: [{ accessRevokedAt: 'asc' }, { id: 'asc' }], select: { accessRevokedAt: true } })
    ]);
    return { current, dryRun: { eligibleClosures, cutoffAt, oldestClosureAt: oldest?.accessRevokedAt ?? null }, unmappedClosures, executionEnabled: false as const };
  }

  async retentionPreview(page: number, limit: number, now = new Date()) {
    const [policies, closures, total] = await Promise.all([
      this.approvedPolicies(),
      this.auth.db.accountClosure.findMany({
        include: { user: { select: { id: true, displayName: true, email: true, registrationMethod: true } } },
        orderBy: [{ accessRevokedAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit
      }),
      this.auth.db.accountClosure.count()
    ]);
    const byVersion = new Map(policies.map(policy => [policy.version, policy]));
    return {
      generatedAt: now,
      items: closures.map(closure => {
        const policy = byVersion.get(closure.retentionPolicyVersion);
        if (!policy) return {
          closureId: closure.id, policyVersion: closure.retentionPolicyVersion, status: 'POLICY_UNMAPPED' as const,
          accessRevokedAt: closure.accessRevokedAt, eligibleAt: null, daysRemaining: null, anonymizationScope: [],
          preservedRecords: retainedHistory, externalActionsRequired: [], user: closure.user
        };
        const eligibleAt = new Date(closure.accessRevokedAt.getTime() + policy.identityRetentionDays * 86400000);
        const eligible = eligibleAt <= now;
        return {
          closureId: closure.id, policyVersion: policy.version, status: eligible ? 'ELIGIBLE' as const : 'NOT_DUE' as const,
          accessRevokedAt: closure.accessRevokedAt, eligibleAt, daysRemaining: eligible ? 0 : Math.ceil((eligibleAt.getTime() - now.getTime()) / 86400000),
          anonymizationScope: policy.anonymizationScope, preservedRecords: retainedHistory,
          externalActionsRequired: [
            ...(policy.anonymizationScope.includes('AUTH_IDENTITY') ? ['SUPABASE_AUTH_REVIEW' as const] : []),
            ...(policy.anonymizationScope.includes('LINE_IDENTITY') ? ['LINE_PROVIDER_REVIEW' as const] : [])
          ],
          user: closure.user
        };
      }),
      total, page, limit, automaticExecution: false as const
    };
  }

  async approveRetentionPolicy(input: AdminRetentionPolicyInput, actor: { id: string; user: { displayName: string } }, req: AppRequest) {
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('data-retention-policy'))::text`;
      const duplicate = await tx.auditLog.findFirst({ where: { ...retentionPolicyAudit, targetId: input.version }, select: { id: true } });
      if (duplicate) throw new ConflictException({ code: 'RETENTION_POLICY_VERSION_EXISTS', message: '同じ保持方針versionは既に記録されています。' });
      const approvedAt = new Date();
      const current = adminRetentionPolicySchema.parse({
        version: input.version,
        identityRetentionDays: input.identityRetentionDays,
        networkIdentifierRetentionDays: input.networkIdentifierRetentionDays,
        anonymizationScope: input.anonymizationScope,
        reRegistrationHandling: input.reRegistrationHandling,
        dataRequestHandling: input.dataRequestHandling,
        legalReviewReference: input.legalReviewReference,
        approvedAt,
        approvedBy: { id: actor.id, displayName: actor.user.displayName }
      });
      await this.auth.audit(tx, req, retentionPolicyAudit.action, input.version, input.reason, current, retentionPolicyAudit.targetType);
      return current;
    });
  }

  async eligibility(userId: string, passwordRequired: boolean) {
    const now = new Date();
    const [subscription, dayPass, checkout] = await Promise.all([
      this.auth.db.subscription.findFirst({
        where: { userId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] }, currentPeriodEndsAt: { gt: now } },
        select: { id: true, currentPeriodEndsAt: true, cancelAtPeriodEnd: true },
      }),
      this.auth.db.dayPass.findFirst({
        where: { userId, status: { in: ['PENDING', 'ACTIVE'] }, endsAt: { gt: now } },
        select: { id: true, endsAt: true },
      }),
      this.auth.db.billingCheckout.findFirst({
        where: { userId, status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: now } },
        select: { id: true, expiresAt: true },
      }),
    ]);
    const blockers = [
      ...(subscription ? [{
        code: 'ACTIVE_SUBSCRIPTION',
        message: subscription.cancelAtPeriodEnd ? '解約予約済みの月額契約は利用期間終了後に退会できます。' : '有効な月額契約を先に解約予約してください。',
        href: '/account',
        endsAt: subscription.currentPeriodEndsAt,
      }] : []),
      ...(dayPass ? [{ code: 'ACTIVE_DAY_PASS', message: '有効な1日利用の終了後に退会できます。', href: '/account', endsAt: dayPass.endsAt }] : []),
      ...(checkout ? [{ code: 'PENDING_CHECKOUT', message: '進行中の決済を完了または取消し、決済画面の有効期限が切れてから退会してください。', href: '/account', endsAt: checkout.expiresAt }] : []),
    ];
    const policy = await this.currentPolicy();
    return { eligible: blockers.length === 0, passwordRequired, blockers, retentionPolicyVersion: policy?.version ?? retentionPolicyVersion, retained: retainedHistory };
  }

  async close(userId: string, reasonCode: AccountClosureReason, req: AppRequest) {
    const result = await this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-closure:${userId}`}))::text`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))::text`;
      const previous = await tx.accountClosure.findUnique({ where: { userId } });
      if (previous) return { closedAt: previous.accessRevokedAt, alreadyClosed: true };
      const now = new Date();
      const [activeSubscriptions, activeDayPasses, pendingCheckouts] = await Promise.all([
        tx.subscription.count({ where: { userId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] }, currentPeriodEndsAt: { gt: now } } }),
        tx.dayPass.count({ where: { userId, status: { in: ['PENDING', 'ACTIVE'] }, endsAt: { gt: now } } }),
        tx.billingCheckout.count({ where: { userId, status: { in: ['INITIATED', 'OPEN'] }, completedAt: null, expiresAt: { gt: now } } }),
      ]);
      if (activeSubscriptions || activeDayPasses || pendingCheckouts) {
        throw new ConflictException({ code: 'ACTIVE_BILLING_EXISTS', message: '利用期間中または決済中の契約があります。解約、取消し、または有効期間終了後に退会してください。' });
      }
      const policy = await this.currentPolicy(tx);
      const appliedRetentionPolicyVersion = policy?.version ?? retentionPolicyVersion;
      const closure = await tx.accountClosure.create({ data: { userId, reasonCode, requestedAt: now, accessRevokedAt: now, retentionPolicyVersion: appliedRetentionPolicyVersion } });
      await tx.notificationPreference.updateMany({ where: { userId }, data: { predictions: false, changes: false, articles: false, billing: false } });
      await tx.lineAccount.updateMany({ where: { userId }, data: { unlinkedAt: now, notificationDisabledAt: now } });
      await tx.entitlement.updateMany({ where: { userId, revokedAt: null, endsAt: { gt: now } }, data: { revokedAt: now } });
      await tx.emailVerification.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
      await tx.passwordReset.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
      await tx.lineOAuthFlow.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
      await this.auth.audit(tx, req, 'ACCOUNT_CLOSED', userId, '会員本人による退会', { closureId: closure.id, reasonCode, retentionPolicyVersion: closure.retentionPolicyVersion });
      await tx.user.update({ where: { id: userId }, data: { disabledAt: now } });
      await tx.session.deleteMany({ where: { userId } });
      return { closedAt: closure.accessRevokedAt, alreadyClosed: false };
    });
    return { ...result, retainedHistory: true };
  }

  async restore(closureId: string, actorId: string, input: AdminAccountRestoreInput, idempotencyHeader: string, req: AppRequest): Promise<AdminAccountRestoreResponse> {
    const key = `account-restore:${actorId}:${idempotencyHeader}`;
    const requestHash = hashToken(JSON.stringify({ closureId, ...input }));
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`account-restore:${closureId}`}))::text`;
      const previous = await tx.idempotencyKey.findUnique({ where: { key } });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED', message: '同じ操作キーを異なる復旧内容には使用できません。' });
        return adminAccountRestoreResponseSchema.parse(previous.response);
      }
      const closure = await tx.accountClosure.findUnique({
        where: { id: closureId },
        select: { id: true, user: { select: { id: true, displayName: true, role: true, disabledAt: true, lineAccount: { select: { id: true } } } } }
      });
      if (!closure) throw new NotFoundException({ code: 'ACCOUNT_CLOSURE_NOT_FOUND', message: '対象の退会記録を確認できません。' });
      if (closure.user.role !== 'MEMBER') throw new ConflictException({ code: 'ACCOUNT_RESTORE_ROLE_INVALID', message: '一般会員以外はこの画面から復旧できません。' });
      if (!closure.user.disabledAt) throw new ConflictException({ code: 'ACCOUNT_ALREADY_RESTORED', message: 'このアカウントはすでに復旧されています。' });
      if (closure.user.displayName !== input.confirmation) throw new BadRequestException({ code: 'ACCOUNT_RESTORE_CONFIRMATION_MISMATCH', message: '確認用の表示名が一致しません。' });
      if (closure.user.disabledAt.toISOString() !== new Date(input.expectedDisabledAt).toISOString()) throw new ConflictException({ code: 'ACCOUNT_RESTORE_STALE', message: 'アカウント状態が更新されています。再読込して確認してください。' });

      const restoredAt = new Date();
      await tx.user.update({ where: { id: closure.user.id }, data: { disabledAt: null } });
      const lineLoginRestored = closure.user.lineAccount !== null;
      if (lineLoginRestored) await tx.lineAccount.update({ where: { userId: closure.user.id }, data: { unlinkedAt: null } });
      const response = adminAccountRestoreResponseSchema.parse({
        closureId: closure.id,
        restoredAt,
        lineLoginRestored,
        notificationsRemainDisabled: true,
        entitlementsRestored: false,
        referralChanged: false
      });
      await this.auth.audit(tx, req, 'ACCOUNT_RESTORED', closure.user.id, input.reason, {
        closureId: closure.id,
        lineLoginRestored,
        notificationsRemainDisabled: true,
        entitlementsRestored: false,
        referralChanged: false
      }, 'ACCOUNT_CLOSURE');
      await tx.idempotencyKey.create({ data: { key, requestHash, response } });
      return response;
    });
  }
}
