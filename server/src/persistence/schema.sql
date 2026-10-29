-- Dedicated GM AI Worker metadata only. No existing tables are altered.
CREATE TABLE IF NOT EXISTS public.gm_workspace_checkpoints (
  repository_namespace text NOT NULL,
  workspace_id text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  state jsonb NOT NULL,
  state_bytes bigint NOT NULL CHECK (state_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_namespace, workspace_id)
);

-- One namespace per dedicated physical object store. Reservations are not
-- automatically removed: uncertain upload outcomes may have consumed space.
CREATE TABLE IF NOT EXISTS public.gm_cloud_objects (
  store_namespace text NOT NULL,
  object_key text NOT NULL CHECK (object_key ~ '^[a-f0-9]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_namespace, object_key)
);
