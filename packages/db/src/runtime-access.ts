import type { PrismaClient } from '@prisma/client';

export async function databaseRuntimeAccessRestricted(db: PrismaClient): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ restricted: boolean }>>`
    SELECT NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole AND NOT role.rolreplication AND NOT role.rolbypassrls
      AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
      AND NOT EXISTS (SELECT 1 FROM pg_class object JOIN pg_namespace namespace ON namespace.oid = object.relnamespace WHERE namespace.nspname = 'public' AND object.relowner = role.oid)
      AND NOT EXISTS (SELECT 1 FROM pg_roles parent WHERE parent.oid <> role.oid AND pg_has_role(role.rolname, parent.oid, 'MEMBER'))
      AND NOT EXISTS (SELECT 1 FROM pg_tables table_info WHERE table_info.schemaname = 'public' AND (
        NOT has_table_privilege(current_user, format('%I.%I', table_info.schemaname, table_info.tablename), 'SELECT') OR
        NOT has_table_privilege(current_user, format('%I.%I', table_info.schemaname, table_info.tablename), 'INSERT') OR
        NOT has_table_privilege(current_user, format('%I.%I', table_info.schemaname, table_info.tablename), 'UPDATE') OR
        NOT has_table_privilege(current_user, format('%I.%I', table_info.schemaname, table_info.tablename), 'DELETE') OR
        has_table_privilege(current_user, format('%I.%I', table_info.schemaname, table_info.tablename), 'TRUNCATE') OR
        has_table_privilege(current_user, format('%I.%I', table_info.schemaname, table_info.tablename), 'TRIGGER') OR
        has_table_privilege(current_user, format('%I.%I', table_info.schemaname, table_info.tablename), 'REFERENCES')
      )) AS restricted
    FROM pg_roles role WHERE role.rolname = current_user
  `;
  return rows[0]?.restricted === true;
}
