import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

function equal(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function stagingCredentialsValid(header: string | null, expectedUsername: string, expectedPassword: string) {
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 1) return false;
    return equal(decoded.slice(0, separator), expectedUsername) && equal(decoded.slice(separator + 1), expectedPassword);
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest) {
  if (process.env.LAUNCH_MODE !== 'CLOUD_STAGING') return NextResponse.next();
  const username = process.env.STAGING_ACCESS_USERNAME ?? '';
  const password = process.env.STAGING_ACCESS_PASSWORD ?? '';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(username) || Buffer.byteLength(password) < 24) {
    return new NextResponse('Staging access is not configured.', { status: 503, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  }
  if (!stagingCredentialsValid(request.headers.get('authorization'), username, password)) {
    return new NextResponse('Authentication required.', {
      status: 401,
      headers: { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Basic realm="Umareal Staging", charset="UTF-8"', 'X-Robots-Tag': 'noindex, nofollow' }
    });
  }
  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const config = {
  matcher: ['/((?!health|api/v1/webhooks/line|api/v1/webhooks/stripe|api/v1/webhooks/resend|_next/static|_next/image|favicon.ico).*)']
};
