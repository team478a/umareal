import { z } from 'zod';
import { dateSchema } from './races';

const accountDateTimeSchema = z.preprocess(
  value => value instanceof Date ? value.toISOString() : value,
  z.string().datetime({ offset: true })
);

export const notificationPreferencesResponseSchema = z.object({
  emailEnabled: z.boolean(),
  predictions: z.boolean(),
  changes: z.boolean(),
  articles: z.boolean(),
  billing: z.boolean()
}).strict();

export const currentAccountResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email().nullable(),
  emailVerified: z.boolean(),
  hasPassword: z.boolean(),
  registrationMethod: z.string().min(1),
  displayName: z.string().min(1),
  role: z.enum(['MEMBER', 'EXPERT', 'EDITOR', 'OPERATOR', 'ADMIN']),
  aal: z.union([z.literal(1), z.literal(2)]),
  mfaEnabled: z.boolean(),
  mfaRequired: z.boolean(),
  mfaBackupEnabled: z.boolean(),
  mfaBackupSupported: z.boolean(),
  preferences: notificationPreferencesResponseSchema,
  lineLinked: z.boolean(),
  lineNotificationState: z.enum(['NOT_LINKED', 'BLOCKED', 'DISABLED', 'READY']),
  lineNotificationReady: z.boolean(),
  emailNotificationState: z.enum(['BLOCKED', 'UNVERIFIED', 'DISABLED', 'READY']),
  emailNotificationReady: z.boolean(),
  emailDeliveryDisabledAt: accountDateTimeSchema.nullable(),
  emailDeliveryDisabledReason: z.enum(['BOUNCED', 'COMPLAINED', 'SUPPRESSED']).nullable(),
  entitlements: z.array(z.object({
    planCode: z.string().min(1),
    startsAt: accountDateTimeSchema,
    endsAt: accountDateTimeSchema,
    raceDate: dateSchema.nullable()
  }).strict()),
  consents: z.array(z.object({
    documentType: z.string().min(1),
    version: z.string().min(1),
    acceptedAt: accountDateTimeSchema
  }).strict())
}).strict();

export type CurrentAccountResponse = z.infer<typeof currentAccountResponseSchema>;
export type NotificationPreferencesResponse = z.infer<typeof notificationPreferencesResponseSchema>;
