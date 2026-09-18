import { z } from 'zod';

export const launchModeSchema = z.enum(['CLOUD_STAGING', 'STRIPE_SANDBOX', 'FREE_REGISTRATION', 'FULL']);
export type LaunchMode = z.infer<typeof launchModeSchema>;

export type LaunchCapabilities = {
  emailRegistration: true;
  freeContent: true;
  lineLogin: boolean;
  lineNotifications: boolean;
  billing: boolean;
};

export function resolveLaunchMode(value: string | undefined): LaunchMode {
  return launchModeSchema.parse(value ?? 'FULL');
}

export function launchCapabilities(mode: LaunchMode): LaunchCapabilities {
  const full = mode === 'FULL';
  return {
    emailRegistration: true,
    freeContent: true,
    lineLogin: full,
    lineNotifications: full,
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

export function requiresPublishedLegalDocuments(nodeEnv: string | undefined, mode: LaunchMode): boolean {
  return nodeEnv === 'production' && !isCloudTestMode(mode);
}
