import { resolveDeploymentCommit } from '@keiba/domain';
import type { PrismaClient } from '@keiba/db';

type HeartbeatDatabase = Pick<PrismaClient, 'serviceHeartbeat'>;

export async function recordWorkerHeartbeat(
  db: HeartbeatDatabase,
  input: { startedAt: Date; now?: Date; environment?: Readonly<Record<string, string | undefined>> }
) {
  const heartbeatAt = input.now ?? new Date();
  const releaseCommit = resolveDeploymentCommit(input.environment ?? process.env);
  await db.serviceHeartbeat.upsert({
    where: { service: 'worker' },
    create: { service: 'worker', releaseCommit, heartbeatAt, startedAt: input.startedAt },
    update: { releaseCommit, heartbeatAt, startedAt: input.startedAt }
  });
  return { releaseCommit, heartbeatAt };
}
