import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyLineWebhookSignature(rawBody: Buffer, signature: string | undefined, channelSecret: string) {
  if (!signature || !channelSecret || rawBody.length > 2_000_000) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(signature, 'base64'); } catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
