import { describe, expect, it } from 'vitest';
import { apiBaseUrl, mergeResponseCookies, proxyRequestHeaders } from './proxy';

describe('same-origin API proxy', () => {
  it('forwards provider signatures and drops arbitrary request headers', () => {
    const headers = proxyRequestHeaders(new Headers({
      'stripe-signature': 'stripe-signature-value',
      'svix-id': 'message-id',
      'svix-timestamp': '1234567890',
      'svix-signature': 'v1,signature',
      'x-line-signature': 'line-signature-value',
      'x-untrusted-forwarded-header': 'must-not-pass'
    }));
    expect(headers.get('stripe-signature')).toBe('stripe-signature-value');
    expect(headers.get('svix-id')).toBe('message-id');
    expect(headers.get('svix-timestamp')).toBe('1234567890');
    expect(headers.get('svix-signature')).toBe('v1,signature');
    expect(headers.get('x-line-signature')).toBe('line-signature-value');
    expect(headers.has('x-untrusted-forwarded-header')).toBe(false);
  });

  it('uses Basic authorization only at the staging gate and never forwards it to the private API', () => {
    const basic = proxyRequestHeaders(new Headers({ authorization: 'Basic dXNlcjpwYXNzd29yZA==' }));
    const bearer = proxyRequestHeaders(new Headers({ authorization: 'Bearer signed-token' }));
    expect(basic.has('authorization')).toBe(false);
    expect(bearer.get('authorization')).toBe('Bearer signed-token');
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
