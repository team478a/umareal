import { NextRequest } from 'next/server';
import { apiBaseUrl, mergeResponseCookies, proxyRequestHeaders } from '../proxy';
export const dynamic = 'force-dynamic';
async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  if (path.some(p => !/^[a-zA-Z0-9_-]+$/.test(p))) return Response.json({ code: 'NOT_FOUND', message: 'ページが見つかりません。' }, { status: 404 });
  const headers = proxyRequestHeaders(request.headers);
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const target = `${apiBaseUrl()}/api/v1/${path.join('/')}${request.nextUrl.search}`;
    const send = (requestHeaders: Headers) => fetch(target, {
      method: request.method, headers: requestHeaders, cache: 'no-store', redirect: 'manual', signal: controller.signal,
      body
    });
    let response = await send(headers);
    let refreshCookies: string[] = [];
    if (response.status === 401 && path[0] !== 'auth' && request.headers.get('cookie')?.includes('keiba_refresh_token=')) {
      const refreshHeaders = new Headers(headers); refreshHeaders.set('Origin', request.nextUrl.origin); refreshHeaders.set('Content-Type', 'application/json');
      const refreshed = await fetch(`${apiBaseUrl()}/api/v1/auth/refresh`, { method: 'POST', headers: refreshHeaders, body: '{}', cache: 'no-store', signal: controller.signal });
      refreshCookies = refreshed.headers.getSetCookie();
      if (refreshed.ok) {
        const retryHeaders = new Headers(headers); retryHeaders.set('Cookie', mergeResponseCookies(request.headers.get('cookie'), refreshCookies));
        response = await send(retryHeaders);
      }
    }
    const outgoing = new Headers({ 'Content-Type': response.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' });
    for (const refreshedCookie of refreshCookies) outgoing.append('Set-Cookie', refreshedCookie);
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
