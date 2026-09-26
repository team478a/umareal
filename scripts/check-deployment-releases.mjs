import { pathToFileURL } from 'node:url';

const shortCommitPattern = /^[0-9a-f]{12}$/;

export function verifyDeploymentHealth(value) {
  if (!value || typeof value !== 'object' || value.status !== 'ok') return { ok: false, reason: 'SERVICE_UNAVAILABLE' };
  const deployment = value.deployment;
  if (!deployment || typeof deployment !== 'object') return { ok: false, reason: 'RELEASE_METADATA_MISSING' };
  const commits = ['web', 'api', 'worker'].map(service => deployment[service]?.commit);
  if (!commits.every(commit => typeof commit === 'string' && shortCommitPattern.test(commit))) return { ok: false, reason: 'RELEASE_UNKNOWN' };
  if (new Set(commits).size !== 1 || deployment.consistency !== 'CONSISTENT') return { ok: false, reason: 'RELEASE_MISMATCH', commits };
  if (deployment.worker?.status !== 'OK') return { ok: false, reason: 'WORKER_NOT_READY', commits, workerStatus: deployment.worker?.status ?? 'UNKNOWN' };
  if (deployment.ready !== true) return { ok: false, reason: 'DEPLOYMENT_NOT_READY', commits };
  return { ok: true, reason: 'READY', commit: commits[0] };
}

async function main() {
  const input = process.argv[2] ?? process.env.DEPLOYMENT_BASE_URL;
  if (!input) throw new Error('Usage: pnpm deploy:verify-releases -- https://staging.example.com');
  const baseUrl = new URL(input);
  if (baseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(baseUrl.hostname)) throw new Error('Deployment verification requires HTTPS outside localhost.');
  const response = await fetch(new URL('/health', baseUrl), { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } });
  const value = await response.json().catch(() => null);
  const result = verifyDeploymentHealth(value);
  if (!response.ok || !result.ok) {
    console.error(`Deployment release verification failed: ${result.reason}.`);
    process.exitCode = 1;
    return;
  }
  console.info(`Deployment releases are consistent and the worker is active (${result.commit}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Deployment release verification failed.');
    process.exitCode = 1;
  });
}
