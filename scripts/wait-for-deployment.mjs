import { pathToFileURL } from 'node:url';
import { verifyDeploymentHealth } from './check-deployment-releases.mjs';

const fullCommitPattern = /^[0-9a-f]{40}$/i;

function deploymentUrl(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Deployment verification requires HTTPS outside localhost.');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Deployment base URL must be an origin without credentials, path, query or fragment.');
  return url;
}

function progressState(value, expectedCommit) {
  const result = verifyDeploymentHealth(value);
  if (!result.ok) return { ready: false, reason: result.reason, observedCommit: result.commits?.[0] ?? null };
  if (result.commit !== expectedCommit.slice(0, 12)) return { ready: false, reason: 'UNEXPECTED_RELEASE', observedCommit: result.commit };
  return { ready: true, reason: 'READY', observedCommit: result.commit };
}

export async function waitForDeployment(input) {
  const baseUrl = deploymentUrl(input.baseUrl);
  const expectedCommit = input.expectedCommit.trim().toLowerCase();
  if (!fullCommitPattern.test(expectedCommit)) throw new Error('Expected commit must be a full 40-character Git SHA.');
  const attempts = input.attempts ?? 48;
  const intervalMs = input.intervalMs ?? 15_000;
  const requestTimeoutMs = input.requestTimeoutMs ?? 10_000;
  const timeoutMs = input.timeoutMs ?? null;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120) throw new Error('Attempts must be an integer from 1 to 120.');
  if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) throw new Error('Interval must be from 0 to 60000 milliseconds.');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) throw new Error('Request timeout must be from 1 to 60000 milliseconds.');
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000)) throw new Error('Overall timeout must be from 1 to 1800000 milliseconds.');
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? (duration => new Promise(resolve => setTimeout(resolve, duration)));
  const now = input.now ?? Date.now;
  const deadline = timeoutMs === null ? null : now() + timeoutMs;
  let last = { ready: false, reason: 'NOT_CHECKED', observedCommit: null };
  let lastReport = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1 && deadline !== null && now() >= deadline) break;
    try {
      const response = await fetchImpl(new URL('/health', baseUrl), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
      const value = await response.json().catch(() => null);
      last = response.ok ? progressState(value, expectedCommit) : { ready: false, reason: `HTTP_${response.status}`, observedCommit: null };
    } catch {
      last = { ready: false, reason: 'REQUEST_FAILED', observedCommit: null };
    }
    const report = `${last.reason}:${last.observedCommit ?? 'unknown'}`;
    if (report !== lastReport) {
      input.onProgress?.({ attempt, ...last });
      lastReport = report;
    }
    if (last.ready) return { commit: last.observedCommit, attempts: attempt };
    if (attempt >= attempts || (deadline !== null && now() >= deadline)) break;
    const waitMs = deadline === null ? intervalMs : Math.min(intervalMs, Math.max(0, deadline - now()));
    if (waitMs > 0) await sleep(waitMs);
  }
  throw new Error(`Deployment did not become ready. Last status: ${last.reason}.`);
}

async function main() {
  const baseUrl = process.argv[2] ?? process.env.DEPLOYMENT_BASE_URL;
  const expectedCommit = process.argv[3] ?? process.env.EXPECTED_COMMIT;
  const timeoutMs = Number(process.argv[4] ?? 720_000);
  if (!baseUrl || !expectedCommit) throw new Error('Usage: node scripts/wait-for-deployment.mjs <base-url> <full-commit> [timeout-ms]');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 15_000 || timeoutMs > 1_800_000) throw new Error('Timeout must be from 15000 to 1800000 milliseconds.');
  const intervalMs = 15_000;
  console.info(`Waiting for staging release ${expectedCommit.slice(0, 12)}.`);
  const result = await waitForDeployment({
    baseUrl,
    expectedCommit,
    attempts: 120,
    intervalMs,
    timeoutMs,
    onProgress: state => console.info(`Attempt ${state.attempt}: ${state.reason} (${state.observedCommit ?? 'unknown'}).`)
  });
  console.info(`Staging deployment is ready (${result.commit}) after ${result.attempts} check(s).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Deployment wait failed.');
    process.exitCode = 1;
  });
}
