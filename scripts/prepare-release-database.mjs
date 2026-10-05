import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const confirmation = 'APPLY_MIGRATIONS_AND_VERIFY_RUNTIME';
const postgresProtocols = new Set(['postgres:', 'postgresql:']);

class ReleaseDatabaseError extends Error {}

function databaseTarget(url) {
  const port = url.port || '5432';
  return `${url.hostname.toLowerCase()}:${port}${decodeURIComponent(url.pathname)}`;
}

function parseConnection(value, label) {
  let url;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new ReleaseDatabaseError(`${label} must be a valid PostgreSQL URL.`);
  }
  if (!postgresProtocols.has(url.protocol)) throw new ReleaseDatabaseError(`${label} must use PostgreSQL.`);
  if (!url.hostname || !url.pathname || url.pathname === '/' || !url.username || !url.password) {
    throw new ReleaseDatabaseError(`${label} must contain a host, database, role, and password.`);
  }
  return url;
}

export function validateReleaseDatabaseEnvironment(env) {
  if (env.DB_RELEASE_CONFIRM !== confirmation) {
    throw new ReleaseDatabaseError(`Set DB_RELEASE_CONFIRM=${confirmation} after API and worker maintenance has been confirmed.`);
  }
  const adminUrl = parseConnection(env.DATABASE_ADMIN_URL, 'DATABASE_ADMIN_URL');
  const runtimeUrl = parseConnection(env.DATABASE_RUNTIME_URL, 'DATABASE_RUNTIME_URL');
  if (databaseTarget(adminUrl) !== databaseTarget(runtimeUrl)) {
    throw new ReleaseDatabaseError('Administrator and runtime connections must target the same database host, port, and database.');
  }
  if (decodeURIComponent(adminUrl.username) === decodeURIComponent(runtimeUrl.username)) {
    throw new ReleaseDatabaseError('Migration owner and runtime database roles must be different.');
  }
  return {
    adminUrl: env.DATABASE_ADMIN_URL,
    runtimeUrl: env.DATABASE_RUNTIME_URL
  };
}

function childEnvironment(source, values) {
  const result = { ...source };
  delete result.DATABASE_ADMIN_URL;
  delete result.DATABASE_RUNTIME_URL;
  delete result.DB_RELEASE_CONFIRM;
  return { ...result, ...values };
}

function pnpmCommand(args, env) {
  if (env.npm_execpath) return { command: process.execPath, args: [env.npm_execpath, ...args] };
  return { command: 'pnpm', args };
}

function runChild(specification) {
  return new Promise((resolve, reject) => {
    const child = spawn(specification.command, specification.args, {
      cwd: specification.cwd,
      env: specification.env,
      stdio: 'inherit',
      shell: false
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new ReleaseDatabaseError(`Release database stage failed (${signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`}).`));
    });
  });
}

export async function prepareReleaseDatabase(input = {}) {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const execute = input.execute ?? runChild;
  const log = input.log ?? (message => console.info(message));
  const connections = validateReleaseDatabaseEnvironment(env);
  const migration = pnpmCommand(['--filter', '@keiba/db', 'migrate'], env);
  const verification = pnpmCommand(['db:access:verify'], env);

  log('Release database 1/2: applying pending migrations with the ephemeral migration-owner connection.');
  await execute({
    ...migration,
    cwd,
    env: childEnvironment(env, { DATABASE_URL: connections.adminUrl })
  });

  log('Release database 2/2: verifying the restricted runtime role against every table.');
  await execute({
    ...verification,
    cwd,
    env: childEnvironment(env, {
      DATABASE_URL: connections.runtimeUrl,
      DATABASE_RUNTIME_URL: connections.runtimeUrl
    })
  });

  log('Release database is ready. Deploy API, Web, and worker, then run the release verification command.');
}

async function main() {
  await prepareReleaseDatabase();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof ReleaseDatabaseError ? error.message : 'Release database preparation failed.');
    process.exitCode = 1;
  });
}
