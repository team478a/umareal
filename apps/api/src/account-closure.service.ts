import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';

export type AccountClosureReason = 'SERVICE_NO_LONGER_NEEDED' | 'PRICE' | 'CONTENT' | 'OTHER';

const retentionPolicyVersion = 'development-v1';
const retainedHistory = ['公開・評価履歴との関係', '支払・契約履歴', '同意履歴', '監査履歴'];

@Injectable()
export class AccountClosureService {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

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
    return { eligible: blockers.length === 0, passwordRequired, blockers, retentionPolicyVersion, retained: retainedHistory };
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
      const closure = await tx.accountClosure.create({ data: { userId, reasonCode, requestedAt: now, accessRevokedAt: now, retentionPolicyVersion } });
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
}
