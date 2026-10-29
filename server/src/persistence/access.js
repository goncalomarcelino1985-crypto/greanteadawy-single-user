import { PersistenceError } from './validation.js';

// Read-only preflight. The role must have been prepared manually by a separate
// owner connection; runtime never grants itself privileges or creates tables.
export const RUNTIME_ACCESS_QUERY = `
SELECT current_user AS role_name, current_database() AS database_name,
  r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit) AS role_safe,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS no_memberships,
  NOT pg_catalog.has_database_privilege(current_database(), 'CREATE')
    AND NOT pg_catalog.has_database_privilege(current_database(), 'TEMPORARY') AS no_database_ddl,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND pg_catalog.has_schema_privilege(n.oid, 'CREATE')) AS no_schema_ddl,
  NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database d WHERE d.datname = current_database() AND d.datdba = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner = r.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class t
      WHERE t.oid IN ('public.gm_workspace_checkpoints'::regclass, 'public.gm_cloud_objects'::regclass) AND t.relowner = r.oid) AS not_owner,
  pg_catalog.has_schema_privilege('public', 'USAGE') AS schema_usage,
  pg_catalog.has_table_privilege('public.gm_workspace_checkpoints', 'SELECT')
    AND pg_catalog.has_table_privilege('public.gm_cloud_objects', 'SELECT') AS can_read,
  pg_catalog.has_table_privilege('public.gm_workspace_checkpoints', 'INSERT')
    AND pg_catalog.has_column_privilege('public.gm_workspace_checkpoints', 'generation', 'UPDATE')
    AND pg_catalog.has_column_privilege('public.gm_workspace_checkpoints', 'state', 'UPDATE')
    AND pg_catalog.has_column_privilege('public.gm_workspace_checkpoints', 'state_bytes', 'UPDATE')
    AND pg_catalog.has_column_privilege('public.gm_workspace_checkpoints', 'updated_at', 'UPDATE')
    AND pg_catalog.has_table_privilege('public.gm_cloud_objects', 'INSERT') AS can_write,
  NOT pg_catalog.has_table_privilege('public.gm_workspace_checkpoints', 'DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT pg_catalog.has_table_privilege('public.gm_cloud_objects', 'DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT pg_catalog.has_any_column_privilege('public.gm_cloud_objects', 'UPDATE')
    AND NOT pg_catalog.has_column_privilege('public.gm_workspace_checkpoints', 'repository_namespace', 'UPDATE')
    AND NOT pg_catalog.has_column_privilege('public.gm_workspace_checkpoints', 'workspace_id', 'UPDATE')
    -- Even allowed privileges must not be delegable to another role or PUBLIC.
    AND NOT pg_catalog.has_database_privilege(current_database(), 'CONNECT WITH GRANT OPTION')
    AND NOT pg_catalog.has_schema_privilege('public', 'USAGE WITH GRANT OPTION')
    AND NOT pg_catalog.has_table_privilege('public.gm_workspace_checkpoints', 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION')
    AND NOT pg_catalog.has_table_privilege('public.gm_cloud_objects', 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION')
    AND NOT pg_catalog.has_any_column_privilege('public.gm_workspace_checkpoints', 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION')
    AND NOT pg_catalog.has_any_column_privilege('public.gm_cloud_objects', 'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') AS no_destructive_grants,
  -- Column INSERT grants can write rows without a table-level INSERT grant.
  NOT pg_catalog.has_any_column_privilege('public.gm_workspace_checkpoints', 'INSERT')
    AND NOT pg_catalog.has_any_column_privilege('public.gm_workspace_checkpoints', 'UPDATE')
    AND NOT pg_catalog.has_any_column_privilege('public.gm_cloud_objects', 'INSERT') AS read_only
FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;

export async function verifyRuntimeAccess(pool, { role, database, readOnly = false }) {
  let row;
  try { ({ rows: [row] } = await pool.query(RUNTIME_ACCESS_QUERY)); }
  catch { throw new PersistenceError('CLOUD_ACCESS_UNVERIFIED', 'Cloud database access could not be verified. Prepare the dedicated database manually.'); }
  if (!row || row.role_name !== role || row.database_name !== database ||
      ['role_safe', 'no_memberships', 'no_database_ddl', 'no_schema_ddl', 'not_owner', 'schema_usage', 'can_read', 'no_destructive_grants']
        .some((key) => row[key] !== true) || (readOnly ? row.read_only !== true : row.can_write !== true)) {
    throw new PersistenceError('CLOUD_ACCESS_UNSAFE', 'Cloud database role does not match the required least-privilege boundary.');
  }
}
