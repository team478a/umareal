import { describe, expect, it } from 'vitest';
import { verifyLineWebhookSignature } from './line-webhook';

describe('LINE webhook signature preparation', () => {
  const secret = '8c570fa6dd201bb328f1c1eac23a96d8';
  const body = Buffer.from('{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}');
  it('accepts the official sample signature for the exact raw request bytes', () => {
    const signature = 'GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs=';
    expect(verifyLineWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifyLineWebhookSignature(Buffer.from(`${body.toString()} `), signature, secret)).toBe(false);
  });
  it('rejects missing, malformed and oversized input without throwing', () => {
    expect(verifyLineWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyLineWebhookSignature(body, 'invalid', secret)).toBe(false);
    expect(verifyLineWebhookSignature(Buffer.alloc(2_000_001), 'invalid', secret)).toBe(false);
  });
});
