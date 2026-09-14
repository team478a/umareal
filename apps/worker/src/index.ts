import { resolve } from 'node:path';
import { config } from 'dotenv';
import { databaseRuntimeAccessRestricted, PrismaClient } from '@keiba/db';
import { decryptSecret } from '@keiba/db';
import { runNotificationBatch, TestNotificationTransport } from './notification-runner';
import { runPublicationSchedules } from './publication-scheduler';
import { LineMessagingTransport } from './line-transport';

config({ path: resolve(process.cwd(), '../../.env'), quiet: true });
export const workerCapabilities = ['scheduled-publication', 'prediction-notification-outbox', 'recipient-authorization', 'retry-policy', 'delivery-attempt-history'] as const;

async function main() {
  const transportName = process.env.NOTIFICATION_TRANSPORT ?? 'test';
  if (!['test', 'line'].includes(transportName)) throw new Error('NOTIFICATION_TRANSPORT must be test or line');
  if (process.env.NODE_ENV === 'production' && transportName === 'test') throw new Error('The test notification transport is forbidden in production');
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
      : new TestNotificationTransport();
    do {
      const schedules = await runPublicationSchedules({ db });
      const result = await runNotificationBatch({ db, transport });
      console.info(JSON.stringify({ job: 'publication-and-notifications', schedules, ...result }));
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
export * from './publication-scheduler';
