import { Inject, Injectable } from '@nestjs/common';
import { databaseRuntimeAccessRestricted, loadMailConfig } from '@keiba/db';
import { consentVersions, launchCapabilities, legalDocumentReleaseErrors, resolveLaunchMode } from '@keiba/domain';
import type { AdminReadinessCheck } from '@keiba/domain';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DbService } from './db.service';
import { decrypt } from './security';
import { loadStripeConfig } from './stripe-config';

const verifiedBackupSchema = z.object({ status: z.literal('VERIFIED'), verifiedAt: z.string().datetime(), backupId: z.string().regex(/^keiba-physical-\d{14}$/), format: z.literal('postgresql-physical-directory'), postgresMajor: z.literal(16), encrypted: z.literal(false), sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().positive(), fileCount: z.number().int().positive(), migrations: z.number().int().nonnegative(), requiredTriggers: z.number().int().nonnegative(), restoredDatabaseRemoved: z.literal(true), counts: z.object({ users: z.number().int().nonnegative(), races: z.number().int().nonnegative(), predictionVersions: z.number().int().nonnegative(), freeReportVersions: z.number().int().nonnegative(), audioAssets: z.number().int().nonnegative(), publicationSchedules: z.number().int().nonnegative(), memberAcquisitions: z.number().int().nonnegative(), acquisitionCampaigns: z.number().int().nonnegative(), auditLogs: z.number().int().nonnegative(), notificationEvents: z.number().int().nonnegative(), operationalAlerts: z.number().int().nonnegative(), operationalAlertDeliveries: z.number().int().nonnegative(), billingSupportRequests: z.number().int().nonnegative(), billingSupportEvents: z.number().int().nonnegative() }).strict() }).strict();
const failedBackupSchema = z.object({ status: z.literal('FAILED'), attemptedAt: z.string().datetime(), errorCode: z.literal('BACKUP_VERIFY_FAILED'), backupId: z.string().regex(/^keiba-physical-\d{14}$/).nullable(), restoredDatabaseRemoved: z.boolean() }).strict();

@Injectable()
export class ReadinessService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async localBackupStatus() {
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

