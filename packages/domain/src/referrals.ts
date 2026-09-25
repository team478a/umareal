import { z } from 'zod';

export const memberReferralCodeSchema = z.string().trim().min(8).max(32).regex(/^[A-Za-z0-9_-]+$/).transform(value => value.toUpperCase());

// An invite is optional registration context, not a credential. Unknown or
// tampered values must fall back to ordinary registration without revealing
// whether a code exists. A modest input cap still protects the public API from
// unbounded payloads.
export const memberReferralCodeInputSchema = z.string().max(256).transform(value => {
  const parsed = memberReferralCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}).optional();

export const referralRewardRedeemSchema = z.object({ targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().superRefine((value, context) => {
  const parsed = new Date(`${value.targetDate}T00:00:00+09:00`);
  const time = parsed.getTime();
  const roundTrip = Number.isFinite(time) ? new Date(time + 9 * 3600000).toISOString().slice(0, 10) : null;
  if (roundTrip !== value.targetDate) context.addIssue({ code: 'custom', path: ['targetDate'], message: '有効な利用日を指定してください。' });
});

export const adminReferralListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  status: z.enum(['ALL', 'PENDING', 'QUALIFIED', 'INVALIDATED']).default('ALL')
});

export const referralInvalidateSchema = z.object({
  reason: z.string().trim().min(1).max(500)
}).strict();
