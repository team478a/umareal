import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const productionBase = { APP_BASE_URL: 'https://example.test', ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
const result = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'local' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (result.status === 0 || !result.stderr.includes('Local authentication is forbidden in production')) throw new Error('Production authentication guard did not reject local mode');
console.info('PASS: compiled API refuses local authentication in production.');
const lineOauth = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'test' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (lineOauth.status === 0 || !lineOauth.stderr.includes('Production requires the LINE OAuth transport')) throw new Error('Production LINE OAuth guard did not reject test mode');
console.info('PASS: compiled API refuses the LINE OAuth test transport in production.');
const billing = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'test' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (billing.status === 0 || !billing.stderr.includes('Production requires an external billing transport')) throw new Error('Production billing guard did not reject test mode');
console.info('PASS: compiled API refuses the local billing test transport in production.');
const encryption = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, ENCRYPTION_KEY: '', NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'true' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (encryption.status === 0 || !encryption.stderr.includes('Configure ENCRYPTION_KEY')) throw new Error('Production secret-storage guard did not reject missing encryption configuration');
console.info('PASS: compiled API refuses missing secret-storage encryption.');
const stripeMode = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'false' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (stripeMode.status === 0 || !stripeMode.stderr.includes('Production requires Stripe live mode')) throw new Error('Production billing guard did not reject Stripe test mode');
console.info('PASS: compiled API refuses Stripe test mode in production.');
const mail = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'true', MAIL_TRANSPORT: 'test' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (mail.status === 0 || !mail.stderr.includes('Production requires an external mail transport')) throw new Error('Production mail guard did not reject test mode');
console.info('PASS: compiled API refuses the local mail test transport in production.');
const backup = spawnSync(process.execPath, ['scripts/backup-verify.mjs'], {
  cwd: resolve('.'), env: { ...process.env, NODE_ENV: 'production', AUTH_PROVIDER: 'local' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (backup.status === 0 || !backup.stderr.includes('Local Windows development only')) throw new Error('Production backup guard did not reject local backup mode');
console.info('PASS: backup verification refuses production mode.');
