import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function encryptionKey() {
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must contain 32 base64-encoded bytes');
  return key;
}
export function encryptSecret(text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const result = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), result].map(value => value.toString('base64')).join('.');
}
export function decryptSecret(value: string) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Encrypted secret has an invalid format');
  const [iv, tag, data] = parts.map(part => Buffer.from(part, 'base64'));
  if (iv.length !== 12 || tag.length !== 16 || !data.length) throw new Error('Encrypted secret has an invalid format');
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
}
