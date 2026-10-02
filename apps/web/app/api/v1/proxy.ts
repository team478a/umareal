const forwardedRequestHeaderNames = [
  'cookie',
  'content-type',
  'origin',
  'authorization',
  'idempotency-key',
  'range',
  'stripe-signature',
  'svix-id',
  'svix-timestamp',
  'svix-signature',
  'x-line-signature'
] as const;

export function proxyRequestHeaders(source: Headers) {
  const headers = new Headers();
  for (const key of forwardedRequestHeaderNames) {
    const value = source.get(key);
    if (key === 'authorization' && value && /^Basic\s/i.test(value)) continue;
    if (value) headers.set(key, value);
  }
  return headers;
}

export function apiBaseUrl(value = process.env.API_BASE_URL) {
  const raw = value?.trim() || 'http://127.0.0.1:4000';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('API_BASE_URL must be an HTTP(S) origin');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function mergeResponseCookies(cookieHeader: string | null, setCookies: string[]) {
  const values = new Map<string, string>();
  for (const part of (cookieHeader ?? '').split(';')) {
    const trimmed = part.trim(); const separator = trimmed.indexOf('=');
    if (separator > 0) values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  for (const cookie of setCookies) {
    const first = cookie.split(';', 1)[0]; const separator = first.indexOf('=');
    if (separator > 0) values.set(first.slice(0, separator), first.slice(separator + 1));
  }
  return [...values].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function shouldRefreshSession(path: string[], status: number, cookieHeader: string | null, responseBody?: unknown) {
  if (status !== 401 || !cookieHeader?.includes('keiba_refresh_token=')) return false;
  if (path[0] !== 'auth') return true;
  if (path.join('/') !== 'auth/mfa/verify' || !responseBody || typeof responseBody !== 'object') return false;
  const code = 'code' in responseBody ? responseBody.code : undefined;
  const message = 'message' in responseBody ? responseBody.message : undefined;
  return code === 'SESSION_EXPIRED' || (code === undefined && message === 'Unauthorized');
}
