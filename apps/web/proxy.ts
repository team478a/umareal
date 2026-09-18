import { NextResponse } from 'next/server';

export function proxy() {
  if (!['CLOUD_STAGING', 'STRIPE_SANDBOX'].includes(process.env.LAUNCH_MODE ?? '')) return NextResponse.next();
  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}

export const config = {
  matcher: ['/((?!health|api/v1/webhooks/line|api/v1/webhooks/stripe|api/v1/webhooks/resend|_next/static|_next/image|favicon.ico).*)']
};
