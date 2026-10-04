import { z } from 'zod';
import { billingSettingsSchema } from './billing';
import { contentAccessPolicySchema } from './content-access';

const mailFromSchema = z.string().trim().min(3).max(320).refine(value => {
  if (value.includes('\r') || value.includes('\n')) return false;
  const displayMatch = value.match(/^[^<>]{1,100}\s*<([^<>\s]+)>$/);
  if (displayMatch) return z.string().email().safeParse(displayMatch[1]).success;
  return !/[<>]/.test(value) && z.string().email().safeParse(value).success;
}, '送信元はメールアドレス、または「表示名 <メールアドレス>」で入力してください。');

const adminSettingsDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminSettingsOperationsSchema = z.object({
  newRegistrationsEnabled: z.boolean(),
  emailNotificationsEnabled: z.boolean(),
  predictionPublicationEnabled: z.boolean(),
  csvImportEnabled: z.boolean(),
  lineNotificationsEnabled: z.boolean(),
  lineLoginEnabled: z.boolean(),
  newPurchasesEnabled: z.boolean()
}).strict();

const adminSettingsPublicationPolicySchema = z.object({
  correction: z.enum(['ADMIN_ONLY', 'EXPERT_OR_ADMIN']),
  delayedRace: z.enum(['CLOSED', 'LATEST_STARTS_AT'])
}).strict();

export const adminSettingsUpdateSchema = z.object({
  revision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  operations: adminSettingsOperationsSchema,
  registrationPauseMessage: z.string().trim().max(500),
  captcha: z.object({
    enabled: z.boolean(),
    siteKey: z.string().trim().min(1).max(100).nullable(),
    secret: z.string().trim().min(1).max(256).optional(),
    clearSecret: z.boolean()
  }).strict().superRefine((value, context) => {
    if (value.secret && value.clearSecret) context.addIssue({ code: 'custom', path: ['clearSecret'], message: 'Secret keyの入力と削除は同時に指定できません。' });
  }),
  maintenanceMessage: z.string().trim().max(500),
  notificationPolicy: z.object({
    maxAttempts: z.number().int().min(1).max(10),
    baseDelaySeconds: z.number().int().min(10).max(3600)
  }).strict(),
  contentAccess: contentAccessPolicySchema.optional(),
  publicationPolicy: adminSettingsPublicationPolicySchema.optional(),
  billing: billingSettingsSchema,
  stripe: z.object({
    liveMode: z.boolean(),
    secretKey: z.string().trim().min(16).max(256).regex(/^sk_(test|live)_[A-Za-z0-9_]+$/).optional(),
    webhookSecret: z.string().trim().min(16).max(256).regex(/^whsec_[A-Za-z0-9_]+$/).optional(),
    clearSecretKey: z.boolean(),
    clearWebhookSecret: z.boolean(),
    priceFounder: z.string().trim().regex(/^price_[A-Za-z0-9]+$/).max(100).nullable(),
    priceStandard: z.string().trim().regex(/^price_[A-Za-z0-9]+$/).max(100).nullable(),
    priceDayPass: z.string().trim().regex(/^price_[A-Za-z0-9]+$/).max(100).nullable()
  }).strict(),
  mail: z.object({
    apiKey: z.string().trim().min(10).max(256).regex(/^re_[A-Za-z0-9_-]+$/).optional(),
    webhookSecret: z.string().trim().min(16).max(256).regex(/^whsec_[A-Za-z0-9_+/=-]+$/).optional(),
    from: mailFromSchema.nullable(),
    clearApiKey: z.boolean(),
    clearWebhookSecret: z.boolean()
  }).strict().superRefine((value, context) => {
    if (value.apiKey && value.clearApiKey) context.addIssue({ code: 'custom', path: ['clearApiKey'], message: 'API keyの入力と削除は同時に指定できません。' });
    if (value.webhookSecret && value.clearWebhookSecret) context.addIssue({ code: 'custom', path: ['clearWebhookSecret'], message: 'Webhook secretの入力と削除は同時に指定できません。' });
  }),
  line: z.object({
    channelId: z.string().trim().max(100).nullable(),
    channelSecret: z.string().trim().min(16).max(256).optional(),
    channelAccessToken: z.string().trim().min(20).max(4096).optional(),
    clearChannelSecret: z.boolean(),
    clearChannelAccessToken: z.boolean(),
    loginChannelId: z.string().trim().max(100).nullable(),
    loginChannelSecret: z.string().trim().min(16).max(256).optional(),
    loginCallbackUrl: z.string().trim().url().max(500).nullable(),
    clearLoginChannelSecret: z.boolean()
  }).strict()
}).strict().superRefine((value, context) => {
  if (!value.operations.newRegistrationsEnabled && !value.registrationPauseMessage) {
    context.addIssue({ code: 'custom', path: ['registrationPauseMessage'], message: '新規登録を停止する場合は会員向け案内を入力してください。' });
  }
  if (value.captcha.enabled && !value.captcha.siteKey) {
    context.addIssue({ code: 'custom', path: ['captcha', 'siteKey'], message: 'Bot対策を有効にする場合はSite keyが必要です。' });
  }
});

