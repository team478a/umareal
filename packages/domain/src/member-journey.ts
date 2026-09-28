import { z } from 'zod';

export const memberJourneyEventTypes = ['LINE_GUIDANCE_VIEWED', 'PLAN_VIEWED', 'CHECKOUT_REVIEWED'] as const;

export const memberJourneyEventSchema = z.object({
  eventType: z.enum(memberJourneyEventTypes)
}).strict();

export const memberJourneyResponseSchema = z.object({
  eventType: z.enum(memberJourneyEventTypes),
  occurredAt: z.preprocess(
    value => value instanceof Date ? value.toISOString() : value,
    z.string().datetime({ offset: true })
  ),
  recorded: z.literal(true)
}).strict();

export type MemberJourneyEvent = z.infer<typeof memberJourneyEventSchema>;
export type MemberJourneyResponse = z.infer<typeof memberJourneyResponseSchema>;
