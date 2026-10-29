import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { verifyRuntimeAccess } from '../src/persistence/access.js';
import { initializeCloudSchema, PostgresCheckpointRepository, PostgresObjectLedger, sha256 } from '../src/persistence/index.js';
import { assertIsolatedCloudTargets } from './helpers/isolated-cloud.js';

const enabled = process.env.GM_TEST_CLOUD_ALLOW_WRITE === 'true' && process.env.GM_TEST_PG_URL && process.env.GM_TEST_S3_ENDPOINT;

test('real PostgreSQL runtime role can commit and reserve but cannot destroy, grant, create or edit ledger rows', {
  skip: enabled ? false : 'Isolated PostgreSQL CI fixture is not configured.'
}, async () => {
  // This test creates and drops its own database/roles. Remote providers cannot
  // be enabled by merely supplying credentials or setting the opt-in flag.
  assertIsolatedCloudTargets(process.env.GM_TEST_PG_URL, process.env.GM_TEST_S3_ENDPOINT);
  const { default: pg } = await import('pg');
  const suffix = randomUUID().replaceAll('-', '');
  const database = `gm_access_${suffix}`, runtimeRole = `gm_rw_${suffix}`, readerRole = `gm_ro_${suffix}`;
  const password = randomUUID(); // Temporary test-only password; never printed.
  const admin = new pg.Pool({ connectionString: process.env.GM_TEST_PG_URL, max: 1 });
  let owner, runtime, reader, created = false;
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const ownerUri = new URL(process.env.GM_TEST_PG_URL);
    ownerUri.pathname = `/${database}`;
    owner = new pg.Pool({ connectionString: ownerUri.href, max: 1 });
    await initializeCloudSchema(owner);
    await owner.query("SELECT set_config('gm.provision_database', $1, false), set_config('gm.runtime_role', $2, false), set_config('gm.reader_role', $3, false)", [database, runtimeRole, readerRole]);
    const grants = await readFile(new URL('../src/persistence/runtime-grants.sql', import.meta.url), 'utf8');
    await owner.query(grants);
    await owner.query(grants); // Explicit provisioning is repeatable, including column grants.
    for (const role of [runtimeRole, readerRole]) await owner.query(`ALTER ROLE "${role}" PASSWORD '${password}'`);
    const connection = (role) => {
      const uri = new URL(ownerUri);
      uri.username = role; uri.password = password;
      return new pg.Pool({ connectionString: uri.href, max: 1, options: '-c search_path=pg_catalog,public' });
    };
    runtime = connection(runtimeRole); reader = connection(readerRole);
    await verifyRuntimeAccess(runtime, { role: runtimeRole, database });
    await verifyRuntimeAccess(reader, { role: readerRole, database, readOnly: true });
    await assert.rejects(verifyRuntimeAccess(owner, { role: new URL(ownerUri).username, database }), { code: 'CLOUD_ACCESS_UNSAFE' });
    await assert.rejects(verifyRuntimeAccess(reader, { role: readerRole, database }), { code: 'CLOUD_ACCESS_UNSAFE' });
    await assert.rejects(verifyRuntimeAccess(runtime, { role: runtimeRole, database, readOnly: true }), { code: 'CLOUD_ACCESS_UNSAFE' });

    const repository = new PostgresCheckpointRepository({ pool: runtime, namespace: 'gm-worker' });
    assert.equal(await repository.commit('synthetic', 0, { bpm: 126 }), 1);
    assert.equal(await repository.commit('synthetic', 1, { bpm: 127 }), 2);
    assert.equal(await repository.getGeneration('synthetic'), 2);
    const ledger = new PostgresObjectLedger({ pool: runtime, namespace: 'gm-worker-objects', maxTotalBytes: 16 });
    const digest = sha256(Buffer.from('test'));
    assert.equal(await ledger.reserve({ key: digest, sha256: digest, size: 4 }), true);
    assert.equal(await ledger.reserve({ key: digest, sha256: digest, size: 4 }), false);
    const readonly = new PostgresCheckpointRepository({ pool: reader, namespace: 'gm-worker', readOnly: true });
    assert.deepEqual((await readonly.load('synthetic')).state, { bpm: 127 });

    for (const sql of [
      'DELETE FROM public.gm_workspace_checkpoints', 'TRUNCATE public.gm_workspace_checkpoints',
      'DELETE FROM public.gm_cloud_objects', 'TRUNCATE public.gm_cloud_objects',
      'UPDATE public.gm_cloud_objects SET size_bytes = 0',
      "UPDATE public.gm_workspace_checkpoints SET workspace_id = 'other'",
      'CREATE TABLE public.forbidden (id int)', 'CREATE SCHEMA forbidden', 'CREATE TEMP TABLE forbidden (id int)',
      'DROP TABLE public.gm_workspace_checkpoints', 'ALTER TABLE public.gm_cloud_objects ADD COLUMN forbidden int',
      'CREATE ROLE gm_forbidden_test_role'
    ]) await assert.rejects(runtime.query(sql), { code: '42501' });
    await assert.rejects(reader.query("INSERT INTO public.gm_cloud_objects (store_namespace, object_key, size_bytes) VALUES ('x', repeat('a', 64), 1)"), { code: '42501' });
    await assert.rejects(reader.query('UPDATE public.gm_workspace_checkpoints SET state_bytes = 0'), { code: '42501' });
    assert.equal(await repository.getGeneration('synthetic'), 2);
    assert.equal((await runtime.query('SELECT size_bytes FROM public.gm_cloud_objects')).rows[0].size_bytes, '4');
  } finally {
    await Promise.allSettled([runtime?.end(), reader?.end(), owner?.end()]);
    if (created) await admin.query(`DROP DATABASE "${database}"`);
    for (const role of [runtimeRole, readerRole]) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  }
});
