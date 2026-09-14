import type { PrismaClient, SystemSetting } from '@prisma/client';
import { decryptSecret } from './secret-box';

export type MailRuntimeConfig = {
  source: 'ADMIN' | 'ENVIRONMENT';
  apiKey: string | null;
  from: string | null;
  apiKeyConfigured: boolean;
  secretReadable: boolean;
  senderConfigured: boolean;
  complete: boolean;
};

type MailSetting = Pick<SystemSetting, 'mailApiKeyEncrypted' | 'mailFrom'>;
type MailEnvironment = { RESEND_API_KEY?: string; MAIL_FROM?: string };

function readSecret(value: string | null) {
  if (!value) return null;
  try { return decryptSecret(value); } catch { return null; }
}

export function resolveMailConfig(settings: MailSetting, environment: MailEnvironment = process.env): MailRuntimeConfig {
  const adminSelected = !!(settings.mailApiKeyEncrypted || settings.mailFrom);
  const apiKey = (adminSelected ? readSecret(settings.mailApiKeyEncrypted) : environment.RESEND_API_KEY)?.trim() || null;
  const from = (adminSelected ? settings.mailFrom : environment.MAIL_FROM)?.trim() || null;
  const apiKeyConfigured = adminSelected ? !!settings.mailApiKeyEncrypted : !!apiKey;
  const secretReadable = adminSelected ? !!apiKey : apiKeyConfigured;
  const senderConfigured = !!from;
  return {
    source: adminSelected ? 'ADMIN' : 'ENVIRONMENT', apiKey, from,
    apiKeyConfigured, secretReadable, senderConfigured,
    complete: !!apiKey && !!from
  };
}

export async function loadMailConfig(db: PrismaClient, environment: MailEnvironment = process.env) {
  const settings = await db.systemSetting.findUniqueOrThrow({
    where: { id: 'global' }, select: { mailApiKeyEncrypted: true, mailFrom: true }
  });
  return resolveMailConfig(settings, environment);
}
