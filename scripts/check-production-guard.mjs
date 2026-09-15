import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const productionBase = { APP_BASE_URL: 'https://example.test', ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'test-anon-key', LAUNCH_MODE: 'FULL', CAPTCHA_TRANSPORT: 'turnstile' };
const launchMode = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, LAUNCH_MODE: '', NODE_ENV: 'production', AUTH_PROVIDER: 'supabase' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (launchMode.status === 0 || !launchMode.stderr.includes('Set LAUNCH_MODE explicitly in production')) throw new Error('Production launch mode guard did not require an explicit mode');
console.info('PASS: compiled API requires an explicit production launch mode.');
const result = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'local' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (result.status === 0 || !result.stderr.includes('Local authentication is forbidden in production')) throw new Error('Production authentication guard did not reject local mode');
console.info('PASS: compiled API refuses local authentication in production.');
const lineOauth = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'test' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (lineOauth.status === 0 || !lineOauth.stderr.includes('Full production launch requires the LINE OAuth transport')) throw new Error('Production LINE OAuth guard did not reject test mode');
console.info('PASS: compiled API refuses the LINE OAuth test transport in production.');
const billing = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'test' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (billing.status === 0 || !billing.stderr.includes('Full production launch requires an external billing transport')) throw new Error('Production billing guard did not reject test mode');
console.info('PASS: compiled API refuses the local billing test transport in production.');
const encryption = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, ENCRYPTION_KEY: '', NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'true' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (encryption.status === 0 || !encryption.stderr.includes('Configure ENCRYPTION_KEY')) throw new Error('Production secret-storage guard did not reject missing encryption configuration');
console.info('PASS: compiled API refuses missing secret-storage encryption.');
const stripeMode = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'false' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (stripeMode.status === 0 || !stripeMode.stderr.includes('Full production launch requires Stripe live mode')) throw new Error('Production billing guard did not reject Stripe test mode');
console.info('PASS: compiled API refuses Stripe test mode in production.');
const mail = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'true', MAIL_TRANSPORT: 'test' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (mail.status === 0 || !mail.stderr.includes('Production requires an external mail transport')) throw new Error('Production mail guard did not reject test mode');
console.info('PASS: compiled API refuses the local mail test transport in production.');
const captcha = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'true', MAIL_TRANSPORT: 'resend', CAPTCHA_TRANSPORT: 'test' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (captcha.status === 0 || !captcha.stderr.includes('Production requires the Turnstile CAPTCHA transport')) throw new Error('Production CAPTCHA guard did not reject test mode');
console.info('PASS: compiled API refuses the local CAPTCHA test transport in production.');
const legalDocuments = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'line', LINE_OAUTH_TRANSPORT: 'line', BILLING_TRANSPORT: 'stripe', STRIPE_LIVE_MODE: 'true', MAIL_TRANSPORT: 'resend' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (legalDocuments.status === 0 || !legalDocuments.stderr.includes('Production requires published legal documents')) throw new Error('Production legal-document guard did not reject draft documents');
console.info('PASS: compiled API refuses draft legal documents in production.');
const freeRegistration = spawnSync(process.execPath, ['dist/main.js'], {
  cwd: resolve('apps/api'), env: { ...process.env, ...productionBase, LAUNCH_MODE: 'FREE_REGISTRATION', NODE_ENV: 'production', AUTH_PROVIDER: 'supabase', NOTIFICATION_TRANSPORT: 'disabled', LINE_OAUTH_TRANSPORT: 'disabled', BILLING_TRANSPORT: 'disabled', STRIPE_LIVE_MODE: 'false', MAIL_TRANSPORT: 'resend' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (freeRegistration.status === 0 || !freeRegistration.stderr.includes('Production requires published legal documents') || freeRegistration.stderr.includes('requires the LINE') || freeRegistration.stderr.includes('requires an external billing')) throw new Error('Free registration launch did not bypass disabled LINE and billing dependencies safely');
console.info('PASS: free registration production mode accepts disabled LINE and billing transports.');
const backup = spawnSync(process.execPath, ['scripts/backup-verify.mjs'], {
  cwd: resolve('.'), env: { ...process.env, NODE_ENV: 'production', AUTH_PROVIDER: 'local' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (backup.status === 0 || !backup.stderr.includes('Local Windows development only')) throw new Error('Production backup guard did not reject local backup mode');
console.info('PASS: backup verification refuses production mode.');
const bootstrap = spawnSync(process.execPath, ['scripts/bootstrap-admin.mjs'], {
  cwd: resolve('.'), env: { ...process.env, AUTH_PROVIDER: 'supabase', BOOTSTRAP_CONFIRM: '', BOOTSTRAP_ADMIN_SUBJECT: '123e4567-e89b-42d3-a456-426614174000', BOOTSTRAP_ADMIN_EMAIL: 'admin@example.test' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (bootstrap.status === 0 || !bootstrap.stderr.includes('Set BOOTSTRAP_CONFIRM=CREATE_FIRST_ADMIN')) throw new Error('Initial administrator bootstrap did not require explicit one-time confirmation');
console.info('PASS: initial administrator bootstrap requires explicit one-time confirmation.');
const databaseRole = spawnSync(process.execPath, ['scripts/db-runtime-role.mjs', 'configure'], {
  cwd: resolve('.'), env: { ...process.env, DATABASE_ADMIN_URL: 'postgresql://owner:secret@example.test/app', DATABASE_RUNTIME_URL: 'postgresql://runtime:secret@example.test/app', DB_ROLE_CONFIRM: '' },
  encoding: 'utf8', timeout: 10000, windowsHide: true
});
if (databaseRole.status === 0 || !databaseRole.stderr.includes('Set DB_ROLE_CONFIRM=CONFIGURE_RUNTIME_ROLE')) throw new Error('Database role configuration did not require explicit one-time confirmation');
console.info('PASS: database role configuration requires explicit one-time confirmation.');
const workerMail = spawnSync(process.execPath, ['dist/index.js', '--once'], {
  cwd: resolve('apps/worker'), env: { ...process.env, NODE_ENV: 'production', LAUNCH_MODE: 'FULL', NOTIFICATION_TRANSPORT: 'line', MAIL_TRANSPORT: 'test' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (workerMail.status === 0 || !workerMail.stderr.includes('Production requires the Resend email transport')) throw new Error('Production worker mail guard did not reject the test transport');
console.info('PASS: production worker refuses the local mail test transport.');
const workerDatabaseRole = spawnSync(process.execPath, ['dist/index.js', '--once'], {
  cwd: resolve('apps/worker'), env: { ...process.env, NODE_ENV: 'production', LAUNCH_MODE: 'FULL', NOTIFICATION_TRANSPORT: 'line', MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'test-resend-key', MAIL_FROM: 'notice@example.test' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (workerDatabaseRole.status === 0 || !workerDatabaseRole.stderr.includes('Production requires a restricted database runtime role')) throw new Error('Production worker database guard did not reject the owner connection');
console.info('PASS: production worker refuses a database owner connection.');
const freeWorkerDatabaseRole = spawnSync(process.execPath, ['dist/index.js', '--once'], {
  cwd: resolve('apps/worker'), env: { ...process.env, NODE_ENV: 'production', LAUNCH_MODE: 'FREE_REGISTRATION', NOTIFICATION_TRANSPORT: 'disabled', MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 'test-resend-key', MAIL_FROM: 'notice@example.test' },
  encoding: 'utf8', timeout: 20000, windowsHide: true
});
if (freeWorkerDatabaseRole.status === 0 || !freeWorkerDatabaseRole.stderr.includes('Production requires a restricted database runtime role') || freeWorkerDatabaseRole.stderr.includes('requires the LINE notification transport')) throw new Error('Free registration worker did not accept disabled LINE transport safely');
console.info('PASS: free registration worker accepts disabled LINE and still enforces database access.');
