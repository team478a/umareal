import { z } from 'zod';
import { billingSettingsSchema } from './billing';

const mailFromSchema = z.string().trim().min(3).max(320).refine(value => {
  if (value.includes('\r') || value.includes('\n')) return false;
  const displayMatch = value.match(/^[^<>]{1,100}\s*<([^<>\s]+)>$/);
  if (displayMatch) return z.string().email().safeParse(displayMatch[1]).success;
  return !/[<>]/.test(value) && z.string().email().safeParse(value).success;
}, '送信元はメールアドレス、または「表示名 <メールアドレス>」で入力してください。');

export const adminSettingsUpdateSchema = z.object({
  revision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  operations: z.object({
    newRegistrationsEnabled: z.boolean(),
    emailNotificationsEnabled: z.boolean(),
    predictionPublicationEnabled: z.boolean(),
    csvImportEnabled: z.boolean(),
    lineNotificationsEnabled: z.boolean(),
    lineLoginEnabled: z.boolean(),
    newPurchasesEnabled: z.boolean()
  }).strict(),
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
  win5: z.object({
    defaultAmountPerPointYen: z.number().int().min(100).max(1_000_000).multipleOf(100),
    combinationWarningLimit: z.number().int().min(1).max(2_000_000_000)
  }).strict().optional(),
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
