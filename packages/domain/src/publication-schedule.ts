import { z } from 'zod';

export const publicationKinds = ['RACE_ANNOUNCEMENT', 'FREE_REPORT_PRE_RACE'] as const;

export const publicationScheduleSchema = z.object({
  raceId: z.string().uuid(),
  kind: z.enum(publicationKinds),
  draftRevision: z.number().int().positive().nullable(),
  scheduledAt: z.string().datetime({ offset: true }).transform(value => new Date(value)),
  reason: z.string().trim().min(1).max(500)
}).strict();

export const publicationScheduleCancelSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
