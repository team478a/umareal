import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { createRequire } from 'node:module';
config({ quiet: true });
if (process.platform !== 'win32' || process.env.AUTH_PROVIDER !== 'local' || process.env.NODE_ENV === 'production') throw new Error('Windows local development only');
const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55432' || url.pathname !== '/keiba') throw new Error('Expected isolated local database at 127.0.0.1:55432/keiba');
const base = resolve('.local/postgres');
const bin = resolve(base, 'node_modules/@embedded-postgres/windows-x64/native/bin');
const data = resolve(base, 'data');
function run(name, args, extra = {}) {
  const result = spawnSync(resolve(bin, `${name}.exe`), args, { encoding: 'utf8', windowsHide: true, timeout: 60000, ...extra });
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr ?? result.error ?? ''}`);
  return result;
}
if (process.argv[2] === 'stop') {
  if (existsSync(resolve(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  console.info('Local PostgreSQL stopped; data retained.');
} else if (process.argv[2] === 'start') {
  mkdirSync(base, { recursive: true });
  if (!existsSync(resolve(data, 'PG_VERSION'))) {
    const passwordFile = resolve(base, 'init-password');
    writeFileSync(passwordFile, decodeURIComponent(url.password), { mode: 0o600 });
    try { run('initdb', ['-D', data, '-U', 'keiba', '-A', 'scram-sha-256', '--encoding=UTF8', '--locale=C', `--pwfile=${passwordFile}`]); }
    finally { unlinkSync(passwordFile); }
    appendFileSync(resolve(data, 'postgresql.conf'), "\nlisten_addresses = '127.0.0.1'\nport = 55432\n");
  }
  const status = spawnSync(resolve(bin, 'pg_ctl.exe'), ['-D', data, 'status'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (status.status !== 0) run('pg_ctl', ['-D', data, '-l', resolve(base, 'server.log'), '-w', 'start']);
  const require = createRequire(resolve('packages/db/package.json'));
  const { PrismaClient } = require('@prisma/client');
  const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
  const db = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    const found = await db.$queryRaw`SELECT 1 FROM pg_database WHERE datname='keiba'`;
    if (!found.length) await db.$executeRawUnsafe('CREATE DATABASE "keiba"');
  } finally { await db.$disconnect(); }
  console.info('Local PostgreSQL ready at 127.0.0.1:55432; credentials were not printed.');
} else throw new Error('Usage: node scripts/local-postgres.mjs start|stop');
