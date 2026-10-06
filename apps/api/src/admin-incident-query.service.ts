import { Inject, Injectable } from '@nestjs/common';
import {
  adminIncidentResponseSchema,
  launchCapabilities,
  resolveLaunchMode,
} from '@keiba/domain';
import type { AdminIncidentResponse } from '@keiba/domain';
import { resolveMailConfig } from '@keiba/db';
import { DbService } from './db.service';
import { lineNotificationState } from './line-notification-policy';

type IncidentIssue = {
  code: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  title: string;
  detail: string;
  action: string;
  href: string;
};

@Injectable()
export class AdminIncidentQueryService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async get(
    now = new Date(),
    environment: NodeJS.ProcessEnv = process.env,
  ): Promise<AdminIncidentResponse> {
    const delayedAt = new Date(now.getTime() - 60_000);
    const staleLeaseAt = new Date(now.getTime() - 5 * 60_000);
    const since = new Date(now.getTime() - 24 * 60 * 60_000);
    const [settings, failed, delayed, stuck, lastWebhook, unmatchedWebhooks, emailFailures, emailProviderFailures] = await this.db.$transaction([
      this.db.systemSetting.findUniqueOrThrow({
        where: { id: 'global' },
        select: {
          emailNotificationsEnabled: true,
          predictionPublicationEnabled: true,
          csvImportEnabled: true,
          lineNotificationsEnabled: true,
          newPurchasesEnabled: true,
          maintenanceMessage: true,
          lineChannelId: true,
          lineChannelSecretEncrypted: true,
          lineAccessTokenEncrypted: true,
          mailApiKeyEncrypted: true,
          mailWebhookSecretEncrypted: true,
          mailFrom: true,
          updatedAt: true,
        },
      }),
      this.db.notificationDelivery.count({ where: { status: 'FAILED' } }),
      this.db.notificationDelivery.count({
        where: {
          status: 'QUEUED',
          attemptCount: 0,
          createdAt: { lt: delayedAt },
          nextAttemptAt: { lte: now },
        },
      }),
      this.db.notificationDelivery.count({
        where: { status: 'SENDING', lockedAt: { lt: staleLeaseAt } },
      }),
      this.db.lineWebhookEvent.findFirst({
        orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
        select: { receivedAt: true, eventType: true, outcome: true },
      }),
      this.db.lineWebhookEvent.count({ where: { receivedAt: { gte: since }, outcome: 'UNMATCHED' } }),
      this.db.emailWebhookEvent.count({
        where: {
          receivedAt: { gte: since },
          eventType: { in: ['email.bounced', 'email.complained', 'email.suppressed'] },
        },
      }),
      this.db.emailWebhookEvent.count({
        where: { receivedAt: { gte: since }, eventType: 'email.failed' },
      }),
    ]);
    const lineConfigured = ['line', 'test'].includes(environment.NOTIFICATION_TRANSPORT ?? '')
      && !!settings.lineChannelId
      && !!settings.lineChannelSecretEncrypted
      && !!settings.lineAccessTokenEncrypted;
    const lineState = lineNotificationState({
      available: launchCapabilities(resolveLaunchMode(environment.LAUNCH_MODE)).lineNotifications,
      enabled: settings.lineNotificationsEnabled,
      configured: lineConfigured,
    });
    const mailConfigured = resolveMailConfig(settings, environment).complete;
    const issues: IncidentIssue[] = [];
    if (!settings.predictionPublicationEnabled) issues.push({ code: 'PREDICTION_PAUSED', severity: 'CRITICAL', title: '予想公開が停止中', detail: '新しいプレビュー確認と公開確定が拒否されます。', action: '停止理由を確認し、復旧条件が揃った後に管理者が再開します。', href: '/admin/settings' });
    if (!settings.emailNotificationsEnabled) issues.push({ code: 'EMAIL_PAUSED', severity: 'CRITICAL', title: 'メール通知が停止中', detail: '確認済みメール会員へのレース告知と公開通知は送信されません。', action: 'メール配信基盤とキューを確認してから管理者が再開します。', href: '/admin/settings' });
    if (settings.emailNotificationsEnabled && environment.MAIL_TRANSPORT === 'resend' && !mailConfigured) issues.push({ code: 'EMAIL_CONFIGURATION_MISSING', severity: 'CRITICAL', title: 'メール送信設定が不足', detail: 'Resend API key、送信元、Webhook signing secretのいずれかが未設定・読取不能です。', action: '管理者が資格情報を再設定し、外部疎通は別途確認します。', href: '/admin/settings' });
    if (lineState.paused) issues.push({ code: 'LINE_PAUSED', severity: 'CRITICAL', title: 'LINE通知が停止中', detail: '公開情報はWebへ残りますが、通知キューは処理されません。', action: 'LINE側とキューを確認してから管理者が通知を再開します。', href: '/admin/settings' });
    if (lineState.configurationMissing) issues.push({ code: 'LINE_CONFIGURATION_MISSING', severity: 'CRITICAL', title: 'LINE通知設定が不足', detail: 'Channel ID、secret、access tokenのいずれかが未設定です。', action: '管理者が資格情報を再設定し、外部疎通は別途確認します。', href: '/admin/settings' });
    if (stuck) issues.push({ code: 'DELIVERY_STUCK', severity: 'CRITICAL', title: '送信中の通知が停滞', detail: `5分以上送信中の配送が${stuck}件あります。`, action: 'ワーカー状態を確認します。再起動後は期限切れleaseが自動回収されます。', href: '/admin/notifications' });
    if (failed) issues.push({ code: 'DELIVERY_FAILED', severity: 'WARNING', title: '未解決の通知失敗', detail: `失敗状態の配送が${failed}件あります。`, action: '失敗理由を確認し、原因解消後に理由付きで再送します。', href: '/admin/notifications' });
    if (delayed) issues.push({ code: 'DELIVERY_DELAYED', severity: 'WARNING', title: '通知開始が60秒を超過', detail: `初回処理待ちの配送が${delayed}件あります。`, action: 'ワーカー稼働と通知停止設定を確認します。', href: '/admin/notifications' });
    if (!settings.csvImportEnabled) issues.push({ code: 'CSV_PAUSED', severity: 'WARNING', title: 'CSV取込が停止中', detail: '新しい差分確認と取込確定が拒否されます。', action: '取込元と停止理由を確認し、必要な場合だけ管理者が再開します。', href: '/admin/settings' });
    if (unmatchedWebhooks) issues.push({ code: 'WEBHOOK_UNMATCHED', severity: 'WARNING', title: '未照合のLINE Webhook', detail: `24時間以内に会員と照合できないWebhookが${unmatchedWebhooks}件あります。`, action: 'Webhook受信履歴とLINE連携状態を確認します。', href: '/admin/notifications' });
    if (emailFailures) issues.push({ code: 'EMAIL_RECIPIENT_REJECTED', severity: 'WARNING', title: 'メール受信拒否を検出', detail: `24時間以内にバウンス・苦情・配信抑止を${emailFailures}件受信しました。`, action: '停止された会員とイベント履歴を確認します。', href: '/admin/notifications' });
    if (emailProviderFailures) issues.push({ code: 'EMAIL_PROVIDER_FAILURE', severity: 'CRITICAL', title: 'メール配信基盤の失敗', detail: `24時間以内にResendの配信失敗を${emailProviderFailures}件受信しました。`, action: 'Resendのドメイン、API key、利用上限、障害情報を確認します。', href: '/admin/notifications' });
    if (settings.maintenanceMessage.trim()) issues.push({ code: 'MAINTENANCE_MESSAGE_ACTIVE', severity: 'INFO', title: 'メンテナンス案内を設定中', detail: settings.maintenanceMessage, action: '案内内容と現在の障害状態が一致しているか確認します。', href: '/admin/settings' });
    const critical = issues.filter(issue => issue.severity === 'CRITICAL').length;
    const warning = issues.filter(issue => issue.severity === 'WARNING').length;
    const status = critical ? 'INCIDENT' : warning ? 'DEGRADED' : 'NORMAL';
    const publicMessage = !settings.predictionPublicationEnabled
      ? '現在、予想情報の公開準備を確認しています。公開が通常より遅れる可能性があります。状況が確定次第、Web会員ページでご案内します。'
      : !settings.emailNotificationsEnabled || lineState.affectsPublicMessage || stuck || failed || delayed || emailProviderFailures
        ? '現在、通知の配信に遅れが発生しています。公開済みの情報はWeb会員ページでご確認いただけます。復旧後に改めてご案内します。'
        : '現在、確認されている公開・通知障害はありません。';

    return adminIncidentResponseSchema.parse({
      generatedAt: now,
      status,
      counts: { critical, warning, total: issues.length },
      issues,
      publicMessage,
      monitoring: {
        failedDeliveries: failed,
        delayedDeliveries: delayed,
        stuckDeliveries: stuck,
        unmatchedWebhooks24h: unmatchedWebhooks,
        emailRecipientFailures24h: emailFailures,
        emailProviderFailures24h: emailProviderFailures,
        lastWebhookAt: lastWebhook?.receivedAt ?? null,
        lastWebhookOutcome: lastWebhook?.outcome ?? null,
        settingsUpdatedAt: settings.updatedAt,
        newPurchasesEnabled: settings.newPurchasesEnabled,
      },
    });
  }
}
