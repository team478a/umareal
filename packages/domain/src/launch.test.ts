import { describe, expect, it } from 'vitest';
import { launchCapabilities, requiresPublishedLegalDocuments, resolveLaunchMode, stripeRuntimeModeAllowed } from './launch';

describe('launch capabilities', () => {
  it('keeps only the free registration experience enabled during the initial launch', () => {
    expect(launchCapabilities(resolveLaunchMode('FREE_REGISTRATION'))).toEqual({
      emailRegistration: true,
      freeContent: true,
      lineLogin: false,
      lineNotifications: false,
      billing: false
    });
  });

  it('allows no-charge billing rehearsal while keeping external LINE disabled in cloud staging', () => {
    expect(launchCapabilities(resolveLaunchMode('CLOUD_STAGING'))).toEqual({
      emailRegistration: true,
      freeContent: true,
      lineLogin: false,
      lineNotifications: false,
      billing: true
    });
  });

  it('allows Stripe test-mode checkout while keeping external LINE disabled in the sandbox', () => {
    expect(launchCapabilities(resolveLaunchMode('STRIPE_SANDBOX'))).toEqual({
      emailRegistration: true,
      freeContent: true,
      lineLogin: false,
      lineNotifications: false,
      billing: true
    });
  });

  it('enables every implemented external capability in full mode', () => {
    expect(launchCapabilities(resolveLaunchMode('FULL'))).toEqual({
      emailRegistration: true,
      freeContent: true,
      lineLogin: true,
      lineNotifications: true,
      billing: true
    });
  });

  it('rejects unknown launch modes', () => {
    expect(() => resolveLaunchMode('partial')).toThrow();
  });

  it('allows draft documents only in explicit cloud test modes', () => {
    expect(requiresPublishedLegalDocuments('production', resolveLaunchMode('CLOUD_STAGING'))).toBe(false);
    expect(requiresPublishedLegalDocuments('production', resolveLaunchMode('STRIPE_SANDBOX'))).toBe(false);
    expect(requiresPublishedLegalDocuments('production', resolveLaunchMode('FREE_REGISTRATION'))).toBe(true);
    expect(requiresPublishedLegalDocuments('production', resolveLaunchMode('FULL'))).toBe(true);
    expect(requiresPublishedLegalDocuments('development', resolveLaunchMode('FULL'))).toBe(false);
  });

  it('binds production Stripe credentials to the selected launch mode', () => {
    expect(stripeRuntimeModeAllowed('production', resolveLaunchMode('STRIPE_SANDBOX'), false)).toBe(true);
    expect(stripeRuntimeModeAllowed('production', resolveLaunchMode('STRIPE_SANDBOX'), true)).toBe(false);
    expect(stripeRuntimeModeAllowed('production', resolveLaunchMode('FULL'), true)).toBe(true);
    expect(stripeRuntimeModeAllowed('production', resolveLaunchMode('FULL'), false)).toBe(false);
    expect(stripeRuntimeModeAllowed('production', resolveLaunchMode('CLOUD_STAGING'), false)).toBe(false);
    expect(stripeRuntimeModeAllowed('development', resolveLaunchMode('FULL'), false)).toBe(true);
  });
});
