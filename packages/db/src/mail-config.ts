import type { PrismaClient, SystemSetting } from '@prisma/client';
import { decryptSecret } from './secret-box';

export type MailRuntimeConfig = {
  source: 'ADMIN' | 'ENVIRONMENT';
  apiKey: string | null;
  webhookSecret: string | null;
  from: string | null;
  apiKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  secretReadable: boolean;
  webhookSecretReadable: boolean;
  senderConfigured: boolean;
  sendingComplete: boolean;
  webhookComplete: boolean;
  complete: boolean;
};

type MailSetting = Pick<SystemSetting, 'mailApiKeyEncrypted' | 'mailWebhookSecretEncrypted' | 'mailFrom'>;
type MailEnvironment = { RESEND_API_KEY?: string; RESEND_WEBHOOK_SECRET?: string; MAIL_FROM?: string };

function readSecret(value: string | null) {
  if (!value) return null;
  try { return decryptSecret(value); } catch { return null; }
}

export function resolveMailConfig(settings: MailSetting, environment: MailEnvironment = process.env): MailRuntimeConfig {
  const adminSelected = !!(settings.mailApiKeyEncrypted || settings.mailWebhookSecretEncrypted || settings.mailFrom);
  const apiKey = (adminSelected ? readSecret(settings.mailApiKeyEncrypted) : environment.RESEND_API_KEY)?.trim() || null;
  const webhookSecret = (adminSelected ? readSecret(settings.mailWebhookSecretEncrypted) : environment.RESEND_WEBHOOK_SECRET)?.trim() || null;
  const from = (adminSelected ? settings.mailFrom : environment.MAIL_FROM)?.trim() || null;
  const apiKeyConfigured = adminSelected ? !!settings.mailApiKeyEncrypted : !!apiKey;
  const webhookSecretConfigured = adminSelected ? !!settings.mailWebhookSecretEncrypted : !!webhookSecret;
  const secretReadable = adminSelected ? !!apiKey : apiKeyConfigured;
  const webhookSecretReadable = adminSelected ? !!webhookSecret : webhookSecretConfigured;
  const senderConfigured = !!from;
  const sendingComplete = !!apiKey && !!from;
  const webhookComplete = !!webhookSecret;
  return {
    source: adminSelected ? 'ADMIN' : 'ENVIRONMENT', apiKey, webhookSecret, from,
    apiKeyConfigured, webhookSecretConfigured, secretReadable, webhookSecretReadable, senderConfigured,
    sendingComplete, webhookComplete, complete: sendingComplete && webhookComplete
  };
}

export async function loadMailConfig(db: PrismaClient, environment: MailEnvironment = process.env) {
  const settings = await db.systemSetting.findUniqueOrThrow({
    where: { id: 'global' }, select: { mailApiKeyEncrypted: true, mailWebhookSecretEncrypted: true, mailFrom: true }
  });
  return resolveMailConfig(settings, environment);
}
