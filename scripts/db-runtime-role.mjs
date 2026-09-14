import { config } from 'dotenv';
import { PrismaClient } from '../packages/db/dist/index.js';

config({ path: '.env', quiet: true });

class DbAccessError extends Error {}

function connectionInput() {
  if (!['configure', 'verify'].includes(process.argv[2] ?? '')) throw new DbAccessError('Usage: node scripts/db-runtime-role.mjs configure|verify');
  const adminValue = process.env.DATABASE_ADMIN_URL;
  const runtimeValue = process.env.DATABASE_RUNTIME_URL;
  if (process.argv[2] === 'configure' && process.env.DB_ROLE_CONFIRM !== 'CONFIGURE_RUNTIME_ROLE') throw new DbAccessError('Set DB_ROLE_CONFIRM=CONFIGURE_RUNTIME_ROLE for this one-time operation.');
  if (!runtimeValue) throw new DbAccessError('Set DATABASE_RUNTIME_URL to the application database connection.');
  if (process.argv[2] === 'configure' && !adminValue) throw new DbAccessError('Set DATABASE_ADMIN_URL to the migration-owner connection.');
  let adminUrl;
  let runtimeUrl;
  try {
    adminUrl = adminValue ? new URL(adminValue) : null;
    runtimeUrl = new URL(runtimeValue);
  } catch {
    throw new DbAccessError('Database connection settings must be valid PostgreSQL URLs.');
  }
  if (![adminUrl?.protocol, runtimeUrl.protocol].filter(Boolean).every(protocol => ['postgres:', 'postgresql:'].includes(protocol))) throw new DbAccessError('Database connection settings must use PostgreSQL.');
  const role = decodeURIComponent(runtimeUrl.username);
  const password = decodeURIComponent(runtimeUrl.password);
  if (!role || role.length > 63 || !password) throw new DbAccessError('The runtime connection must contain a role and password.');
  if (adminUrl && decodeURIComponent(adminUrl.pathname) !== decodeURIComponent(runtimeUrl.pathname)) throw new DbAccessError('Administrator and runtime connections must target the same database.');
  return { mode: process.argv[2], adminValue, runtimeValue, role, password };
}

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function roleState(db, role) {
  const rows = await db.$queryRaw`
    SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = ${role}
  `;
  return rows[0] ?? null;
}

async function assertRestrictedRole(db, role) {
  const state = await roleState(db, role);
  if (!state) throw new DbAccessError('The runtime database role does not exist.');
  if (state.rolsuper || state.rolcreatedb || state.rolcreaterole || state.rolreplication || state.rolbypassrls) throw new DbAccessError('The runtime database role has forbidden elevated attributes.');
  const memberships = await db.$queryRaw`
    SELECT parent.rolname
    FROM pg_roles parent
    WHERE parent.rolname <> ${role} AND pg_has_role(${role}, parent.oid, 'MEMBER')
  `;
  if (memberships.length) throw new DbAccessError('The runtime database role must not inherit or assume another role.');
  const ownership = await db.$queryRaw`
    SELECT
      (SELECT count(*)::int FROM pg_class object JOIN pg_namespace namespace ON namespace.oid = object.relnamespace WHERE namespace.nspname = 'public' AND object.relowner = role.oid) AS relations,
      (SELECT count(*)::int FROM pg_namespace namespace WHERE namespace.nspname = 'public' AND namespace.nspowner = role.oid) AS schemas
    FROM pg_roles role WHERE role.rolname = ${role}
  `;
  if (!ownership.length || ownership[0].relations !== 0 || ownership[0].schemas !== 0) throw new DbAccessError('The runtime database role must not own public schema objects.');
}

async function configureRole(input) {
  const admin = new PrismaClient({ datasources: { db: { url: input.adminValue } } });
  try {
    const [identity] = await admin.$queryRaw`SELECT current_user::text AS "user", current_database()::text AS "database"`;
    if (!identity || identity.user === input.role) throw new DbAccessError('The migration owner and runtime database role must be different.');
    const [ownership] = await admin.$queryRaw`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE tableowner = current_user)::int AS owned
      FROM pg_tables WHERE schemaname = 'public'
    `;
    if (!ownership || ownership.total === 0 || ownership.total !== ownership.owned) throw new DbAccessError('The administrator connection must own every public table before access is granted.');
    if (!await roleState(admin, input.role)) {
      const [formatted] = await admin.$queryRaw`SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L', ${input.role}, ${input.password}) AS statement`;
      await admin.$executeRawUnsafe(formatted.statement);
    }
    await assertRestrictedRole(admin, input.role);
    const runtime = identifier(input.role);
    const owner = identifier(identity.user);
    const database = identifier(identity.database);
    const statements = [
      `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
      `REVOKE ALL ON SCHEMA public FROM ${runtime}`,
      `GRANT USAGE ON SCHEMA public TO ${runtime}`,
      `GRANT CONNECT ON DATABASE ${database} TO ${runtime}`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${runtime}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${runtime}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL ON TABLES FROM ${runtime}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${runtime}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${runtime}`
    ];
    await admin.$transaction(statements.map(statement => admin.$executeRawUnsafe(statement)));
  } finally {
    await admin.$disconnect();
  }
}

async function verifyRole(input) {
  const runtime = new PrismaClient({ datasources: { db: { url: input.runtimeValue } } });
  try {
    const [identity] = await runtime.$queryRaw`SELECT current_user::text AS "user"`;
    if (!identity || identity.user !== input.role) throw new DbAccessError('The runtime connection authenticated as an unexpected database role.');
    await assertRestrictedRole(runtime, input.role);
    const [schemaAccess] = await runtime.$queryRaw`
      SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS usage,
             has_schema_privilege(current_user, 'public', 'CREATE') AS create
    `;
    if (!schemaAccess?.usage || schemaAccess.create) throw new DbAccessError('The runtime role has invalid public schema privileges.');
    const [tables] = await runtime.$queryRaw`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'SELECT'))::int AS selectable,
        count(*) FILTER (WHERE has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'INSERT'))::int AS insertable,
        count(*) FILTER (WHERE has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'UPDATE'))::int AS updatable,
        count(*) FILTER (WHERE has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'DELETE'))::int AS deletable,
        count(*) FILTER (WHERE has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRUNCATE') OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRIGGER') OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'REFERENCES'))::int AS forbidden
      FROM pg_tables WHERE schemaname = 'public'
    `;
    if (!tables || tables.total === 0 || tables.selectable !== tables.total || tables.insertable !== tables.total || tables.updatable !== tables.total || tables.deletable !== tables.total || tables.forbidden !== 0) throw new DbAccessError('The runtime role table privileges do not match the required CRUD-only policy.');
    console.info(`Runtime database role verified for ${tables.total} tables; ownership and elevated privileges are absent.`);
  } finally {
    await runtime.$disconnect();
  }
}

try {
  const value = connectionInput();
  if (value.mode === 'configure') await configureRole(value);
  await verifyRole(value);
} catch (error) {
  console.error(error instanceof DbAccessError ? error.message : 'Database access configuration failed.');
  process.exitCode = 1;
}
