export const deploymentServices = ['web', 'api', 'worker'] as const;
export type DeploymentService = typeof deploymentServices[number];
export type DeploymentConsistency = 'CONSISTENT' | 'MISMATCH' | 'UNKNOWN';
export type WorkerHeartbeatStatus = 'OK' | 'STALE' | 'UNKNOWN';

type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;

const gitCommitPattern = /^[0-9a-f]{40}$/i;

export function resolveDeploymentCommit(environment: DeploymentEnvironment = process.env) {
  const value = (environment.DEPLOYMENT_RELEASE ?? environment.RENDER_GIT_COMMIT ?? '').trim();
  return gitCommitPattern.test(value) ? value.toLowerCase() : null;
}

export function publicDeploymentRelease(service: DeploymentService, commit = resolveDeploymentCommit()) {
  return { service, commit: commit?.slice(0, 12) ?? null };
}

export function deploymentConsistency(commits: ReadonlyArray<string | null | undefined>): DeploymentConsistency {
  if (!commits.length || commits.some(commit => !commit)) return 'UNKNOWN';
  return new Set(commits).size === 1 ? 'CONSISTENT' : 'MISMATCH';
}

export function workerHeartbeatStatus(input: { heartbeatAt: Date | null; now?: Date; staleAfterMs?: number }): WorkerHeartbeatStatus {
  if (!input.heartbeatAt) return 'UNKNOWN';
  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? 60_000;
  return now.getTime() - input.heartbeatAt.getTime() <= staleAfterMs ? 'OK' : 'STALE';
}
