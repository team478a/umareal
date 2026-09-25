import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../packages/db/src';

const root = resolve('.');
const databaseName = `keiba_bootstrap_${randomBytes(6).toString('hex')}`;
let adminDb: PrismaClient;
let isolatedDb: PrismaClient;
let isolatedUrl = '';

function command(program: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(program, args, { cwd: root, env, encoding: 'utf8', timeout: 90_000, windowsHide: true });
}

beforeAll(async () => {
  const source = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(source.hostname)) throw new Error('Bootstrap integration test is limited to a local development database');
  const administration = new URL(source); administration.pathname = '/postgres'; administration.search = '';
  adminDb = new PrismaClient({ datasourceUrl: administration.toString() });
  await adminDb.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
  const target = new URL(source); target.pathname = `/${databaseName}`; target.search = '';
  isolatedUrl = target.toString();
  const migrated = command(process.execPath, ['packages/db/node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema', 'packages/db/prisma/schema.prisma'], { ...process.env, DATABASE_URL: isolatedUrl });
  if (migrated.status !== 0) throw new Error(`Could not migrate the isolated bootstrap database (${migrated.error?.message ?? `exit ${migrated.status}`})`);
  isolatedDb = new PrismaClient({ datasourceUrl: isolatedUrl });
}, 90_000);

afterAll(async () => {
  await isolatedDb?.$disconnect();
  if (adminDb) {
    await adminDb.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}'`);
    await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await adminDb.$disconnect();
  }
});

describe('initial administrator bootstrap', () => {
  it('promotes exactly one verified Supabase member, audits it, and refuses replay', async () => {
    const subject = randomUUID();
    const email = `first-admin-${randomBytes(5).toString('hex')}@example.test`;
    const user = await isolatedDb.user.create({ data: { authSubject: subject, email, emailVerifiedAt: new Date(), displayName: '初回管理者候補', registrationMethod: 'EMAIL', preferences: { create: {} } } });
    const env = { ...process.env, DATABASE_URL: isolatedUrl, AUTH_PROVIDER: 'supabase', BOOTSTRAP_ADMIN_SUBJECT: subject, BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_CONFIRM: 'CREATE_FIRST_ADMIN' };
    const first = command(process.execPath, ['scripts/bootstrap-admin.mjs'], env);
    expect(first.status, first.stderr).toBe(0);
    expect((await isolatedDb.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('ADMIN');
    expect(await isolatedDb.auditLog.count({ where: { targetId: user.id, action: 'INITIAL_ADMIN_BOOTSTRAP', actorRole: 'ADMIN' } })).toBe(1);
    const replay = command(process.execPath, ['scripts/bootstrap-admin.mjs'], env);
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain('An enabled administrator already exists');
    expect(await isolatedDb.auditLog.count({ where: { targetId: user.id, action: 'INITIAL_ADMIN_BOOTSTRAP' } })).toBe(1);
  });
});
