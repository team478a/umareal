import { describe, expect, it } from 'vitest';
import { lineNotificationState } from './line-notification-policy';

describe('LINE notification policy', () => {
  it('does not require LINE notifications when the launch mode excludes them', () => {
    expect(lineNotificationState({ available: false, enabled: false, configured: false })).toEqual({
      paused: false,
      configurationMissing: false,
      affectsPublicMessage: false
    });
  });

  it('reports a paused or incomplete LINE channel when the launch mode includes it', () => {
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
