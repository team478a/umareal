import { describe, expect, it } from 'vitest';
import { lineNotificationState } from './line-notification-policy';

describe('LINE notification policy', () => {
  it('does not require LINE when the launch mode excludes it', () => {
    expect(lineNotificationState({ available: false, enabled: false, configured: false })).toEqual({
      paused: false,
      configurationMissing: false,
      affectsPublicMessage: false
    });
  });

  it('reports a paused or incomplete LINE channel when the launch mode includes LINE', () => {
    expect(lineNotificationState({ available: true, enabled: false, configured: false })).toEqual({
      paused: true,
      configurationMissing: false,
      affectsPublicMessage: true
    });
    expect(lineNotificationState({ available: true, enabled: true, configured: false })).toEqual({
      paused: false,
      configurationMissing: true,
      affectsPublicMessage: true
    });
    expect(lineNotificationState({ available: true, enabled: true, configured: true })).toEqual({
      paused: false,
      configurationMissing: false,
      affectsPublicMessage: false
    });
  });
});
