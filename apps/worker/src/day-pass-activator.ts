import { Prisma, type PrismaClient } from '@keiba/db';
import { dayPassWindow, jstDate } from '@keiba/domain';

type Options = {
  db: PrismaClient;
  now?: () => Date;
  limit?: number;
};

export async function activateStartedDayPasses({ db, now = () => new Date(), limit = 200 }: Options) {
  const dueAt = now();
  const targetDate = jstDate(dueAt);
  return db.$transaction(async tx => {
    const pending = await tx.$queryRaw<Array<{ id: string; userId: string; raceDate: string; endsAt: Date; priceYen: number; source: string }>>(Prisma.sql`
      SELECT id, "userId", "raceDate", "endsAt", "priceYen", source
      FROM day_passes
      WHERE status = 'PENDING'
        AND "startsAt" IS NULL
        AND "entitlementId" IS NULL
        AND "raceDate" <= ${targetDate}
        AND "endsAt" > ${dueAt}
      ORDER BY "raceDate", id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    `);
    for (const pass of pending) {
      const startsAt = dayPassWindow(pass.raceDate).startsAt;
      const entitlement = await tx.entitlement.create({
        data: { userId: pass.userId, planCode: 'DAY_PASS', startsAt, endsAt: pass.endsAt, raceDate: pass.raceDate, reason: 'TARGET_DATE_STARTED', grantedBy: pass.userId }
      });
      await tx.dayPass.update({ where: { id: pass.id }, data: { status: 'ACTIVE', startsAt, entitlementId: entitlement.id, updatedAt: dueAt } });
      await tx.billingEvent.create({
        data: { userId: pass.userId, eventType: 'DAY_PASS_STARTED', dayPassId: pass.id, actorId: pass.userId, details: { raceDate: pass.raceDate, priceYen: pass.priceYen, source: 'TARGET_DATE_STARTED', startsAt: startsAt.toISOString() } }
      });
      await tx.auditLog.create({
        data: { actorId: null, actorRole: 'SYSTEM', action: 'DAY_PASS_AUTO_STARTED', targetType: 'DAY_PASS', targetId: pass.id, reason: '対象開催日0:00 JST到達', details: { raceDate: pass.raceDate, source: pass.source, entitlementId: entitlement.id, startsAt: startsAt.toISOString() }, requestId: `day-pass-start:${pass.id}` }
      });
    }
    return { activated: pending.length };
  });
}
