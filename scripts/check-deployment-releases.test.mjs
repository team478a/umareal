import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDeploymentHealth } from './check-deployment-releases.mjs';

const release = { service: 'web', commit: 'abcdef012345' };

test('accepts a consistent deployment with a live worker', () => {
  assert.deepEqual(verifyDeploymentHealth({
    status: 'ok',
    deployment: {
      ready: true,
      consistency: 'CONSISTENT',
      web: release,
      api: { ...release, service: 'api' },
      worker: { ...release, service: 'worker', status: 'OK', heartbeatAt: '2026-09-26T00:00:00.000Z' }
    }
  }), { ok: true, reason: 'READY', commit: 'abcdef012345' });
});

test('rejects missing metadata, a mixed release and a stale worker', () => {
  assert.equal(verifyDeploymentHealth({ status: 'ok' }).reason, 'RELEASE_METADATA_MISSING');
  assert.equal(verifyDeploymentHealth({
    status: 'ok',
    deployment: {
      ready: false,
      consistency: 'MISMATCH',
      web: release,
      api: { service: 'api', commit: '1234567890ab' },
      worker: { service: 'worker', commit: 'abcdef012345', status: 'OK' }
    }
  }).reason, 'RELEASE_MISMATCH');
  assert.equal(verifyDeploymentHealth({
    status: 'ok',
    deployment: {
      ready: false,
      consistency: 'CONSISTENT',
      web: release,
      api: { ...release, service: 'api' },
      worker: { ...release, service: 'worker', status: 'STALE' }
    }
  }).reason, 'WORKER_NOT_READY');
});
