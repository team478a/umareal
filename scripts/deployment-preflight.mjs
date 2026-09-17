const services = ['api', 'web', 'worker'];
const forbiddenPersistentVariables = ['DATABASE_ADMIN_URL', 'DIRECT_DATABASE_URL', 'LOCAL_DB_PASSWORD', 'SUPABASE_SERVICE_ROLE_KEY'];

function present(value) { return typeof value === 'string' && value.trim().length > 0; }
function origin(value, protocols) {
  try {
    const parsed = new URL(value ?? '');
    return protocols.includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch { return false; }
}
function privateHttpOrigin(value) {
  const raw = value?.trim();
  if (!raw) return false;
  return origin(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`, ['http:', 'https:']);
}
function postgres(value) {
  try { return ['postgres:', 'postgresql:'].includes(new URL(value ?? '').protocol); } catch { return false; }
}
function emailFrom(value) { return present(value) && /<[^<>\s@]+@[^<>\s@]+>|^[^\s@]+@[^\s@]+$/.test(value.trim()); }

export function validateDeploymentEnvironment(service, env) {
  if (!services.includes(service)) throw new Error(`service must be one of: ${services.join(', ')}`);
  const errors = []; const manual = [];
  const requireValue = (code, condition, message) => { if (!condition) errors.push({ code, message }); };

  requireValue('NODE_ENV', env.NODE_ENV === 'production', 'NODE_ENV must be production.');
  for (const key of forbiddenPersistentVariables) requireValue(`FORBIDDEN_${key}`, !present(env[key]), `${key} must not be stored on a persistent service.`);

  if (service === 'web') {
    requireValue('API_BASE_URL', privateHttpOrigin(env.API_BASE_URL), 'API_BASE_URL must be an HTTP(S) origin or private host:port without credentials or a path.');
    const webLaunchMode = env.LAUNCH_MODE ?? null;
    if (present(webLaunchMode)) requireValue('LAUNCH_MODE', ['CLOUD_STAGING', 'FREE_REGISTRATION', 'FULL'].includes(webLaunchMode), 'LAUNCH_MODE must be CLOUD_STAGING, FREE_REGISTRATION or FULL.');
    if (webLaunchMode === 'CLOUD_STAGING') manual.push({ code: 'STAGING_NOINDEX', message: 'Confirm that page and same-origin API responses include no-store and X-Robots-Tag: noindex, nofollow.' });
    manual.push({ code: 'WEB_CUSTOM_DOMAIN', message: 'Confirm the custom domain, TLS certificate, and /health response in the hosting dashboard.' });
    return { service, launchMode: webLaunchMode, ok: errors.length === 0, errors, manual };
  }

  const launchMode = env.LAUNCH_MODE;
  requireValue('LAUNCH_MODE', ['CLOUD_STAGING', 'FREE_REGISTRATION', 'FULL'].includes(launchMode), 'LAUNCH_MODE must be CLOUD_STAGING, FREE_REGISTRATION or FULL.');
  requireValue('DATABASE_URL', postgres(env.DATABASE_URL), 'DATABASE_URL must be a PostgreSQL runtime connection URL.');
  requireValue('APP_BASE_URL', origin(env.APP_BASE_URL, ['https:']), 'APP_BASE_URL must be an HTTPS origin without credentials or a path.');
  requireValue('ENCRYPTION_KEY', Buffer.from(env.ENCRYPTION_KEY ?? '', 'base64').length === 32, 'ENCRYPTION_KEY must decode to exactly 32 bytes.');
  requireValue('MAIL_TRANSPORT', env.MAIL_TRANSPORT === 'resend', 'MAIL_TRANSPORT must be resend.');
  requireValue('RESEND_API_KEY', present(env.RESEND_API_KEY), 'RESEND_API_KEY is required for initial mail delivery.');
  requireValue('MAIL_FROM', emailFrom(env.MAIL_FROM), 'MAIL_FROM must contain a valid sender address.');

  const limitedLaunch = launchMode !== 'FULL';
  requireValue('NOTIFICATION_TRANSPORT', env.NOTIFICATION_TRANSPORT === (limitedLaunch ? 'disabled' : 'line'), `NOTIFICATION_TRANSPORT must be ${limitedLaunch ? 'disabled' : 'line'} for ${launchMode ?? 'the selected launch mode'}.`);

  if (service === 'worker') {
    manual.push({ code: 'DATABASE_RUNTIME_ROLE', message: 'Verify that DATABASE_URL uses the restricted runtime role.' });
    manual.push({ code: 'WORKER_OBSERVABILITY', message: 'Confirm worker startup, graceful shutdown, alert delivery, and log retention.' });
    return { service, launchMode, ok: errors.length === 0, errors, manual };
  }

  requireValue('AUTH_PROVIDER', env.AUTH_PROVIDER === 'supabase', 'AUTH_PROVIDER must be supabase.');
  requireValue('ADMIN_BASE_URL', origin(env.ADMIN_BASE_URL, ['https:']), 'ADMIN_BASE_URL must be an HTTPS origin without credentials or a path.');
  requireValue('SUPABASE_URL', origin(env.SUPABASE_URL, ['https:']), 'SUPABASE_URL must be an HTTPS origin.');
  requireValue('SUPABASE_ANON_KEY', present(env.SUPABASE_ANON_KEY), 'SUPABASE_ANON_KEY is required.');
  requireValue('JOB_SECRET', Buffer.byteLength(env.JOB_SECRET ?? '') >= 32, 'JOB_SECRET must contain at least 32 bytes.');
  requireValue('RESEND_WEBHOOK_SECRET', present(env.RESEND_WEBHOOK_SECRET), 'RESEND_WEBHOOK_SECRET is required.');
  requireValue('CAPTCHA_TRANSPORT', env.CAPTCHA_TRANSPORT === 'turnstile', 'CAPTCHA_TRANSPORT must be turnstile.');
  requireValue('LINE_OAUTH_TRANSPORT', env.LINE_OAUTH_TRANSPORT === (limitedLaunch ? 'disabled' : 'line'), `LINE_OAUTH_TRANSPORT must be ${limitedLaunch ? 'disabled' : 'line'} for ${launchMode ?? 'the selected launch mode'}.`);
  requireValue('BILLING_TRANSPORT', env.BILLING_TRANSPORT === (limitedLaunch ? 'disabled' : 'stripe'), `BILLING_TRANSPORT must be ${limitedLaunch ? 'disabled' : 'stripe'} for ${launchMode ?? 'the selected launch mode'}.`);
  requireValue('STRIPE_LIVE_MODE', env.STRIPE_LIVE_MODE === (limitedLaunch ? 'false' : 'true'), `STRIPE_LIVE_MODE must be ${limitedLaunch ? 'false' : 'true'} for ${launchMode ?? 'the selected launch mode'}.`);
  const rateLimit = Number(env.AUTH_RATE_LIMIT);
  requireValue('AUTH_RATE_LIMIT', Number.isInteger(rateLimit) && rateLimit >= 1 && rateLimit <= 60, 'AUTH_RATE_LIMIT must be an integer from 1 to 60.');
  manual.push({ code: 'DATABASE_RUNTIME_ROLE', message: 'Verify that DATABASE_URL uses the restricted runtime role.' });
  manual.push(launchMode === 'CLOUD_STAGING'
    ? { code: 'STAGING_DRAFT_LEGAL_ONLY', message: 'Draft legal documents are allowed only for the staging test environment; never use this mode for public recruitment.' }
    : { code: 'LEGAL_RELEASE', message: 'Confirm that reviewed legal documents are published in the application.' });
  manual.push({ code: 'PROVIDER_LIVE_TESTS', message: `Complete Supabase, Resend, and Turnstile live tests${limitedLaunch ? '.' : ', plus LINE and Stripe live tests.'}` });
  return { service, launchMode, ok: errors.length === 0, errors, manual };
}

function print(result) {
  console.info(`Deployment preflight: ${result.service} / ${result.launchMode ?? 'n/a'}`);
  for (const item of result.errors) console.error(`BLOCKED ${item.code}: ${item.message}`);
  for (const item of result.manual) console.info(`MANUAL ${item.code}: ${item.message}`);
  console.info(result.ok ? 'Configuration shape is ready for manual review.' : `${result.errors.length} configuration issue(s) must be resolved.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = process.argv[2];
  try { const result = validateDeploymentEnvironment(service, process.env); print(result); if (!result.ok) process.exitCode = 1; }
  catch (error) { console.error(error instanceof Error ? error.message : 'Deployment preflight failed.'); process.exitCode = 1; }
}
import { pathToFileURL } from 'node:url';
