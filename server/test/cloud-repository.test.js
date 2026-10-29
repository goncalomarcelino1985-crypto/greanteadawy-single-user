import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  PostgresCheckpointRepository, PostgresObjectLedger, S3ObjectStore, initializeCloudSchema,
  backupWorkspace, restoreWorkspace, canonicalJSON, sha256, validateState
} from '../src/persistence/index.js';

const clone = (value) => structuredClone(value);
const code = (expected) => (error) => error.code === expected;

// An SQL-shaped fake for transport, transaction rollback and race tests. The
// optional integration case below executes the same repository against real PG.
class FakePool {
  checkpoints = new Map();
  allocations = new Map();
  tail = Promise.resolve();
  failWrite = false;
  queryLog = [];

  async query(sql, params = []) {
    this.queryLog.push(sql);
    const key = `${params[0]}|${params[1]}`;
    if (/CREATE TABLE IF NOT EXISTS/.test(sql)) return { rows: [] };
    if (/SELECT generation, state FROM/.test(sql)) {
      const row = this.checkpoints.get(key);
      return { rows: row ? [clone(row)] : [] };
    }
    if (/SELECT generation FROM/.test(sql)) {
      const row = this.checkpoints.get(key);
      return { rows: row ? [{ generation: row.generation }] : [] };
    }
    if (/SELECT generation, state_bytes/.test(sql)) {
      const row = this.checkpoints.get(key);
      return { rows: row ? [clone(row)] : [] };
    }
    if (/SUM\(state_bytes\)/.test(sql)) {
      return { rows: [{ bytes: [...this.checkpoints].filter(([k]) => k.startsWith(`${params[0]}|`)).reduce((n, [, row]) => n + row.state_bytes, 0) }] };
    }
    if (/INSERT INTO gm_workspace_checkpoints/.test(sql)) {
      if (this.failWrite) throw new Error('Simulated PostgreSQL write failure');
      this.checkpoints.set(key, { generation: params[2], state: JSON.parse(params[3]), state_bytes: params[4] });
      return { rows: [] };
    }
    if (/SELECT size_bytes FROM/.test(sql)) {
      const row = this.allocations.get(key);
      return { rows: row ? [clone(row)] : [] };
    }
    if (/SUM\(size_bytes\)/.test(sql)) {
      const allocations = [...this.allocations].filter(([k]) => k.startsWith(`${params[0]}|`));
      return { rows: [{ bytes: allocations.reduce((n, [, row]) => n + row.size_bytes, 0), count: allocations.length }] };
    }
    if (/INSERT INTO gm_cloud_objects/.test(sql)) {
      if (this.failWrite) throw new Error('Simulated PostgreSQL write failure');
      this.allocations.set(key, { size_bytes: params[2] });
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in fake: ${sql}`);
  }

  async connect() {
    let releaseLock, before, released = false;
    const finish = () => { releaseLock?.(); releaseLock = null; };
    return {
      query: async (sql, params) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql.includes('pg_advisory_xact_lock')) {
          const previous = this.tail;
          this.tail = new Promise((resolve) => { releaseLock = resolve; });
          await previous;
          before = { checkpoints: clone(this.checkpoints), allocations: clone(this.allocations) };
          return { rows: [] };
        }
        if (sql === 'COMMIT') { finish(); return { rows: [] }; }
        if (sql === 'ROLLBACK') {
          if (before) { this.checkpoints = before.checkpoints; this.allocations = before.allocations; }
          finish(); return { rows: [] };
        }
        return this.query(sql, params);
      },
      release: () => { assert.equal(released, false); released = true; finish(); }
    };
  }
}

class FakeS3 {
  bytes = new Map();
  uploads = 0;
  failUpload = false;
  corruptUpload = false;

  async send(command) {
    const { Bucket, Key, Body } = command.input;
    const key = `${Bucket}/${Key}`;
    if (command.constructor.name === 'GetObjectCommand') {
      if (!this.bytes.has(key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      const bytes = this.bytes.get(key);
      return { Body: Readable.from([bytes]), ContentLength: bytes.length };
    }
    if (command.constructor.name === 'PutObjectCommand') {
      this.uploads++;
      if (this.failUpload) throw new Error('Simulated S3 upload failure');
      this.bytes.set(key, this.corruptUpload ? Buffer.from('corruption') : Buffer.from(Body));
      return {};
    }
    throw new Error('Unexpected S3 command');
  }
}

function environment(options = {}) {
  const pool = new FakePool();
  const client = new FakeS3();
  const repository = new PostgresCheckpointRepository({ pool, ...options });
  const ledger = new PostgresObjectLedger({ pool, namespace: 'objects', maxTotalBytes: options.maxTotalBytes || 1024,
    maxObjects: options.maxObjects || 10000 });
  const objects = new S3ObjectStore({ client, bucket: 'private-test', ledger, maxObjectBytes: options.maxObjectBytes || 512 });
  return { pool, client, repository, ledger, objects };
}

const workspace = (ref) => ({
  schemaVersion: 1,
  files: {
    'projects/house.json': { kind: 'json', value: { bpm: 126, name: 'House sintético', tracks: [] } },
    ...(ref ? { 'samples/kick.wav': { kind: 'blob', ...ref }, 'exports/preview.wav': { kind: 'blob', ...ref } } : {})
  },
  runtime: { undo: [{ name: 'Alterar baixo', previousBpm: 125 }], receipts: [{ id: 'operation-1' }] }
});

test('Postgres checkpoint is atomic, CAS protected and survives a new repository instance', async () => {
  const { pool, repository } = environment();
  await initializeCloudSchema(pool);
  assert.equal(await repository.load('studio'), null);
  assert.equal(await repository.getGeneration('studio'), 0);
  assert.equal(await repository.commit('studio', 0, workspace()), 1);
  const reopened = new PostgresCheckpointRepository({ pool });
  assert.equal(await reopened.getGeneration('studio'), 1);
  assert.deepEqual(await reopened.load('studio'), { generation: 1, state: workspace() });
  await assert.rejects(repository.commit('studio', 0, { stale: true }), code('CHECKPOINT_CONFLICT'));
  assert.equal((await repository.load('studio')).generation, 1);
});

test('concurrent first writes and updates have one winner', async () => {
  const { repository } = environment();
  for (const expectedGeneration of [0, 1]) {
    const results = await Promise.allSettled([
      repository.commit('studio', expectedGeneration, { winner: 'a' }),
      repository.commit('studio', expectedGeneration, { winner: 'b' })
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CHECKPOINT_CONFLICT');
  }
  assert.equal((await repository.load('studio')).generation, 2);
});

test('metadata write failure preserves last checkpoint', async () => {
  const { pool, repository } = environment();
  await repository.commit('studio', 0, workspace());
  pool.failWrite = true;
  await assert.rejects(repository.commit('studio', 1, { changed: true }), /write failure/);
  assert.deepEqual((await repository.load('studio')).state, workspace());
});

test('per-checkpoint and total metadata budgets stop writes before replacing data', async () => {
  const { pool } = environment();
  const repository = new PostgresCheckpointRepository({ pool, maxStateBytes: 24, maxMetadataBytes: 30 });
  await repository.commit('one', 0, { value: '123456' });
  await assert.rejects(repository.commit('one', 1, { value: 'x'.repeat(50) }), code('METADATA_QUOTA'));
  await assert.rejects(repository.commit('two', 0, { value: '123456' }), code('METADATA_QUOTA'));
  assert.equal((await repository.load('one')).generation, 1);
  assert.equal(await repository.load('two'), null);
  assert.equal(await repository.commit('one', 1, { v: 1 }), 2);
});

test('cloud objects are content addressed, verified and deduplicated', async () => {
  const { objects, client, pool } = environment();
  const bytes = Buffer.from('synthetic wav fixture');
  const ref = await objects.put(bytes);
  assert.equal(ref.key, sha256(bytes));
  assert.equal(ref.size, bytes.length);
  assert.deepEqual(await objects.get(ref), bytes);
  assert.deepEqual(await objects.put(bytes), ref);
  assert.equal(client.uploads, 1);
  assert.equal(pool.allocations.size, 1);
});

test('total object quota and per-object limit fail without uploads or deleting anything', async () => {
  const { objects, client } = environment({ maxTotalBytes: 10, maxObjectBytes: 8 });
  const ref = await objects.put(Buffer.from('123456'));
  await assert.rejects(objects.put(Buffer.from('abcdef')), code('OBJECT_QUOTA'));
  await assert.rejects(objects.put(Buffer.alloc(9)), code('OBJECT_TOO_LARGE'));
  assert.equal(client.uploads, 1);
  assert.deepEqual(await objects.get(ref), Buffer.from('123456'));
});

test('racing object reservations cannot exceed total budget', async () => {
  const { objects, pool } = environment({ maxTotalBytes: 8 });
  const results = await Promise.allSettled([objects.put(Buffer.from('12345')), objects.put(Buffer.from('abcde'))]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(pool.allocations.size, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'OBJECT_QUOTA');
});

test('object count limit protects metadata space even for tiny files', async () => {
  const { objects, pool } = environment({ maxObjects: 1 });
  await objects.put(Buffer.alloc(0));
  await assert.rejects(objects.put(Buffer.from('x')), code('OBJECT_QUOTA'));
  assert.equal(pool.allocations.size, 1);
});

test('ambiguous failed upload retains budget reservation and can be retried', async () => {
  const { objects, client, pool } = environment({ maxTotalBytes: 8 });
  client.failUpload = true;
  await assert.rejects(objects.put(Buffer.from('123456')), /upload failure/);
  assert.equal(pool.allocations.size, 1);
  await assert.rejects(objects.put(Buffer.from('abcd')), code('OBJECT_QUOTA'));
  client.failUpload = false;
  assert.equal((await objects.put(Buffer.from('123456'))).size, 6);
  assert.equal(pool.allocations.size, 1);
});

test('read corruption, missing bytes and corrupt successful upload are rejected', async () => {
  const { objects, client } = environment();
  const ref = await objects.put(Buffer.from('abcdef'));
  client.bytes.set(`private-test/gm-worker/${ref.key}`, Buffer.from('fedcba'));
  await assert.rejects(objects.get(ref), code('OBJECT_CORRUPT'));
  await assert.rejects(objects.put(Buffer.from('abcdef')), code('OBJECT_CORRUPT'));
  client.bytes.clear();
  await assert.rejects(objects.get(ref), code('OBJECT_MISSING'));
  client.corruptUpload = true;
  await assert.rejects(objects.put(Buffer.from('next')), code('OBJECT_CORRUPT'));
});

test('private object read permission failures propagate and never trigger writes', async () => {
  const { objects, client } = environment();
  client.send = async () => { throw Object.assign(new Error('Access denied'), { name: 'AccessDenied' }); };
  await assert.rejects(objects.put(Buffer.from('bytes')), /Access denied/);
  assert.equal(client.uploads, 0);
});

test('state validation rejects traversal, absolute paths, file/dir conflicts and invalid blob keys', () => {
  for (const name of ['../secret', '/absolute', 'a/../../secret', 'C:/drive', 'a\\b', 'a//b', 'a/./b', 'a\u0000b']) {
    assert.throws(() => validateState({ schemaVersion: 1, files: { [name]: { kind: 'json', value: {} } } }), code('INVALID_PATH'));
  }
  assert.throws(() => validateState({ schemaVersion: 1, files: { a: { kind: 'json', value: {} }, 'a/b': { kind: 'json', value: {} } } }), code('INVALID_PATH'));
  assert.throws(() => validateState({ schemaVersion: 1, files: { a: { kind: 'blob', key: '../oops', sha256: 'a'.repeat(64), size: 1 } } }), code('INVALID_OBJECT'));
});

test('canonical metadata checksums survive PostgreSQL JSONB key ordering', () => {
  assert.equal(canonicalJSON({ b: 2, a: { d: 4, c: 3 } }), canonicalJSON({ a: { c: 3, d: 4 }, b: 2 }));
  assert.throws(() => canonicalJSON({ invalid: NaN }), code('INVALID_STATE'));
  assert.throws(() => canonicalJSON({ invalid: undefined }), code('INVALID_STATE'));
  assert.throws(() => canonicalJSON(new Array(2)), code('INVALID_STATE'));
});

test('backup copies actual bytes, deduplicates references and restores metadata/settings/undo', async () => {
  const source = environment();
  const backup = environment();
  const target = environment();
  const ref = await source.objects.put(Buffer.from('a synthetic 126 BPM kick'));
  await source.repository.commit('studio', 0, workspace(ref));
  const result = await backupWorkspace({ sourceRepository: source.repository, sourceObjects: source.objects,
    backupRepository: backup.repository, backupObjects: backup.objects, workspaceId: 'studio', backupId: 'first' });
  assert.equal(result.objectCount, 1);
  assert.equal(backup.client.uploads, 1);
  source.client.bytes.clear(); // A restore cannot accidentally read live objects.
  const restored = await restoreWorkspace({ backupRepository: backup.repository, backupObjects: backup.objects,
    targetRepository: target.repository, targetObjects: target.objects, backupId: 'first', targetWorkspaceId: 'restored' });
  assert.equal(restored.checkpointSha256, result.checkpointSha256);
  assert.deepEqual((await target.repository.load('restored')).state, workspace(ref));
  assert.deepEqual(await target.objects.get(ref), Buffer.from('a synthetic 126 BPM kick'));
});

test('backup failure never commits a manifest claiming missing audio is backed up', async () => {
  const source = environment();
  const backup = environment();
  const ref = await source.objects.put(Buffer.from('fixture'));
  await source.repository.commit('studio', 0, workspace(ref));
  backup.client.failUpload = true;
  await assert.rejects(backupWorkspace({ sourceRepository: source.repository, sourceObjects: source.objects,
    backupRepository: backup.repository, backupObjects: backup.objects, workspaceId: 'studio', backupId: 'failed' }), /upload failure/);
  assert.equal(await backup.repository.load('failed'), null);
});

test('backup manifests cannot be overwritten and restore never replaces a live workspace', async () => {
  const source = environment();
  const backup = environment();
  const target = environment();
  await source.repository.commit('studio', 0, workspace());
  const args = { sourceRepository: source.repository, sourceObjects: source.objects,
    backupRepository: backup.repository, backupObjects: backup.objects, workspaceId: 'studio', backupId: 'first' };
  await backupWorkspace(args);
  await assert.rejects(backupWorkspace(args), code('BACKUP_EXISTS'));
  await target.repository.commit('live', 0, { precious: true });
  await assert.rejects(restoreWorkspace({ backupRepository: backup.repository, backupObjects: backup.objects,
    targetRepository: target.repository, targetObjects: target.objects, backupId: 'first', targetWorkspaceId: 'live' }), code('RESTORE_NOT_EMPTY'));
  assert.deepEqual((await target.repository.load('live')).state, { precious: true });
});

test('corrupt backup bytes or manifest never create a restored checkpoint', async () => {
  const source = environment();
  const backup = environment();
  const target = environment();
  const ref = await source.objects.put(Buffer.from('fixture'));
  await source.repository.commit('studio', 0, workspace(ref));
  await backupWorkspace({ sourceRepository: source.repository, sourceObjects: source.objects,
    backupRepository: backup.repository, backupObjects: backup.objects, workspaceId: 'studio', backupId: 'first' });
  const args = { backupRepository: backup.repository, backupObjects: backup.objects,
    targetRepository: target.repository, targetObjects: target.objects, backupId: 'first', targetWorkspaceId: 'empty' };
  backup.client.bytes.clear();
  await assert.rejects(restoreWorkspace(args), code('OBJECT_MISSING'));
  assert.equal(await target.repository.load('empty'), null);
  backup.pool.checkpoints.get('gm|first').state.checkpoint.runtime.undo = [];
  await assert.rejects(restoreWorkspace(args), code('BACKUP_CORRUPT'));
  assert.equal(await target.repository.load('empty'), null);
});

test('restore CAS prevents a race from overwriting a newly-created target', async () => {
  const source = environment();
  const backup = environment();
  const target = environment();
  const ref = await source.objects.put(Buffer.from('fixture'));
  await source.repository.commit('studio', 0, workspace(ref));
  await backupWorkspace({ sourceRepository: source.repository, sourceObjects: source.objects,
    backupRepository: backup.repository, backupObjects: backup.objects, workspaceId: 'studio', backupId: 'first' });
  const normalPut = target.objects.put.bind(target.objects);
  target.objects.put = async (bytes) => {
    await target.repository.commit('raced', 0, { newer: true });
    return normalPut(bytes);
  };
  await assert.rejects(restoreWorkspace({ backupRepository: backup.repository, backupObjects: backup.objects,
    targetRepository: target.repository, targetObjects: target.objects, backupId: 'first', targetWorkspaceId: 'raced' }), code('CHECKPOINT_CONFLICT'));
  assert.deepEqual((await target.repository.load('raced')).state, { newer: true });
});

test('backup and restore reject identical destination instances', async () => {
  const e = environment();
  await assert.rejects(backupWorkspace({ sourceRepository: e.repository, sourceObjects: e.objects,
    backupRepository: e.repository, backupObjects: e.objects, workspaceId: 'studio', backupId: 'first' }), code('BACKUP_NOT_ISOLATED'));
  await assert.rejects(restoreWorkspace({ backupRepository: e.repository, backupObjects: e.objects,
    targetRepository: e.repository, targetObjects: e.objects, backupId: 'first', targetWorkspaceId: 'studio' }), code('RESTORE_NOT_ISOLATED'));
});

// Opt-in only: local/CI PostgreSQL and S3 containers, never a remote provider.
const integrationEnabled = process.env.GM_TEST_CLOUD_ALLOW_WRITE === 'true' &&
  process.env.GM_TEST_PG_URL && process.env.GM_TEST_S3_ENDPOINT && process.env.GM_TEST_S3_BUCKET &&
  process.env.GM_TEST_S3_ACCESS_KEY_ID && process.env.GM_TEST_S3_SECRET_ACCESS_KEY;

test('integration: real PostgreSQL/S3 backup, empty-target restore and fresh-client reload', {
  skip: integrationEnabled ? false : 'Isolated local/CI container settings and GM_TEST_CLOUD_ALLOW_WRITE=true are not configured.'
}, async () => {
  const { assertIsolatedCloudTargets } = await import('./helpers/isolated-cloud.js');
  assertIsolatedCloudTargets(process.env.GM_TEST_PG_URL, process.env.GM_TEST_S3_ENDPOINT);
  const { Pool } = await import('pg');
  const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const pool = new Pool({ connectionString: process.env.GM_TEST_PG_URL, max: 2 });
  const client = new S3Client({ endpoint: process.env.GM_TEST_S3_ENDPOINT,
    region: process.env.GM_TEST_S3_REGION || 'us-east-2', forcePathStyle: true,
    credentials: { accessKeyId: process.env.GM_TEST_S3_ACCESS_KEY_ID, secretAccessKey: process.env.GM_TEST_S3_SECRET_ACCESS_KEY } });
  const id = `gmtest-${randomUUID()}`;
  const bucket = process.env.GM_TEST_S3_BUCKET;
  const namespaces = ['source', 'backup', 'restore', 'quota'].map((name) => `${id}-${name}`);
  const instances = namespaces.map((namespace) => ({
    repository: new PostgresCheckpointRepository({ pool, namespace, maxMetadataBytes: 1024 * 1024 }),
    objects: new S3ObjectStore({ client, bucket, prefix: `${namespace}/`,
      ledger: new PostgresObjectLedger({ pool, namespace, maxTotalBytes: namespace.endsWith('-quota') ? 5 : 1024 * 1024 }) })
  }));
  const [source, backup, target, quota] = instances;
  const cleanupRefs = [Buffer.from('1234'), Buffer.from('abcd')].map((bytes) => ({ key: sha256(bytes) }));
  let ref;
  try {
    await initializeCloudSchema(pool);
    ref = await source.objects.put(Buffer.from(`Synthetic fixture only: ${id}`));
    cleanupRefs.push(ref);
    await source.repository.commit('studio', 0, workspace(ref));
    await backupWorkspace({ sourceRepository: source.repository, sourceObjects: source.objects,
      backupRepository: backup.repository, backupObjects: backup.objects, workspaceId: 'studio', backupId: 'snapshot' });
    // Only this test's synthetic source is removed. Restore must read copied
    // backup bytes, not accidentally succeed through the original object store.
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${namespaces[0]}/${ref.key}` }));
    await assert.rejects(source.objects.get(ref), code('OBJECT_MISSING'));
    await restoreWorkspace({ backupRepository: backup.repository, backupObjects: backup.objects,
      targetRepository: target.repository, targetObjects: target.objects, backupId: 'snapshot', targetWorkspaceId: 'restored' });
    const freshPool = new Pool({ connectionString: process.env.GM_TEST_PG_URL, max: 2 });
    const freshClient = new S3Client({ endpoint: process.env.GM_TEST_S3_ENDPOINT,
      region: process.env.GM_TEST_S3_REGION || 'us-east-2', forcePathStyle: true,
      credentials: { accessKeyId: process.env.GM_TEST_S3_ACCESS_KEY_ID, secretAccessKey: process.env.GM_TEST_S3_SECRET_ACCESS_KEY } });
    try {
      const reopened = new PostgresCheckpointRepository({ pool: freshPool, namespace: namespaces[2] });
      const reopenedObjects = new S3ObjectStore({ client: freshClient, bucket, prefix: `${namespaces[2]}/`,
        ledger: new PostgresObjectLedger({ pool: freshPool, namespace: namespaces[2], maxTotalBytes: 1024 * 1024 }) });
      assert.deepEqual((await reopened.load('restored')).state, workspace(ref));
      assert.deepEqual(await reopenedObjects.get(ref), Buffer.from(`Synthetic fixture only: ${id}`));
      const writers = await Promise.allSettled([reopened.commit('race', 0, { writer: 1 }), reopened.commit('race', 0, { writer: 2 })]);
      assert.equal(writers.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(writers.find((result) => result.status === 'rejected').reason.code, 'CHECKPOINT_CONFLICT');
    } finally {
      freshClient.destroy();
      await freshPool.end();
    }
    const uploads = await Promise.allSettled([quota.objects.put(Buffer.from('1234')), quota.objects.put(Buffer.from('abcd'))]);
    assert.equal(uploads.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(uploads.find((result) => result.status === 'rejected').reason.code, 'OBJECT_QUOTA');
    const winner = uploads.find((result) => result.status === 'fulfilled').value;
    assert.equal((await quota.objects.get(winner)).length, 4);
    const tinyMetadata = new PostgresCheckpointRepository({ pool, namespace: namespaces[3], maxMetadataBytes: 20 });
    await tinyMetadata.commit('small', 0, { value: 'small' });
    await assert.rejects(tinyMetadata.commit('second', 0, { value: 'small' }), code('METADATA_QUOTA'));
    assert.deepEqual((await tinyMetadata.load('small')).state, { value: 'small' });
  } finally {
    for (const namespace of namespaces) {
      for (const cleanupRef of cleanupRefs) {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${namespace}/${cleanupRef.key}` })).catch(() => {});
      }
      await pool.query('DELETE FROM gm_workspace_checkpoints WHERE repository_namespace = $1', [namespace]).catch(() => {});
      await pool.query('DELETE FROM gm_cloud_objects WHERE store_namespace = $1', [namespace]).catch(() => {});
    }
    client.destroy();
    await pool.end();
  }
});
