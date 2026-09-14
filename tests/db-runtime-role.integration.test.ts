import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { databaseRuntimeAccessRestricted, PrismaClient } from '../packages/db/src';
import { afterAll, describe, expect, it } from 'vitest';
import { account, db } from './helpers';

const root = resolve(__dirname, '..');
const role = `runtime_${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('base64url');
const adminUrl = process.env.DATABASE_URL!;
const runtimeUrl = new URL(adminUrl);
runtimeUrl.username = role;
runtimeUrl.password = password;
const runtimeValue = runtimeUrl.toString();

function quoted(value: string) { return `"${value.replaceAll('"', '""')}"`; }

describe('least-privilege database runtime role', () => {
  afterAll(async () => {
    const [identity] = await db.$queryRaw<{ user: string; database: string }[]>`SELECT current_user::text AS "user", current_database()::text AS "database"`;
    const found = await db.$queryRaw<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${role}) AS "exists"`;
    if (!found[0]?.exists) return;
    const runtime = quoted(role);
    const owner = quoted(identity.user);
    const database = quoted(identity.database);
    await db.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL ON TABLES FROM ${runtime}`);
    await db.$executeRawUnsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${runtime}`);
    await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${runtime}`);
    await db.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${runtime}`);
    await db.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${runtime}`);
    await db.$executeRawUnsafe(`REVOKE ALL ON DATABASE ${database} FROM ${runtime}`);
    await db.$executeRawUnsafe(`DROP ROLE ${runtime}`);
  });

  it('configures CRUD without ownership, DDL or trigger control', async () => {
    expect(await databaseRuntimeAccessRestricted(db)).toBe(false);
    const configured = spawnSync(process.execPath, ['scripts/db-runtime-role.mjs', 'configure'], {
      cwd: root,
      env: { ...process.env, DATABASE_ADMIN_URL: adminUrl, DATABASE_RUNTIME_URL: runtimeValue, DB_ROLE_CONFIRM: 'CONFIGURE_RUNTIME_ROLE' },
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true
    });
    expect(configured.status, configured.stderr).toBe(0);
    expect(`${configured.stdout}${configured.stderr}`).not.toContain(password);
    expect(`${configured.stdout}${configured.stderr}`).not.toContain(adminUrl);
    expect(`${configured.stdout}${configured.stderr}`).not.toContain(runtimeValue);

    const fixture = await account('ADMIN');
    const audit = await db.auditLog.create({ data: { actorId: fixture.user.id, actorRole: 'ADMIN', action: 'DB_RUNTIME_ROLE_TEST', targetType: 'USER', targetId: fixture.user.id, reason: '権限分離検証', details: {}, requestId: randomUUID() } });
    const runtime = new PrismaClient({ datasources: { db: { url: runtimeValue } } });
    try {
      expect(await databaseRuntimeAccessRestricted(runtime)).toBe(true);
      expect((await runtime.user.findUnique({ where: { id: fixture.user.id } }))?.id).toBe(fixture.user.id);
      const [privileges] = await runtime.$queryRaw<{ create: boolean; truncate: boolean; trigger: boolean }[]>`
        SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS create,
          has_table_privilege(current_user, 'public.audit_logs', 'TRUNCATE') AS truncate,
          has_table_privilege(current_user, 'public.audit_logs', 'TRIGGER') AS trigger
      `;
      expect(privileges).toEqual({ create: false, truncate: false, trigger: false });
      await expect(runtime.$executeRaw`UPDATE "audit_logs" SET "reason" = '改ざん' WHERE "id" = ${audit.id}`).rejects.toThrow();
      expect((await db.auditLog.findUniqueOrThrow({ where: { id: audit.id } })).reason).toBe('権限分離検証');
    } finally {
      await runtime.$disconnect();
    }

    const verified = spawnSync(process.execPath, ['scripts/db-runtime-role.mjs', 'verify'], {
      cwd: root,
      env: { ...process.env, DATABASE_RUNTIME_URL: runtimeValue },
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true
    });
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain('ownership and elevated privileges are absent');
  });
});
