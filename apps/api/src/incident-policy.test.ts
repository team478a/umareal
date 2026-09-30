import { describe, expect, it } from 'vitest';
import { lineIncidentState } from './incident-policy';

describe('incident policy', () => {
  it('does not report LINE as an incident when the launch mode excludes LINE', () => {
    expect(lineIncidentState({ available: false, enabled: false, configured: false })).toEqual({
      paused: false,
      configurationMissing: false,
      affectsPublicMessage: false
    });
  });

  it('reports a paused or incomplete LINE channel when the launch mode includes LINE', () => {
    expect(lineIncidentState({ available: true, enabled: false, configured: false })).toEqual({
      paused: true,
      configurationMissing: false,
      affectsPublicMessage: true
    });
    expect(lineIncidentState({ available: true, enabled: true, configured: false })).toEqual({
      paused: false,
      configurationMissing: true,
      affectsPublicMessage: true
    });
    expect(lineIncidentState({ available: true, enabled: true, configured: true })).toEqual({
      paused: false,
      configurationMissing: false,
      affectsPublicMessage: false
    });
  });
});
