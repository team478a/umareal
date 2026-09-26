import { apiBaseUrl } from '../api/v1/proxy';
import { deploymentConsistency, publicDeploymentRelease } from '@keiba/domain';

export const dynamic = 'force-dynamic';

type ApiHealth = {
  deployment?: {
    api?: { service: 'api'; commit: string | null };
    worker?: { service: 'worker'; commit: string | null; status: 'OK' | 'STALE' | 'UNKNOWN'; heartbeatAt: string | null };
  };
};

export async function GET() {
  const web = publicDeploymentRelease('web');
  try {
    const response = await fetch(`${apiBaseUrl()}/api/v1/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error('API readiness check failed');
    const value = await response.json() as ApiHealth;
    const api = value.deployment?.api ?? publicDeploymentRelease('api', null);
    const worker = value.deployment?.worker ?? { ...publicDeploymentRelease('worker', null), status: 'UNKNOWN' as const, heartbeatAt: null };
    const consistency = deploymentConsistency([web.commit, api.commit, worker.commit]);
    return Response.json({
      status: 'ok',
      deployment: {
        ready: consistency === 'CONSISTENT' && worker.status === 'OK',
        consistency,
        web,
        api,
        worker
      }
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({
      status: 'unavailable',
      deployment: {
        ready: false,
        consistency: 'UNKNOWN',
        web,
        api: publicDeploymentRelease('api', null),
        worker: { ...publicDeploymentRelease('worker', null), status: 'UNKNOWN', heartbeatAt: null }
      }
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
