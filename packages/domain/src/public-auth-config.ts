import { z } from 'zod';
import { launchCapabilitiesSchema, launchModeSchema } from './launch';

export const publicAuthConfigResponseSchema = z.object({
  provider: z.enum(['local', 'supabase']),
  localOnly: z.boolean(),
  launchMode: launchModeSchema,
  capabilities: launchCapabilitiesSchema,
  registration: z.object({
    enabled: z.boolean(),
    message: z.string()
  }).strict(),
  captcha: z.object({
    enabled: z.boolean(),
    siteKey: z.string().nullable(),
    mode: z.enum(['TEST_ONLY', 'TURNSTILE'])
  }).strict(),
  emailNotificationsEnabled: z.boolean(),
  lineEnabled: z.boolean(),
  lineNotificationsEnabled: z.boolean(),
  aiRaceGuideEnabled: z.boolean()
}).strict();

export type PublicAuthConfigResponse = z.infer<typeof publicAuthConfigResponseSchema>;
