import { describe, expect, it } from 'vitest';
import { apiBaseUrl, mergeResponseCookies, proxyRequestHeaders } from './proxy';

describe('same-origin API proxy', () => {
  it('forwards provider signatures and drops arbitrary request headers', () => {
    const headers = proxyRequestHeaders(new Headers({
      'stripe-signature': 'stripe-signature-value',
      'x-line-signature': 'line-signature-value',
      'x-untrusted-forwarded-header': 'must-not-pass'
    }));
    expect(headers.get('stripe-signature')).toBe('stripe-signature-value');
    expect(headers.get('x-line-signature')).toBe('line-signature-value');
    expect(headers.has('x-untrusted-forwarded-header')).toBe(false);
  });

  it('accepts a private host and port from a hosting platform', () => {
    expect(apiBaseUrl('umareal-api:10000')).toBe('http://umareal-api:10000');
    expect(apiBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
  });

  it('rejects credentials embedded in the backend URL', () => {
    expect(() => apiBaseUrl('https://user:secret@api.example.com')).toThrow('API_BASE_URL');
  });

  it('merges rotated authentication cookies without forwarding cookie attributes', () => {
    expect(mergeResponseCookies('theme=dark; keiba_access_token=old', [
      'keiba_access_token=new-token; Path=/; HttpOnly',
      'keiba_refresh_token=new-refresh; Path=/; HttpOnly'
    ])).toBe('theme=dark; keiba_access_token=new-token; keiba_refresh_token=new-refresh');
  });
});