  async getReadiness() {
    const launchMode = resolveLaunchMode(process.env.LAUNCH_MODE);
    const capabilities = launchCapabilities(launchMode);
    const [settings, backup, appliedMigrations, stripeConfig, mailConfig, databaseAccessRestricted, adminContinuity, alertSetting] = await Promise.all([
      this.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { newRegistrationsEnabled: true, registrationCaptchaEnabled: true, turnstileSiteKey: true, turnstileSecretEncrypted: true, emailNotificationsEnabled: true, predictionPublicationEnabled: true, csvImportEnabled: true, lineNotificationsEnabled: true, lineLoginEnabled: true, newPurchasesEnabled: true, lineChannelId: true, lineChannelSecretEncrypted: true, lineAccessTokenEncrypted: true, lineLoginChannelId: true, lineLoginChannelSecretEncrypted: true, lineLoginCallbackUrl: true, updatedAt: true } }),
      this.localBackupStatus(),
      this.db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`.then(rows => rows[0]?.count ?? 0),
      loadStripeConfig(this.db),
      loadMailConfig(this.db),
      databaseRuntimeAccessRestricted(this.db),
      Promise.all([
        this.db.user.count({ where: { role: 'ADMIN', disabledAt: null } }),
        this.db.user.count({ where: { role: 'ADMIN', disabledAt: null, externalMfaFactorId: { not: null } } }),
        this.db.user.count({ where: { role: 'ADMIN', disabledAt: null, externalBackupMfaFactorId: { not: null } } })
      ]),
      this.db.operationalAlertSetting.findUniqueOrThrow({ where: { id: 'global' } })
    ]);
    const checks: AdminReadinessCheck[] = [];
    const add = (check: AdminReadinessCheck) => checks.push(check);
    const baseUrl = process.env.APP_BASE_URL ?? '';
    const authConfigured = process.env.AUTH_PROVIDER === 'supabase' && !!process.env.SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY;
    add({ code: 'PRODUCTION_AUTH', group: 'APPLICATION', status: authConfigured ? 'MANUAL' : 'BLOCKED', title: '本番認証', evidence: authConfigured ? 'Supabase PKCE登録、ログイン、Cookie更新、JWT検証、初回管理者CLI、TOTP MFAの実装があります。実環境でのメール到達と一連の操作は未確認です。' : '現在はローカル認証、またはSupabase設定が不足しています。', action: 'Supabaseの許可Redirect URLとSMTPを設定し、登録・メール確認・ログイン・セッション更新・ログアウト・AAL2を実環境で確認します。' });
    const [administratorCount, primaryMfaCount, backupMfaCount] = adminContinuity;
    const continuityReady = authConfigured && administratorCount >= 2 && primaryMfaCount >= 2 && backupMfaCount >= 2;
    add({ code: 'ADMIN_CONTINUITY', group: 'APPLICATION', status: continuityReady ? 'READY' : 'BLOCKED', title: '管理者の継続運用', evidence: `有効な管理者 ${administratorCount}名、主認証アプリ ${primaryMfaCount}名、予備認証アプリ ${backupMfaCount}名です。`, action: continuityReady ? '管理者ごとに主・予備の認証端末が利用できることを定期確認します。' : '2名以上の管理者を準備し、それぞれが主・予備の認証アプリを登録します。', href: '/admin/continuity' });
    add({ code: 'HTTPS_BASE_URL', group: 'APPLICATION', status: /^https:\/\//.test(baseUrl) ? 'READY' : 'BLOCKED', title: '公開URLとHTTPS', evidence: /^https:\/\//.test(baseUrl) ? 'APP_BASE_URLはHTTPSです。' : 'APP_BASE_URLは公開用HTTPSではありません。', action: '公開ドメインとHTTPSを設定し、Origin制御を確認します。' });
    let turnstileSecretReadable = false;
    try { turnstileSecretReadable = !!settings.turnstileSecretEncrypted && decrypt(settings.turnstileSecretEncrypted).length > 0; } catch { turnstileSecretReadable = false; }
    const captchaConfigured = settings.registrationCaptchaEnabled && !!settings.turnstileSiteKey && turnstileSecretReadable && process.env.CAPTCHA_TRANSPORT === 'turnstile' && /^https:\/\//.test(baseUrl);
    add({ code: 'REGISTRATION_CAPTCHA', group: 'CONNECTIONS', status: captchaConfigured ? 'MANUAL' : 'BLOCKED', title: '無料登録のBot対策', evidence: captchaConfigured ? 'TurnstileのSite key、復号可能なSecret key、本番transport、HTTPS公開URLが設定済みです。ライブ疎通は人による確認が必要です。' : !settings.registrationCaptchaEnabled ? '無料登録のBot対策が無効です。' : 'Site key、Secret key、本番transport、HTTPS公開URLのいずれかが不足しています。', action: captchaConfigured ? 'Cloudflareへ公開hostnameを登録し、実端末から正常・失敗・期限切れを確認します。' : '管理画面でTurnstile資格情報を保存して有効化します。', href: '/admin/settings' });
    const messagingConfigured = capabilities.lineNotifications && process.env.NOTIFICATION_TRANSPORT === 'line' && !!settings.lineChannelId && !!settings.lineChannelSecretEncrypted && !!settings.lineAccessTokenEncrypted;
    add({ code: 'LINE_MESSAGING', group: 'CONNECTIONS', status: !capabilities.lineNotifications || messagingConfigured ? 'READY' : 'BLOCKED', title: 'LINE Messaging API', evidence: !capabilities.lineNotifications ? '無料会員募集モードでは対象外です。' : messagingConfigured ? '本番transportと必要な資格情報が設定済みです。' : '本番transportまたは必要な資格情報が未設定です。', action: capabilities.lineNotifications ? '管理設定を保存し、実アカウントへの送信リハーサルを行います。' : 'FULLへ切り替える前にLINE設定と送信リハーサルを完了します。', href: '/admin/settings' });
    const loginConfigured = capabilities.lineLogin && process.env.LINE_OAUTH_TRANSPORT === 'line' && !!settings.lineLoginChannelId && !!settings.lineLoginChannelSecretEncrypted && !!settings.lineLoginCallbackUrl && /^https:\/\//.test(settings.lineLoginCallbackUrl);
    add({ code: 'LINE_LOGIN', group: 'CONNECTIONS', status: !capabilities.lineLogin || loginConfigured ? 'READY' : 'BLOCKED', title: 'LINE Login', evidence: !capabilities.lineLogin ? '無料会員募集モードでは対象外です。' : loginConfigured ? '本番transportとHTTPS Callbackが設定済みです。' : '本番transport、資格情報、HTTPS Callbackのいずれかが不足しています。', action: capabilities.lineLogin ? 'LINE DevelopersのCallback URLと管理設定を一致させます。' : 'FULLへ切り替える前にLINE Loginの実アカウント試験を完了します。', href: '/admin/settings' });
    const mailConfigured = process.env.MAIL_TRANSPORT === 'resend' && mailConfig.complete;
    add({ code: 'TRANSACTIONAL_MAIL', group: 'CONNECTIONS', status: mailConfigured ? 'MANUAL' : 'BLOCKED', title: '確認・通知メール', evidence: mailConfigured ? `外部メールtransport、送信元、署名付き配信失敗Webhookが設定済みです（設定元: ${mailConfig.source === 'ADMIN' ? '管理画面' : '環境変数'}）。ライブ疎通は人による確認が必要です。` : '現在はテスト配信、または外部メール・Webhook設定が不足しています。', action: mailConfigured ? '送信ドメインを認証し、登録・再設定・公開通知・バウンス停止を実送信で確認します。' : '管理画面でResend API key、送信元、Webhook signing secretを設定します。', href: '/admin/settings' });
    const stripeConfigured = capabilities.billing && process.env.BILLING_TRANSPORT === 'stripe' && stripeConfig.usable;
    const stripeSandbox = launchMode === 'STRIPE_SANDBOX';
    add({ code: 'EXTERNAL_BILLING', group: 'CONNECTIONS', status: !capabilities.billing ? 'READY' : stripeConfigured ? 'MANUAL' : 'BLOCKED', title: '外部決済', evidence: !capabilities.billing ? '無料会員募集モードでは購入機能を停止しています。' : stripeConfigured ? `Stripe ${stripeSandbox ? 'test mode' : 'live mode'}のCheckoutと署名付きWebhookの設定があります（設定元: ${stripeConfig.source === 'ADMIN' ? '管理画面' : '環境変数'}）。疎通は人による確認が必要です。` : stripeSandbox ? 'Stripeテスト資格情報、テストWebhook、またはテストPrice IDが不足・不整合です。' : '現在はローカル決済試験、またはStripe設定が不足・不整合です。', action: !capabilities.billing ? 'FULLへ切り替える前に本番決済リハーサルを完了します。' : stripeConfigured ? `${stripeSandbox ? 'Stripeテストカード' : '本番移行前のテスト環境'}で決済成功・重複Webhook・金額不一致を確認します。` : '管理画面でStripe資格情報、動作モード、3プランのPrice IDを設定します。', href: '/admin/settings' });
    const legalReady = legalDocumentReleaseErrors().length === 0;
    add({ code: 'LEGAL_DOCUMENTS', group: 'LEGAL_DATA', status: legalReady ? 'READY' : 'BLOCKED', title: '利用規約・プライバシー', evidence: legalReady ? '正式版の文書バージョンを使用しています。' : `同意文書は開発版（${consentVersions.terms} / ${consentVersions.privacy}）です。`, action: '正式文書を確定し、バージョンを更新して同意を取得します。' });
    add({ code: 'DATA_RETENTION', group: 'LEGAL_DATA', status: 'BLOCKED', title: '個人情報の保持・匿名化', evidence: '退会処理はdevelopment-v1方針で履歴を保持しています。', action: '保持期間、匿名化範囲、開示・削除請求、再登録の扱いを確定します。', href: '/admin/account-closures' });
    add({ code: 'DATABASE_LEAST_PRIVILEGE', group: 'LEGAL_DATA', status: databaseAccessRestricted ? 'READY' : 'BLOCKED', title: 'DB実行権限の分離', evidence: databaseAccessRestricted ? 'API接続はCRUD限定で、所有権、DDL、TRUNCATE、トリガー操作権限を持ちません。' : '現在のAPI接続は所有者または必要以上のDB権限を持っています。', action: '`pnpm db:access:configure` でruntimeロールを構成し、APIとworkerにruntime接続だけを設定します。' });
    const backupFresh = backup.status === 'VERIFIED' && backup.migrations === appliedMigrations && Date.now() - new Date(backup.verifiedAt).getTime() <= 7 * 86400000;
    add({ code: 'LOCAL_RESTORE_TEST', group: 'OPERATIONS', status: backupFresh ? 'READY' : 'BLOCKED', title: 'ローカル復元試験', evidence: backupFresh ? `${backup.migrations}件のマイグレーションを含む隔離復元を7日以内に確認済みです。` : '現在のDB構成について、7日以内の正常な隔離復元結果がありません。', action: '開発端末で復元検証を実行します。', href: '/admin/backups' });
    add({ code: 'PRODUCTION_BACKUP', group: 'OPERATIONS', status: 'MANUAL', title: '本番バックアップ運用', evidence: '暗号化、別拠点保管、保持世代、RPO/RTOは未確認です。', action: 'DB基盤のバックアップ設定と定期復元試験の責任者を確認します。', href: '/admin/backups' });
    const monitoringReady = alertSetting.enabled && alertSetting.destinationEmails.length > 0 && mailConfigured;
    add({ code: 'EXTERNAL_MONITORING', group: 'OPERATIONS', status: monitoringReady ? 'MANUAL' : 'BLOCKED', title: '運用異常の外部通知', evidence: monitoringReady ? `配信・予約公開・公開期限の異常を${alertSetting.destinationEmails.length}件の運営通知先へ送る設定があります。` : '外部アラートが無効、通知先なし、またはメール送信設定が不足しています。', action: monitoringReady ? '重大・警告を1件ずつ発生させ、通知到達と確認・解決記録をリハーサルします。' : '障害対応画面で通知先と最低重大度を設定します。', href: '/admin/incidents' });
    const unsafePurchases = capabilities.billing && settings.newPurchasesEnabled && !stripeConfigured;
    add({ code: 'SAFE_FEATURE_FLAGS', group: 'OPERATIONS', status: unsafePurchases ? 'BLOCKED' : 'READY', title: '公開前の機能状態', evidence: unsafePurchases ? '外部決済未接続のまま新規購入が有効です。' : `公開モード ${launchMode}、新規登録 ${settings.newRegistrationsEnabled ? '有効' : '停止'}、メール通知 ${settings.emailNotificationsEnabled ? '有効' : '停止'}、予想公開 ${settings.predictionPublicationEnabled ? '有効' : '停止'}、CSV ${settings.csvImportEnabled ? '有効' : '停止'}、新規購入 ${capabilities.billing && settings.newPurchasesEnabled ? '有効' : '停止'}です。`, action: unsafePurchases ? '新規購入を停止します。' : '公開当日に緊急停止と復旧手順を再確認します。', href: '/admin/settings' });
    const counts = { ready: checks.filter(item => item.status === 'READY').length, blocked: checks.filter(item => item.status === 'BLOCKED').length, manual: checks.filter(item => item.status === 'MANUAL').length, total: checks.length };
    return { generatedAt: new Date(), status: counts.blocked ? 'NOT_READY' : counts.manual ? 'MANUAL_REVIEW' : 'READY_FOR_REVIEW', counts, checks, nextActions: checks.filter(item => item.status !== 'READY').map(item => item.code), settingsUpdatedAt: settings.updatedAt, declaration: 'この自動判定だけで本番公開を承認しません。' };
  }
}
