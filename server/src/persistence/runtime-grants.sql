-- MANUAL OWNER SESSION ONLY, in the newly dedicated GM AI Worker database.
-- Review schema.sql first. Run it separately, then set these NON-SECRET values:
-- SELECT set_config('gm.provision_database', 'REVIEWED_DATABASE_NAME', false);
-- SELECT set_config('gm.runtime_role', 'gm_worker_runtime', false);
-- SELECT set_config('gm.reader_role', 'gm_worker_reader', false); -- optional backup reader
-- This script creates no password. Set a fresh role password privately with the
-- provider or a secure SQL client; never save owner/runtime passwords in a file.
-- PUBLIC CREATE/TEMP are revoked only in this explicitly selected database.
BEGIN;
DO $gm$
DECLARE
  database_name text := current_setting('gm.provision_database', true);
  runtime_name text := current_setting('gm.runtime_role', true);
  reader_name text := nullif(current_setting('gm.reader_role', true), '');
  role_name text;
  candidate record;
BEGIN
  IF database_name IS NULL OR database_name <> current_database() THEN
    RAISE EXCEPTION 'Select and confirm the dedicated provision database first';
  END IF;
  IF runtime_name IS NULL OR runtime_name !~ '^[a-z][a-z0-9_]{0,62}$'
    OR reader_name IS NOT NULL AND (reader_name !~ '^[a-z][a-z0-9_]{0,62}$' OR reader_name = runtime_name) THEN
    RAISE EXCEPTION 'Explicit, distinct runtime and optional reader roles are required';
  END IF;
  IF to_regclass('public.gm_workspace_checkpoints') IS NULL OR to_regclass('public.gm_cloud_objects') IS NULL THEN
    RAISE EXCEPTION 'Install the reviewed schema using the owner connection first';
  END IF;
  FOREACH role_name IN ARRAY array_remove(ARRAY[runtime_name, reader_name], NULL) LOOP
    SELECT * INTO candidate FROM pg_catalog.pg_roles WHERE rolname = role_name;
    IF FOUND THEN
      -- Never demote an unrelated existing role or silently inherit its access.
      IF candidate.rolsuper OR candidate.rolcreatedb OR candidate.rolcreaterole
        OR candidate.rolreplication OR candidate.rolbypassrls OR candidate.rolinherit
        OR NOT candidate.rolcanlogin OR role_name = current_user
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = candidate.oid)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datdba = candidate.oid)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = candidate.oid)
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner = candidate.oid) THEN
        RAISE EXCEPTION 'Existing role is not a dedicated least-privilege role';
      END IF;
    ELSE
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS', role_name);
    END IF;
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM %I', database_name, role_name);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', database_name, role_name);
    EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', role_name);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', role_name);
    EXECUTE format('REVOKE ALL ON TABLE public.gm_workspace_checkpoints, public.gm_cloud_objects FROM %I', role_name);
    -- Table-level REVOKE does not remove earlier column-level grants.
    EXECUTE format('REVOKE ALL (repository_namespace, workspace_id, generation, state, state_bytes, updated_at) ON TABLE public.gm_workspace_checkpoints FROM %I', role_name);
    EXECUTE format('REVOKE ALL (store_namespace, object_key, size_bytes, created_at) ON TABLE public.gm_cloud_objects FROM %I', role_name);
    EXECUTE format('GRANT SELECT ON TABLE public.gm_workspace_checkpoints, public.gm_cloud_objects TO %I', role_name);
    EXECUTE format('ALTER ROLE %I IN DATABASE %I SET search_path = pg_catalog, public', role_name, database_name);
  END LOOP;
  EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', database_name);
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  REVOKE ALL ON TABLE public.gm_workspace_checkpoints, public.gm_cloud_objects FROM PUBLIC;
  REVOKE ALL (repository_namespace, workspace_id, generation, state, state_bytes, updated_at) ON TABLE public.gm_workspace_checkpoints FROM PUBLIC;
  REVOKE ALL (store_namespace, object_key, size_bytes, created_at) ON TABLE public.gm_cloud_objects FROM PUBLIC;
  EXECUTE format('GRANT INSERT ON TABLE public.gm_workspace_checkpoints, public.gm_cloud_objects TO %I', runtime_name);
  EXECUTE format('GRANT UPDATE (generation, state, state_bytes, updated_at) ON TABLE public.gm_workspace_checkpoints TO %I', runtime_name);
END
$gm$;
COMMIT;
