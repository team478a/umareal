const forwardedRequestHeaderNames = [
  'cookie',
  'content-type',
  'origin',
  'authorization',
  'idempotency-key',
  'range',
  'stripe-signature',
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
