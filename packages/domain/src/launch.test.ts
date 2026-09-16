import { describe, expect, it } from 'vitest';
import { launchCapabilities, requiresPublishedLegalDocuments, resolveLaunchMode } from './launch';

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

  it('keeps external billing and LINE disabled in restricted cloud staging', () => {
    expect(launchCapabilities(resolveLaunchMode('CLOUD_STAGING'))).toEqual({
      emailRegistration: true,
      freeContent: true,
      lineLogin: false,
      lineNotifications: false,
      billing: false
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

  it('allows draft documents only in the explicit cloud staging mode', () => {
    expect(requiresPublishedLegalDocuments('production', resolveLaunchMode('CLOUD_STAGING'))).toBe(false);
    expect(requiresPublishedLegalDocuments('production', resolveLaunchMode('FREE_REGISTRATION'))).toBe(true);
    expect(requiresPublishedLegalDocuments('production', resolveLaunchMode('FULL'))).toBe(true);
    expect(requiresPublishedLegalDocuments('development', resolveLaunchMode('FULL'))).toBe(false);
  });
});
