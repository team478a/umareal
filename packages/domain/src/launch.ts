import { z } from 'zod';

export const launchModeSchema = z.enum(['FREE_REGISTRATION', 'FULL']);
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
    billing: full
  };
}
