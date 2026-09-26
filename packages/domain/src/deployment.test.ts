import { describe, expect, it } from 'vitest';
import { deploymentConsistency, publicDeploymentRelease, resolveDeploymentCommit, workerHeartbeatStatus } from './deployment';

const commit = 'abcdef0123456789abcdef0123456789abcdef01';

describe('deployment release metadata', () => {
  it('uses an explicit release before the Render commit and exposes only a short commit', () => {
    expect(resolveDeploymentCommit({ DEPLOYMENT_RELEASE: commit, RENDER_GIT_COMMIT: '1'.repeat(40) })).toBe(commit);
    expect(publicDeploymentRelease('api', commit)).toEqual({ service: 'api', commit: 'abcdef012345' });
  });

  it('rejects malformed values instead of reflecting arbitrary environment data', () => {
    expect(resolveDeploymentCommit({ RENDER_GIT_COMMIT: 'secret-value' })).toBeNull();
    expect(publicDeploymentRelease('web', null)).toEqual({ service: 'web', commit: null });
  });

  it('reports consistent, mismatched and unknown releases', () => {
    expect(deploymentConsistency(['abc', 'abc', 'abc'])).toBe('CONSISTENT');
    expect(deploymentConsistency(['abc', 'def', 'abc'])).toBe('MISMATCH');
    expect(deploymentConsistency(['abc', null, 'abc'])).toBe('UNKNOWN');
  });

  it('marks missing and old worker heartbeats without depending on wall clock time', () => {
    const now = new Date('2026-09-26T00:01:00.000Z');
    expect(workerHeartbeatStatus({ heartbeatAt: null, now })).toBe('UNKNOWN');
    expect(workerHeartbeatStatus({ heartbeatAt: new Date('2026-09-26T00:00:15.000Z'), now })).toBe('OK');
    expect(workerHeartbeatStatus({ heartbeatAt: new Date('2026-09-25T23:59:59.999Z'), now })).toBe('STALE');
  });
});
