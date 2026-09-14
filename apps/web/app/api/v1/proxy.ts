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
