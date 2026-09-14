import { describe, expect, it } from 'vitest';
import { launchCapabilities, resolveLaunchMode } from './launch';

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
});
