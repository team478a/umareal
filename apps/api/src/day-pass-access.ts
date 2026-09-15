import { dayPassWindow } from '@keiba/domain';
import type { Prisma } from '@keiba/db';

type Tx = Prisma.TransactionClient;

export async function createDayPassAccess(tx: Tx, input: {
  userId: string;
  raceDate: string;
  priceYen: number;
  provider: string;
  providerPassId: string;
  reason: string;
  actorId: string;
  source: string;
}) {
  const window = dayPassWindow(input.raceDate);
  const product = await tx.predictionProduct.findUnique({
    where: { type_targetDate: { type: 'WIN5_PREVIEW', targetDate: input.raceDate } },
    select: { versions: { orderBy: { version: 'asc' }, take: 1, select: { publishedAt: true } } }
  });
  const startsAt = product ? product.versions[0]?.publishedAt ?? null : window.startsAt;
  const entitlement = startsAt ? await tx.entitlement.create({
    data: { userId: input.userId, planCode: 'DAY_PASS', startsAt, endsAt: window.endsAt, raceDate: input.raceDate, reason: input.reason, grantedBy: input.actorId }
  }) : null;
  const pass = await tx.dayPass.create({
    data: {
      userId: input.userId,
      raceDate: input.raceDate,
      status: startsAt ? 'ACTIVE' : 'PENDING',
      priceYen: input.priceYen,
      startsAt,
      endsAt: window.endsAt,
      provider: input.provider,
      providerPassId: input.providerPassId,
      entitlementId: entitlement?.id ?? null
    }
  });
  await tx.billingEvent.create({
    data: {
      userId: input.userId,
      eventType: startsAt ? 'DAY_PASS_STARTED' : 'DAY_PASS_PENDING',
      dayPassId: pass.id,
      actorId: input.actorId,
      details: { raceDate: input.raceDate, priceYen: input.priceYen, source: input.source, startsAt }
    }
  });
  return { pass, startsAt, endsAt: window.endsAt, waitingForPublication: !startsAt };
}

export async function activatePendingDayPasses(tx: Tx, targetDate: string, publishedAt: Date, actorId: string) {
  const pending = await tx.dayPass.findMany({
    where: { raceDate: targetDate, status: 'PENDING', startsAt: null, entitlementId: null, endsAt: { gt: publishedAt } },
    select: { id: true, userId: true, endsAt: true, priceYen: true }
  });
  for (const pass of pending) {
    const entitlement = await tx.entitlement.create({
      data: { userId: pass.userId, planCode: 'DAY_PASS', startsAt: publishedAt, endsAt: pass.endsAt, raceDate: targetDate, reason: 'WIN5_FIRST_PUBLICATION', grantedBy: actorId }
    });
    await tx.dayPass.update({ where: { id: pass.id }, data: { status: 'ACTIVE', startsAt: publishedAt, entitlementId: entitlement.id, updatedAt: new Date() } });
    await tx.billingEvent.create({
      data: { userId: pass.userId, eventType: 'DAY_PASS_STARTED', dayPassId: pass.id, actorId, details: { raceDate: targetDate, priceYen: pass.priceYen, source: 'WIN5_FIRST_PUBLICATION', startsAt: publishedAt } }
    });
  }
  return pending.length;
}
