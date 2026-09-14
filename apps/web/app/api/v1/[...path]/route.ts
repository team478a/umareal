import { NextRequest } from 'next/server';
import { apiBaseUrl, proxyRequestHeaders } from '../proxy';
export const dynamic = 'force-dynamic';
async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.some(p => !/^[a-zA-Z0-9_-]+$/.test(p))) return Response.json({ code: 'NOT_FOUND', message: 'ページが見つかりません。' }, { status: 404 });
  const headers = proxyRequestHeaders(request.headers);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${apiBaseUrl()}/api/v1/${path.join('/')}${request.nextUrl.search}`, {
      method: request.method, headers, cache: 'no-store', redirect: 'manual', signal: controller.signal,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
    });
    const outgoing = new Headers({ 'Content-Type': response.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' });
    for (const cookie of response.headers.getSetCookie()) outgoing.append('Set-Cookie', cookie);
    for (const key of ['x-request-id', 'retry-after', 'content-length', 'content-range', 'accept-ranges', 'content-disposition']) { const value = response.headers.get(key); if (value) outgoing.set(key, value); }
    const location = response.headers.get('location'); if (location) outgoing.set('Location', location);
    return new Response(await response.arrayBuffer(), { status: response.status, headers: outgoing });
  } catch { return Response.json({ code: 'API_UNAVAILABLE', message: '現在接続できません。時間をおいて再度お試しください。' }, { status: 503 }); }
  finally { clearTimeout(timeout); }
}
export const GET = forward;
export const POST = forward;
export const PATCH = forward;
