import { apiBaseUrl } from '../api/v1/proxy';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const response = await fetch(`${apiBaseUrl()}/api/v1/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) throw new Error('API readiness check failed');
    return Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
