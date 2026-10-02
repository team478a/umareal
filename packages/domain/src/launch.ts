import { z } from 'zod';

export const launchModeSchema = z.enum(['CLOUD_STAGING', 'STRIPE_SANDBOX', 'FREE_REGISTRATION', 'FULL']);
export type LaunchMode = z.infer<typeof launchModeSchema>;

export const launchCapabilitiesSchema = z.object({
  emailRegistration: z.literal(true),
  freeContent: z.literal(true),
  lineLogin: z.boolean(),
  lineNotifications: z.boolean(),
  billing: z.boolean()
}).strict();
export type LaunchCapabilities = z.infer<typeof launchCapabilitiesSchema>;

export function resolveLaunchMode(value: string | undefined): LaunchMode {
  return launchModeSchema.parse(value ?? 'FULL');
}

export function launchCapabilities(mode: LaunchMode): LaunchCapabilities {
  const full = mode === 'FULL';
  const publicRegistration = full || mode === 'FREE_REGISTRATION';
  return {
    emailRegistration: true,
    freeContent: true,
    lineLogin: publicRegistration,
    lineNotifications: publicRegistration,
    billing: full || mode === 'CLOUD_STAGING' || mode === 'STRIPE_SANDBOX'
  };
}

export function isCloudTestMode(mode: LaunchMode): boolean {
  return mode === 'CLOUD_STAGING' || mode === 'STRIPE_SANDBOX';
}

export function stripeRuntimeModeAllowed(nodeEnv: string | undefined, mode: LaunchMode, liveMode: boolean): boolean {
  if (nodeEnv !== 'production') return true;
  return mode === 'FULL' ? liveMode : mode === 'STRIPE_SANDBOX' ? !liveMode : false;
}

export function lineNotificationRuntimeModeAllowed(nodeEnv: string | undefined, mode: LaunchMode, transport: string | undefined): boolean {
  if (!['test', 'line', 'disabled'].includes(transport ?? '')) return false;
  if (nodeEnv !== 'production') return true;
  if (mode === 'FREE_REGISTRATION') return transport === 'line' || transport === 'disabled';
  return mode === 'FULL' ? transport === 'line' : transport === 'disabled';
}

export function requiresPublishedLegalDocuments(nodeEnv: string | undefined, mode: LaunchMode): boolean {
  return nodeEnv === 'production' && !isCloudTestMode(mode);
}
