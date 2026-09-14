import { z } from 'zod';
import { billingSettingsSchema } from './billing';

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
  maintenanceMessage: z.string().trim().max(500),
  notificationPolicy: z.object({
    maxAttempts: z.number().int().min(1).max(10),
    baseDelaySeconds: z.number().int().min(10).max(3600)
  }).strict(),
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
});

export type AdminSettingsUpdate = z.infer<typeof adminSettingsUpdateSchema>;
