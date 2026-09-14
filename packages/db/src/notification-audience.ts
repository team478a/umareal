import { Prisma } from '@prisma/client';

export type NotificationAudienceInput = {
  channel: 'LINE' | 'EMAIL';
  eventType: string;
  visibility: 'FREE' | 'PAID';
  raceDate: string;
  now: Date;
};

/** Shared expansion filter used by delivery execution and read-only previews. */
export function notificationRecipientWhere(input: NotificationAudienceInput): Prisma.UserWhereInput {
  const preference = input.eventType === 'PREDICTION_CORRECTED' ? { changes: true } : { predictions: true };
  const paidFilter: Prisma.UserWhereInput = input.visibility === 'PAID' ? { entitlements: { some: { revokedAt: null, startsAt: { lte: input.now }, endsAt: { gt: input.now }, OR: [{ raceDate: null }, { raceDate: input.raceDate }] } } } : {};
  const channelFilter: Prisma.UserWhereInput = input.channel === 'LINE'
    ? { lineAccount: { is: { notificationDisabledAt: null, unlinkedAt: null } }, preferences: { is: preference } }
    : { email: { not: null }, emailVerifiedAt: { not: null }, emailDeliveryDisabledAt: null, preferences: { is: { emailEnabled: true, ...preference } } };
  return { disabledAt: null, ...channelFilter, ...paidFilter };
}
