import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Patch, Req } from '@nestjs/common';
import { adminSettingsUpdateSchema, canManage, requiresMfa } from '@keiba/domain';
import type { Role } from '@keiba/domain';
import { resolveMailConfig, type SystemSetting } from '@keiba/db';
import { AuthService } from './auth.service';
import type { AppRequest } from './context';
import { decrypt, encrypt } from './security';
import { resolveStripeConfig } from './stripe-config';

@Controller('admin/settings')
export class AdminSettingsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  private async staff(req: AppRequest, roles: Role[]) {
    const actor = await this.auth.authenticate(req);
    if (!canManage(actor, roles)) throw new ForbiddenException({ code: requiresMfa(actor.role) && actor.aal !== 2 ? 'MFA_REQUIRED' : 'FORBIDDEN', message: '管理設定の権限と二段階認証を確認してください。' });
    return actor;
  }

  private view(value: SystemSetting) {
    const mail = resolveMailConfig(value);
    const channelSecretConfigured = !!value.lineChannelSecretEncrypted;
    const channelAccessTokenConfigured = !!value.lineAccessTokenEncrypted;
    const configured = !!value.lineChannelId && channelSecretConfigured && channelAccessTokenConfigured;
    const readable = (encrypted: string | null) => { if (!encrypted) return false; try { return decrypt(encrypted).length > 0; } catch { return false; } };
    const messagingSecretsReadable = readable(value.lineChannelSecretEncrypted) && readable(value.lineAccessTokenEncrypted);
    const turnstileSecretConfigured = !!value.turnstileSecretEncrypted;
    const turnstileSecretReadable = readable(value.turnstileSecretEncrypted);
    const loginSecretReadable = readable(value.lineLoginChannelSecretEncrypted);
    const stripe = resolveStripeConfig(value);
    const stripeAdminSelected = stripe.source === 'ADMIN';
    const stripeSecretKeyConfigured = stripeAdminSelected ? !!value.stripeSecretKeyEncrypted : !!stripe.secretKey;
    const stripeWebhookSecretConfigured = stripeAdminSelected ? !!value.stripeWebhookSecretEncrypted : !!stripe.webhookSecret;
    const stripeSecretsReadable = stripeAdminSelected
      ? readable(value.stripeSecretKeyEncrypted) && readable(value.stripeWebhookSecretEncrypted)
      : !!stripe.secretKey && !!stripe.webhookSecret;
    const stripePricesConfigured = !!stripe.priceFounder && !!stripe.priceStandard && !!stripe.priceDayPass;
    const baseUrl = process.env.APP_BASE_URL ?? '';
    let secureApplicationUrl = false;
    try { const parsed = new URL(baseUrl); secureApplicationUrl = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)); } catch { secureApplicationUrl = false; }
    return {
      revision: value.revision,
      operations: {
        newRegistrationsEnabled: value.newRegistrationsEnabled,
        emailNotificationsEnabled: value.emailNotificationsEnabled,
        predictionPublicationEnabled: value.predictionPublicationEnabled,
        csvImportEnabled: value.csvImportEnabled,
        lineNotificationsEnabled: value.lineNotificationsEnabled,
        lineLoginEnabled: value.lineLoginEnabled,
        newPurchasesEnabled: value.newPurchasesEnabled
      },
      registrationPauseMessage: value.registrationPauseMessage,
      captcha: {
        enabled: value.registrationCaptchaEnabled,
        siteKey: value.turnstileSiteKey,
        secretConfigured: turnstileSecretConfigured,
        connectionStatus: !value.registrationCaptchaEnabled ? 'DISABLED' : value.turnstileSiteKey && turnstileSecretConfigured ? 'CONFIGURED_NOT_VERIFIED' : 'INCOMPLETE',
        readiness: {
          siteKeyStored: !!value.turnstileSiteKey,
          secretStored: turnstileSecretConfigured,
          secretReadable: turnstileSecretReadable,
          serverValidationReady: true,
          transport: process.env.CAPTCHA_TRANSPORT === 'turnstile' ? 'TURNSTILE' : 'TEST_ONLY',
          externalConnectionTested: false
        }
      },
      maintenanceMessage: value.maintenanceMessage,
      notificationPolicy: { maxAttempts: value.notificationMaxAttempts, baseDelaySeconds: value.notificationBaseDelaySeconds },
      publicationPolicy: { correction: value.predictionCorrectionPolicy, delayedRace: value.delayedPublicationPolicy },
      environment: {
        launchMode: process.env.LAUNCH_MODE ?? 'UNSET',
        authProvider: process.env.AUTH_PROVIDER === 'supabase' ? 'SUPABASE' : 'LOCAL_DEVELOPMENT',
        applicationUrl: baseUrl || null,
        adminUrlConfigured: !!process.env.ADMIN_BASE_URL,
        supabaseConfigured: !!process.env.SUPABASE_URL && !!process.env.SUPABASE_ANON_KEY,
        sentryConfigured: !!process.env.SENTRY_DSN,
        transports: {
          captcha: process.env.CAPTCHA_TRANSPORT ?? 'UNSET', mail: process.env.MAIL_TRANSPORT ?? 'UNSET',
          lineNotifications: process.env.NOTIFICATION_TRANSPORT ?? 'UNSET', lineLogin: process.env.LINE_OAUTH_TRANSPORT ?? 'UNSET', billing: process.env.BILLING_TRANSPORT ?? 'UNSET'
        }
      },
      billing: {
        founderSalesEnabled: value.founderSalesEnabled, founderPriceYen: value.founderPriceYen,
        standardPriceYen: value.standardPriceYen, dayPassPriceYen: value.dayPassPriceYen,
        founderSalesLimit: value.founderSalesLimit, billingGraceDays: value.billingGraceDays
      },
      stripe: {
        source: stripe.source, liveMode: stripe.liveMode,
        secretKeyConfigured: stripeSecretKeyConfigured, webhookSecretConfigured: stripeWebhookSecretConfigured,
        priceFounder: value.stripePriceFounder, priceStandard: value.stripePriceStandard, priceDayPass: value.stripePriceDayPass,
        connectionStatus: stripe.usable ? 'CONFIGURED_NOT_VERIFIED' : stripeAdminSelected ? 'INCOMPLETE' : 'NOT_CONFIGURED',
        readiness: { credentialsStored: stripeSecretKeyConfigured && stripeWebhookSecretConfigured, secretsReadable: stripeSecretsReadable, pricesConfigured: stripePricesConfigured, modeConsistent: stripe.modeConsistent && stripe.runtimeModeAllowed, billingTransport: process.env.BILLING_TRANSPORT === 'stripe' ? 'STRIPE' : 'TEST_ONLY', externalConnectionTested: false }
      },
      mail: {
        source: mail.source,
        apiKeyConfigured: mail.apiKeyConfigured,
        webhookSecretConfigured: mail.webhookSecretConfigured,
        from: mail.source === 'ADMIN' ? value.mailFrom : null,
        connectionStatus: mail.complete ? 'CONFIGURED_NOT_VERIFIED' : mail.source === 'ADMIN' ? 'INCOMPLETE' : 'NOT_CONFIGURED',
        readiness: {
          credentialsStored: mail.apiKeyConfigured,
          secretReadable: mail.secretReadable,
          webhookSecretStored: mail.webhookSecretConfigured,
          webhookSecretReadable: mail.webhookSecretReadable,
          senderConfigured: mail.senderConfigured,
          webhookReceiverReady: true,
          mailTransport: process.env.MAIL_TRANSPORT === 'resend' ? 'RESEND' : 'TEST_ONLY',
          externalConnectionTested: false
        }
      },
      line: {
        channelId: value.lineChannelId, channelSecretConfigured, channelAccessTokenConfigured, connectionStatus: configured ? 'CONFIGURED_NOT_VERIFIED' : 'NOT_CONFIGURED',
        messagingReadiness: { credentialsStored: configured, secretsReadable: messagingSecretsReadable, applicationUrlReady: secureApplicationUrl, notificationWorkerReady: true, webhookSignatureVerifierReady: true, outboundTransport: process.env.NOTIFICATION_TRANSPORT === 'line' ? 'LINE' : 'TEST_ONLY', externalConnectionTested: false },
        loginChannelId: value.lineLoginChannelId, loginChannelSecretConfigured: !!value.lineLoginChannelSecretEncrypted, loginCallbackUrl: value.lineLoginCallbackUrl,
        loginConnectionStatus: value.lineLoginChannelId && value.lineLoginChannelSecretEncrypted && value.lineLoginCallbackUrl ? 'CONFIGURED_NOT_VERIFIED' : 'NOT_CONFIGURED',
        loginReadiness: { credentialsStored: !!value.lineLoginChannelId && !!value.lineLoginChannelSecretEncrypted, secretReadable: loginSecretReadable, callbackUrlConfigured: !!value.lineLoginCallbackUrl, oauthCallbackHandlerReady: true, oauthTransport: process.env.LINE_OAUTH_TRANSPORT === 'line' ? 'LINE' : 'TEST_ONLY', externalConnectionTested: false }
      },
      updatedAt: value.updatedAt,
      updatedBy: value.updatedBy
    };
  }

  @Get()
  async get(@Req() req: AppRequest) {
    await this.staff(req, ['ADMIN', 'OPERATOR']);
    return this.view(await this.auth.db.systemSetting.findUniqueOrThrow({ where: { id: 'global' } }));
  }

  @Patch()
  async update(@Req() req: AppRequest, @Body() body: unknown) {
    const actor = await this.staff(req, ['ADMIN']);
    const input = adminSettingsUpdateSchema.parse(body);
    return this.auth.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(7262026)::text`;
      const before = await tx.systemSetting.findUniqueOrThrow({ where: { id: 'global' } });
      if (before.revision !== input.revision) throw new ConflictException({ code: 'STALE_REVISION', message: '別の管理者が設定を変更しました。再読み込みしてください。' });
      const lineChannelSecretEncrypted = input.line.channelSecret ? encrypt(input.line.channelSecret) : input.line.clearChannelSecret ? null : before.lineChannelSecretEncrypted;
      const lineAccessTokenEncrypted = input.line.channelAccessToken ? encrypt(input.line.channelAccessToken) : input.line.clearChannelAccessToken ? null : before.lineAccessTokenEncrypted;
      const lineLoginChannelSecretEncrypted = input.line.loginChannelSecret ? encrypt(input.line.loginChannelSecret) : input.line.clearLoginChannelSecret ? null : before.lineLoginChannelSecretEncrypted;
      const stripeSecretKeyEncrypted = input.stripe.secretKey ? encrypt(input.stripe.secretKey) : input.stripe.clearSecretKey ? null : before.stripeSecretKeyEncrypted;
      const stripeWebhookSecretEncrypted = input.stripe.webhookSecret ? encrypt(input.stripe.webhookSecret) : input.stripe.clearWebhookSecret ? null : before.stripeWebhookSecretEncrypted;
      const mailApiKeyEncrypted = input.mail.apiKey ? encrypt(input.mail.apiKey) : input.mail.clearApiKey ? null : before.mailApiKeyEncrypted;
      const mailWebhookSecretEncrypted = input.mail.webhookSecret ? encrypt(input.mail.webhookSecret) : input.mail.clearWebhookSecret ? null : before.mailWebhookSecretEncrypted;
      const turnstileSecretEncrypted = input.captcha.secret ? encrypt(input.captcha.secret) : input.captcha.clearSecret ? null : before.turnstileSecretEncrypted;
      if (input.captcha.enabled && (!input.captcha.siteKey || !turnstileSecretEncrypted)) throw new BadRequestException({ code: 'CAPTCHA_CREDENTIALS_REQUIRED', message: 'Bot対策を有効にするにはSite keyとSecret keyが必要です。' });
      if (process.env.NODE_ENV === 'production' && input.captcha.enabled && process.env.CAPTCHA_TRANSPORT !== 'turnstile') throw new BadRequestException({ code: 'CAPTCHA_CONFIGURATION_REQUIRED', message: 'Bot対策を有効にする前にTurnstile transportを設定してください。' });
      if (input.operations.lineNotificationsEnabled && (!input.line.channelId || !lineChannelSecretEncrypted || !lineAccessTokenEncrypted)) throw new BadRequestException({ code: 'LINE_CREDENTIALS_REQUIRED', message: 'LINE通知を有効にするにはChannel ID、Channel secret、Channel access tokenが必要です。' });
      if (input.operations.lineLoginEnabled && (!input.line.loginChannelId || !lineLoginChannelSecretEncrypted || !input.line.loginCallbackUrl)) throw new BadRequestException({ code: 'LINE_LOGIN_CREDENTIALS_REQUIRED', message: 'LINE Loginを有効にするにはChannel ID、Channel secret、Callback URLが必要です。' });
      const stripe = resolveStripeConfig({
        stripeSecretKeyEncrypted,
        stripeWebhookSecretEncrypted,
        stripeLiveMode: input.stripe.liveMode,
        stripePriceFounder: input.stripe.priceFounder,
        stripePriceStandard: input.stripe.priceStandard,
        stripePriceDayPass: input.stripe.priceDayPass
      });
      if (stripe.source === 'ADMIN' && stripeSecretKeyEncrypted && !stripe.secretKey) throw new BadRequestException({ code: 'STRIPE_CREDENTIALS_UNREADABLE', message: '保存済みStripe資格情報を読み取れません。再設定してください。' });
      if (stripe.source === 'ADMIN' && input.stripe.liveMode && !stripe.complete) throw new BadRequestException({ code: 'STRIPE_CREDENTIALS_REQUIRED', message: 'Stripe本番モードにはSecret key、Webhook secret、3つのPrice IDが必要です。' });
      if (stripe.source === 'ADMIN' && stripe.secretKey && !stripe.modeConsistent) throw new BadRequestException({ code: 'STRIPE_MODE_MISMATCH', message: 'Stripe Secret keyとテスト・本番モードが一致しません。' });
      if (process.env.BILLING_TRANSPORT === 'stripe' && stripe.source === 'ADMIN' && !stripe.runtimeModeAllowed) throw new BadRequestException({ code: 'STRIPE_RUNTIME_MODE_MISMATCH', message: process.env.LAUNCH_MODE === 'STRIPE_SANDBOX' ? 'Stripeサンドボックスではテストモードだけを使用できます。' : '配備環境とStripeのテスト・本番モードが一致しません。' });
      if (process.env.BILLING_TRANSPORT === 'stripe' && input.operations.newPurchasesEnabled && !stripe.usable) throw new BadRequestException({ code: 'STRIPE_CONFIGURATION_REQUIRED', message: '新規購入を有効にする前に、この環境で利用できるStripe設定を完了してください。' });
      const mail = resolveMailConfig({ mailApiKeyEncrypted, mailWebhookSecretEncrypted, mailFrom: input.mail.from });
      if (mailApiKeyEncrypted && !mail.secretReadable) throw new BadRequestException({ code: 'MAIL_CREDENTIALS_UNREADABLE', message: '保存済みメール資格情報を読み取れません。再設定してください。' });
      if (mailWebhookSecretEncrypted && !mail.webhookSecretReadable) throw new BadRequestException({ code: 'MAIL_WEBHOOK_CREDENTIALS_UNREADABLE', message: '保存済みメールWebhook資格情報を読み取れません。再設定してください。' });
      if (process.env.MAIL_TRANSPORT === 'resend' && !mail.complete) throw new BadRequestException({ code: 'MAIL_CONFIGURATION_REQUIRED', message: 'Resend transportにはAPI key、送信元、Webhook signing secretが必要です。' });
      const after = await tx.systemSetting.update({ where: { id: 'global' }, data: {
        ...input.operations,
        registrationPauseMessage: input.registrationPauseMessage,
        registrationCaptchaEnabled: input.captcha.enabled,
        turnstileSiteKey: input.captcha.siteKey,
        turnstileSecretEncrypted,
        maintenanceMessage: input.maintenanceMessage,
        notificationMaxAttempts: input.notificationPolicy.maxAttempts,
        notificationBaseDelaySeconds: input.notificationPolicy.baseDelaySeconds,
        ...(input.publicationPolicy ? { predictionCorrectionPolicy: input.publicationPolicy.correction, delayedPublicationPolicy: input.publicationPolicy.delayedRace } : {}),
        ...input.billing,
        stripeSecretKeyEncrypted,
        stripeWebhookSecretEncrypted,
        stripeLiveMode: stripe.source === 'ADMIN' ? input.stripe.liveMode : false,
        stripePriceFounder: input.stripe.priceFounder,
        stripePriceStandard: input.stripe.priceStandard,
        stripePriceDayPass: input.stripe.priceDayPass,
        mailApiKeyEncrypted,
        mailWebhookSecretEncrypted,
        mailFrom: input.mail.from,
        lineChannelId: input.line.channelId,
        lineChannelSecretEncrypted,
        lineAccessTokenEncrypted,
        lineLoginChannelId: input.line.loginChannelId,
        lineLoginChannelSecretEncrypted,
        lineLoginCallbackUrl: input.line.loginCallbackUrl,
        updatedBy: actor.id,
        updatedAt: new Date(),
        revision: { increment: 1 }
      } });
      await this.auth.audit(tx, req, 'SYSTEM_SETTINGS_UPDATE', 'global', input.reason, {
        before: this.view(before), after: this.view(after),
        credentialsChanged: { turnstileSecret: !!input.captcha.secret || input.captcha.clearSecret, channelSecret: !!input.line.channelSecret || input.line.clearChannelSecret, channelAccessToken: !!input.line.channelAccessToken || input.line.clearChannelAccessToken, loginChannelSecret: !!input.line.loginChannelSecret || input.line.clearLoginChannelSecret, stripeSecretKey: !!input.stripe.secretKey || input.stripe.clearSecretKey, stripeWebhookSecret: !!input.stripe.webhookSecret || input.stripe.clearWebhookSecret, mailApiKey: !!input.mail.apiKey || input.mail.clearApiKey, mailWebhookSecret: !!input.mail.webhookSecret || input.mail.clearWebhookSecret }
      });
      return this.view(after);
    }, { timeout: 20000, maxWait: 10000 });
  }
}
