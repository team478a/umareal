import { resolve } from 'node:path';
import { config } from 'dotenv';
import { launchCapabilities, resolveLaunchMode } from '@keiba/domain';
import { databaseRuntimeAccessRestricted, loadMailConfig, PrismaClient } from '@keiba/db';
import { decryptSecret } from '@keiba/db';
import { runEmailNotificationBatch, runNotificationBatch, skipPendingNotificationEvents, TestNotificationTransport, type NotificationTransport } from './notification-runner';
import { runPublicationSchedules } from './publication-scheduler';
import { LineMessagingTransport } from './line-transport';
import { ResendEmailTransport } from './email-transport';

config({ path: resolve(process.cwd(), '../../.env'), quiet: true });
export const workerCapabilities = ['scheduled-publication', 'prediction-notification-outbox', 'email-notifications', 'recipient-authorization', 'retry-policy', 'delivery-attempt-history'] as const;

async function main() {
  const transportName = process.env.NOTIFICATION_TRANSPORT ?? 'test';
  const mailTransportName = process.env.MAIL_TRANSPORT ?? 'test';
  if (process.env.NODE_ENV === 'production' && !process.env.LAUNCH_MODE) throw new Error('Set LAUNCH_MODE explicitly in production');
  const capabilities = launchCapabilities(resolveLaunchMode(process.env.LAUNCH_MODE));
  if (!['test', 'line', 'disabled'].includes(transportName)) throw new Error('NOTIFICATION_TRANSPORT must be test, line or disabled');
  if (!['test', 'resend'].includes(mailTransportName)) throw new Error('MAIL_TRANSPORT must be test or resend');
  if (process.env.NODE_ENV === 'production' && capabilities.lineNotifications && transportName !== 'line') throw new Error('Full production launch requires the LINE notification transport');
  if (process.env.NODE_ENV === 'production' && !capabilities.lineNotifications && transportName !== 'disabled') throw new Error('Free registration launch requires LINE notifications to be disabled');
  if (process.env.NODE_ENV === 'production' && mailTransportName !== 'resend') throw new Error('Production requires the Resend email transport');
  const db = new PrismaClient();
  const continuous = !process.argv.includes('--once');
  let stopping = false;
  const requestStop = () => { stopping = true; };
  process.once('SIGTERM', requestStop);
  process.once('SIGINT', requestStop);
  try {
    if (process.env.NODE_ENV === 'production' && !await databaseRuntimeAccessRestricted(db)) throw new Error('Production requires a restricted database runtime role');
    const transport = transportName === 'line'
      ? new LineMessagingTransport(decryptSecret((await db.systemSetting.findUniqueOrThrow({ where: { id: 'global' }, select: { lineAccessTokenEncrypted: true } })).lineAccessTokenEncrypted ?? ''))
      : transportName === 'test' ? new TestNotificationTransport() : null;
    do {
      let emailTransport: NotificationTransport = new TestNotificationTransport();
      if (mailTransportName === 'resend') {
        const mailConfig = await loadMailConfig(db);
        if (!mailConfig.sendingComplete || !mailConfig.apiKey || !mailConfig.from) throw new Error('Resend email transport requires a complete admin or environment configuration');
        emailTransport = new ResendEmailTransport(mailConfig.apiKey, mailConfig.from);
      }
      const schedules = await runPublicationSchedules({ db });
      const line = transport ? await runNotificationBatch({ db, transport }) : await skipPendingNotificationEvents(db);
      const email = await runEmailNotificationBatch({ db, transport: emailTransport });
      console.info(JSON.stringify({ job: 'publication-and-notifications', schedules, line, email }));
      if (!continuous || stopping) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 5000));
    } while (continuous && !stopping);
  } finally {
    process.off('SIGTERM', requestStop);
    process.off('SIGINT', requestStop);
    await db.$disconnect();
  }
}
if (require.main === module) void main();
export * from './notification-runner';
export * from './line-transport';
export * from './email-transport';
export * from './publication-scheduler';
