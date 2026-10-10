import type { Prisma } from '@keiba/db';

export type BillingNotificationType =
  | 'BILLING_PAYMENT_SUCCEEDED'
  | 'BILLING_PAYMENT_FAILED'
  | 'BILLING_PAYMENT_RECOVERED'
  | 'BILLING_CANCELLATION_SCHEDULED'
  | 'BILLING_CANCELLATION_REVERSED'
  | 'BILLING_SUBSCRIPTION_ENDED'
  | 'BILLING_REFUND_COMPLETED';

export async function recordBillingEvent(tx: Prisma.TransactionClient, input: {
  userId: string;
  eventType: string;
  subscriptionId?: string;
  dayPassId?: string;
  billingCheckoutId?: string;
  bankTransferRequestId?: string;
  actorId: string;
  details: Prisma.InputJsonValue;
}, notificationType?: BillingNotificationType) {
  const event = await tx.billingEvent.create({
    data: {
      ...input,
      subscriptionId: input.subscriptionId ?? null,
      dayPassId: input.dayPassId ?? null,
      billingCheckoutId: input.billingCheckoutId ?? null,
      bankTransferRequestId: input.bankTransferRequestId ?? null
    }
  });
  if (notificationType) {
    await tx.notificationEvent.create({
      data: {
        billingEventId: event.id,
        eventType: notificationType,
        status: 'QUEUED',
        payload: { billingEventId: event.id }
      }
    });
  }
  return event;
}