export type AdminSettingsUpdate = z.infer<typeof adminSettingsUpdateSchema>;

export const adminSettingsResponseSchema = z.object({
  revision: z.number().int().positive(),
  operations: adminSettingsOperationsSchema,
  registrationPauseMessage: z.string(),
  captcha: z.object({
    enabled: z.boolean(),
    siteKey: z.string().nullable(),
    secretConfigured: z.boolean(),
    connectionStatus: z.enum(['DISABLED', 'INCOMPLETE', 'CONFIGURED_NOT_VERIFIED']),
    readiness: z.object({
      siteKeyStored: z.boolean(), secretStored: z.boolean(), secretReadable: z.boolean(), serverValidationReady: z.boolean(),
      transport: z.enum(['TEST_ONLY', 'TURNSTILE']), externalConnectionTested: z.boolean()
    }).strict()
  }).strict(),
  maintenanceMessage: z.string(),
  notificationPolicy: z.object({ maxAttempts: z.number().int().min(1).max(10), baseDelaySeconds: z.number().int().min(10).max(3600) }).strict(),
  contentAccess: contentAccessPolicySchema,
  publicationPolicy: adminSettingsPublicationPolicySchema,
  environment: z.object({
    launchMode: z.string().min(1),
    authProvider: z.enum(['SUPABASE', 'LOCAL_DEVELOPMENT']),
    applicationUrl: z.string().nullable(),
    adminUrlConfigured: z.boolean(), supabaseConfigured: z.boolean(), sentryConfigured: z.boolean(),
    transports: z.object({ captcha: z.string().min(1), mail: z.string().min(1), lineNotifications: z.string().min(1), lineLogin: z.string().min(1), billing: z.string().min(1) }).strict()
  }).strict(),
  billing: billingSettingsSchema,
  stripe: z.object({
    source: z.enum(['ADMIN', 'ENVIRONMENT']), liveMode: z.boolean(), secretKeyConfigured: z.boolean(), webhookSecretConfigured: z.boolean(),
    priceFounder: z.string().nullable(), priceStandard: z.string().nullable(), priceDayPass: z.string().nullable(),
    connectionStatus: z.enum(['NOT_CONFIGURED', 'INCOMPLETE', 'CONFIGURED_NOT_VERIFIED']),
    readiness: z.object({ credentialsStored: z.boolean(), secretsReadable: z.boolean(), pricesConfigured: z.boolean(), modeConsistent: z.boolean(), billingTransport: z.enum(['TEST_ONLY', 'STRIPE']), externalConnectionTested: z.boolean() }).strict()
  }).strict(),
  mail: z.object({
    source: z.enum(['ADMIN', 'ENVIRONMENT']), apiKeyConfigured: z.boolean(), webhookSecretConfigured: z.boolean(), from: z.string().nullable(),
    connectionStatus: z.enum(['NOT_CONFIGURED', 'INCOMPLETE', 'CONFIGURED_NOT_VERIFIED']),
    readiness: z.object({ credentialsStored: z.boolean(), secretReadable: z.boolean(), webhookSecretStored: z.boolean(), webhookSecretReadable: z.boolean(), senderConfigured: z.boolean(), webhookReceiverReady: z.boolean(), mailTransport: z.enum(['TEST_ONLY', 'RESEND']), externalConnectionTested: z.boolean() }).strict()
  }).strict(),
  line: z.object({
    channelId: z.string().nullable(), channelSecretConfigured: z.boolean(), channelAccessTokenConfigured: z.boolean(),
    connectionStatus: z.enum(['NOT_CONFIGURED', 'CONFIGURED_NOT_VERIFIED']),
    messagingReadiness: z.object({ credentialsStored: z.boolean(), secretsReadable: z.boolean(), applicationUrlReady: z.boolean(), notificationWorkerReady: z.boolean(), webhookSignatureVerifierReady: z.boolean(), outboundTransport: z.enum(['TEST_ONLY', 'LINE']), externalConnectionTested: z.boolean() }).strict(),
    loginChannelId: z.string().nullable(), loginChannelSecretConfigured: z.boolean(), loginCallbackUrl: z.string().nullable(),
    loginConnectionStatus: z.enum(['NOT_CONFIGURED', 'CONFIGURED_NOT_VERIFIED']),
    loginReadiness: z.object({ credentialsStored: z.boolean(), secretReadable: z.boolean(), callbackUrlConfigured: z.boolean(), oauthCallbackHandlerReady: z.boolean(), oauthTransport: z.enum(['TEST_ONLY', 'LINE']), externalConnectionTested: z.boolean() }).strict()
  }).strict(),
  updatedAt: adminSettingsDateTimeSchema,
  updatedBy: z.string().uuid().nullable()
}).strict();

export type AdminSettingsResponse = z.infer<typeof adminSettingsResponseSchema>;
