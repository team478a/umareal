import { describe, expect, it } from 'vitest';
import { launchCapabilities, lineNotificationRuntimeModeAllowed, requiresPublishedLegalDocuments, resolveLaunchMode, stripeRuntimeModeAllowed } from './launch';

describe('launch capabilities', () => {
  it('allows email and LINE registration and notifications while billing remains disabled', () => {
    expect(launchCapabilities(resolveLaunchMode('FREE_REGISTRATION'))).toEqual({
      emailRegistration: true,
      freeContent: true,
      lineLogin: true,
      lineNotifications: true,
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

  it.each([
    ['FREE_REGISTRATION', 'line', true], ['FREE_REGISTRATION', 'disabled', true], ['FREE_REGISTRATION', 'test', false],
    ['FULL', 'line', true], ['FULL', 'disabled', false], ['FULL', 'test', false],
    ['CLOUD_STAGING', 'disabled', true], ['CLOUD_STAGING', 'line', false], ['CLOUD_STAGING', 'test', false],
    ['STRIPE_SANDBOX', 'disabled', true], ['STRIPE_SANDBOX', 'line', false], ['STRIPE_SANDBOX', 'test', false]
  ])('enforces production LINE transport boundaries for %s / %s', (mode, transport, allowed) => {
    expect(lineNotificationRuntimeModeAllowed('production', resolveLaunchMode(mode), transport)).toBe(allowed);
  });

  it('permits loopback simulation without accepting unknown transports', () => {
    expect(lineNotificationRuntimeModeAllowed('development', 'FREE_REGISTRATION', 'test')).toBe(true);
    expect(lineNotificationRuntimeModeAllowed('production', 'FREE_REGISTRATION', undefined)).toBe(false);
    expect(lineNotificationRuntimeModeAllowed('development', 'FREE_REGISTRATION', 'unknown')).toBe(false);
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
