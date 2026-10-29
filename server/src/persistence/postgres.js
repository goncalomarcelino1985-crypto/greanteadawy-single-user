import { readFile } from 'node:fs/promises';
import { PersistenceError, canonicalJSON, validateBudget, validateIdentifier, validateObjectReference } from './validation.js';

/** Owner-only provisioning helper for isolated tests/maintenance. Never called by runtime. */
export async function initializeCloudSchema(pool) {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

const lockBudget = (client, namespace) => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [namespace]);

export class PostgresCheckpointRepository {
  constructor({ pool, namespace = 'gm', maxStateBytes = 16 * 1024 * 1024, maxMetadataBytes = 250 * 1024 * 1024, readOnly = false }) {
    if (!pool?.query || !pool?.connect) throw new PersistenceError('CONFIGURATION', 'A PostgreSQL pool is required.');
    this.pool = pool;
    this.namespace = validateIdentifier(namespace);
    this.maxStateBytes = validateBudget(maxStateBytes, 'Checkpoint budget');
    this.maxMetadataBytes = validateBudget(maxMetadataBytes, 'Metadata budget');
    this.readOnly = readOnly;
  }

  async load(workspaceId) {
    validateIdentifier(workspaceId, 'Workspace');
    const { rows } = await this.pool.query(
      'SELECT generation, state FROM gm_workspace_checkpoints WHERE repository_namespace = $1 AND workspace_id = $2',
      [this.namespace, workspaceId]
    );
    if (!rows.length) return null;
    const generation = Number(rows[0].generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new PersistenceError('INVALID_STATE', 'Invalid checkpoint generation.');
    return { generation, state: rows[0].state };
  }

  /** Freshness checks must not transfer a full JSONB checkpoint for every request. */
  async getGeneration(workspaceId) {
    validateIdentifier(workspaceId, 'Workspace');
    const { rows } = await this.pool.query(
      'SELECT generation FROM gm_workspace_checkpoints WHERE repository_namespace = $1 AND workspace_id = $2',
      [this.namespace, workspaceId]
    );
    if (!rows.length) return 0;
    const generation = Number(rows[0].generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new PersistenceError('INVALID_STATE', 'Invalid checkpoint generation.');
    return generation;
  }

  async commit(workspaceId, expectedGeneration, state) {
    if (this.readOnly) throw new PersistenceError('READ_ONLY', 'This cloud metadata connection is read-only.');
    validateIdentifier(workspaceId, 'Workspace');
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || expectedGeneration === Number.MAX_SAFE_INTEGER) {
      throw new PersistenceError('INVALID_GENERATION', 'Invalid expected checkpoint generation.');
    }
    const serialized = canonicalJSON(state);
    const size = Buffer.byteLength(serialized);
    if (size > this.maxStateBytes) throw new PersistenceError('METADATA_QUOTA', 'Checkpoint exceeds the configured metadata budget.');
    return transaction(this.pool, async (client) => {
      // Serialize namespace quotas and empty-row creation across every process.
      await lockBudget(client, `gm-metadata:${this.namespace}`);
      const { rows } = await client.query(
        'SELECT generation, state_bytes FROM gm_workspace_checkpoints WHERE repository_namespace = $1 AND workspace_id = $2 FOR UPDATE',
        [this.namespace, workspaceId]
      );
      const current = rows[0];
      if ((current ? Number(current.generation) : 0) !== expectedGeneration) {
        throw new PersistenceError('CHECKPOINT_CONFLICT', 'The cloud workspace changed. Reload before saving.');
      }
      const { rows: totals } = await client.query(
        'SELECT COALESCE(SUM(state_bytes), 0) AS bytes FROM gm_workspace_checkpoints WHERE repository_namespace = $1',
        [this.namespace]
      );
      if (Number(totals[0].bytes) - Number(current?.state_bytes || 0) + size > this.maxMetadataBytes) {
        throw new PersistenceError('METADATA_QUOTA', 'Cloud metadata budget reached; existing data is preserved.');
      }
      const nextGeneration = expectedGeneration + 1;
      await client.query(
        `INSERT INTO gm_workspace_checkpoints (repository_namespace, workspace_id, generation, state, state_bytes)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (repository_namespace, workspace_id) DO UPDATE
         SET generation = EXCLUDED.generation, state = EXCLUDED.state, state_bytes = EXCLUDED.state_bytes, updated_at = now()`,
        [this.namespace, workspaceId, nextGeneration, serialized, size]
      );
      return nextGeneration;
    });
  }
}

/** Reservations intentionally survive failed/ambiguous uploads: quota must fail closed. */
export class PostgresObjectLedger {
  constructor({ pool, namespace, maxTotalBytes = 4 * 1024 * 1024 * 1024, maxObjects = 10000 }) {
    if (!pool?.query || !pool?.connect) throw new PersistenceError('CONFIGURATION', 'A PostgreSQL pool is required.');
    this.pool = pool;
    this.namespace = validateIdentifier(namespace, 'Object store namespace');
    this.maxTotalBytes = validateBudget(maxTotalBytes, 'Object storage budget');
    this.maxObjects = validateBudget(maxObjects, 'Object count budget');
  }

  async reserve(ref) {
    validateObjectReference(ref);
    return transaction(this.pool, async (client) => {
      await lockBudget(client, `gm-objects:${this.namespace}`);
      const { rows } = await client.query(
        'SELECT size_bytes FROM gm_cloud_objects WHERE store_namespace = $1 AND object_key = $2',
        [this.namespace, ref.key]
      );
      if (rows.length) {
        if (Number(rows[0].size_bytes) !== ref.size) throw new PersistenceError('OBJECT_CORRUPT', 'Object ledger size mismatch.');
        return false;
      }
      const { rows: totals } = await client.query(
        'SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS count FROM gm_cloud_objects WHERE store_namespace = $1', [this.namespace]
      );
      if (Number(totals[0].bytes) + ref.size > this.maxTotalBytes || Number(totals[0].count) >= this.maxObjects) {
        throw new PersistenceError('OBJECT_QUOTA', 'Cloud audio budget reached; existing objects are preserved.');
      }
      await client.query('INSERT INTO gm_cloud_objects (store_namespace, object_key, size_bytes) VALUES ($1, $2, $3)',
        [this.namespace, ref.key, ref.size]);
      return true;
    });
  }
}
