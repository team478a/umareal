import { z } from 'zod';
import { dateSchema, raceStatuses } from './races';

const adminOperationsDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const adminOperationsStepKeys = ['SETUP', 'ANNOUNCEMENT', 'PADDOCK', 'PUBLICATION', 'DELIVERY', 'RESULT'] as const;
export const adminOperationsStepStates = ['DONE', 'CURRENT', 'WAITING', 'BLOCKED', 'NOT_DUE'] as const;

export const adminOperationsStepSchema = z.object({
  key: z.enum(adminOperationsStepKeys),
  label: z.string().min(1),
  state: z.enum(adminOperationsStepStates),
  detail: z.string().min(1)
}).strict();

export const adminOperationsRaceSchema = z.object({
  id: z.string().uuid(),
  raceDate: dateSchema,
  venue: z.string().min(1),
  number: z.number().int().positive(),
  name: z.string().min(1),
  status: z.enum(raceStatuses),
  startsAt: adminOperationsDateTimeSchema,
  secondsRemaining: z.number().int(),
  deadlineState: z.enum(['UPCOMING', 'DUE_SOON', 'OVERDUE']),
  assignments: z.array(z.object({
    id: z.string().uuid(),
    displayName: z.string().min(1),
    active: z.boolean()
  }).strict()),
  entries: z.object({
    total: z.number().int().nonnegative(),
    paddockCompleted: z.number().int().nonnegative()
  }).strict(),
  announcement: z.object({
    version: z.number().int().positive(),
    publishedAt: adminOperationsDateTimeSchema,
    eventStatus: z.string().min(1).nullable()
  }).strict().nullable(),
  prediction: z.object({
    version: z.number().int().positive(),
    status: z.enum(['PUBLISHED', 'CORRECTED']),
    publishedAt: adminOperationsDateTimeSchema,
    eventStatus: z.string().min(1).nullable()
  }).strict().nullable(),
  notification: z.object({
    queued: z.number().int().nonnegative(),
    sent: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative()
  }).strict(),
  result: z.object({
    version: z.number().int().positive(),
    confirmedAt: adminOperationsDateTimeSchema
  }).strict().nullable(),
  warnings: z.array(z.string().min(1)),
  rehearsal: z.object({
    status: z.enum(['BLOCKED', 'COMPLETE', 'READY', 'IN_PROGRESS']),
    done: z.number().int().min(0).max(6),
    total: z.literal(6),
    nextStep: z.enum(adminOperationsStepKeys).nullable(),
    steps: z.array(adminOperationsStepSchema).length(6)
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.entries.paddockCompleted > value.entries.total) {
    context.addIssue({ code: 'custom', path: ['entries', 'paddockCompleted'], message: 'Paddock completion count exceeds the entry total.' });
  }
  const keys = value.rehearsal.steps.map(step => step.key);
  if (keys.some((key, index) => key !== adminOperationsStepKeys[index])) {
    context.addIssue({ code: 'custom', path: ['rehearsal', 'steps'], message: 'Rehearsal steps are out of order.' });
  }
});

export const adminOperationsResponseSchema = z.object({
  date: dateSchema,
  generatedAt: adminOperationsDateTimeSchema,
  items: z.array(adminOperationsRaceSchema),
  alerts: z.number().int().nonnegative(),
  rehearsal: z.object({
    ready: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    preflight: z.object({
      csvImportEnabled: z.boolean(),
      predictionPublicationEnabled: z.boolean(),
      lineNotificationsEnabled: z.boolean(),
      lineConfigured: z.boolean()
    }).strict()
  }).strict()
}).strict();

export type AdminOperationsResponse = z.infer<typeof adminOperationsResponseSchema>;
export type AdminOperationsRace = z.infer<typeof adminOperationsRaceSchema>;
export type AdminOperationsStep = z.infer<typeof adminOperationsStepSchema>;
