import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { waitForDeployment } from './wait-for-deployment.mjs';

const expectedCommit = '1234567890abcdef1234567890abcdef12345678';
const ready = commit => ({
  status: 'ok',
  deployment: {
    ready: true,
    consistency: 'CONSISTENT',
    web: { commit },
    api: { commit },
    worker: { commit, status: 'OK' }
  }
});

function responses(values) {
  let index = 0;
  return async () => ({
    ok: true,
    status: 200,
    json: async () => values[Math.min(index++, values.length - 1)]
  });
}

test('waits through an old response and a different release until the expected release is ready', async () => {
  const progress = [];
  const result = await waitForDeployment({
    baseUrl: 'https://staging.example.test',
    expectedCommit,
    attempts: 3,
    intervalMs: 0,
    fetchImpl: responses([
      { status: 'ok' },
      ready('aaaaaaaaaaaa'),
      ready(expectedCommit.slice(0, 12))
    ]),
    sleep: async () => {},
    onProgress: state => progress.push(state.reason)
  });
  assert.deepEqual(result, { commit: expectedCommit.slice(0, 12), attempts: 3 });
  assert.deepEqual(progress, ['RELEASE_METADATA_MISSING', 'UNEXPECTED_RELEASE', 'READY']);
});

test('fails closed when the expected release never becomes ready', async () => {
  await assert.rejects(() => waitForDeployment({
    baseUrl: 'https://staging.example.test',
    expectedCommit,
    attempts: 2,
    intervalMs: 0,
    fetchImpl: responses([ready('aaaaaaaaaaaa')]),
    sleep: async () => {}
  }), /Last status: UNEXPECTED_RELEASE/);
});

test('bounds retries by wall-clock timeout as well as attempt count', async () => {
  let clock = 0;
  let requests = 0;
  await assert.rejects(() => waitForDeployment({
    baseUrl: 'https://staging.example.test',
    expectedCommit,
    attempts: 120,
    intervalMs: 6,
    timeoutMs: 10,
    now: () => clock,
    fetchImpl: async () => {
      requests += 1;
      return { ok: true, status: 200, json: async () => ready('aaaaaaaaaaaa') };
    },
    sleep: async duration => { clock += duration; }
  }), /Last status: UNEXPECTED_RELEASE/);
  assert.equal(requests, 2);
  assert.equal(clock, 10);
});

test('rejects unsafe URLs and abbreviated expected commits', async () => {
  await assert.rejects(() => waitForDeployment({ baseUrl: 'http://example.test', expectedCommit, attempts: 1 }), /requires HTTPS/);
  await assert.rejects(() => waitForDeployment({ baseUrl: 'https://user@example.test', expectedCommit, attempts: 1 }), /without credentials/);
  await assert.rejects(() => waitForDeployment({ baseUrl: 'https://example.test', expectedCommit: '1234567890ab', attempts: 1 }), /full 40-character/);
});

test('keeps the manual workflow read-only, main-only and free of deployment secrets', async () => {
  const workflow = await readFile(new URL('../.github/workflows/staging-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /workflow_run/);
  assert.doesNotMatch(workflow, /secrets\.|DATABASE_(?:URL|ADMIN_URL|RUNTIME_URL)|RENDER_API_KEY|DEPLOY_HOOK/i);
});
