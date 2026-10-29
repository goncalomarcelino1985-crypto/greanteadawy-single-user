import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openCloudStores, validateCloudConfig, assertIndependentCloudBindings, connectCloud } from '../src/cloud-provider.js';
import { cloudConfig } from '../src/config.js';

const binding = {
  projectId: 'synthetic-project-12345678', branchId: 'br-synthetic-branch',
  database: { host: 'ep-synthetic.eu-central-1.aws.neon.tech', name: 'gm_test', role: 'gm_worker_runtime' },
  objects: { endpoint: 'https://synthetic.objects.example.invalid/branch', bucket: 'private-test', region: 'eu-central-1' }
};
const config = { binding: JSON.stringify(binding), databaseUrl: `postgresql://gm_worker_runtime:FAKE_SECRET@${binding.database.host}/gm_test?ssl=0&sslmode=disable`,
  ...binding.objects, accessKeyId: 'fake', secretAccessKey: 'fake' };
const allowed = () => ({ role_name: 'gm_worker_runtime', database_name: 'gm_test', role_safe: true, no_memberships: true,
  no_database_ddl: true, no_schema_ddl: true, not_owner: true, schema_usage: true, can_read: true, can_write: true, no_destructive_grants: true, read_only: false });

test('reviewed exact binding pins all destinations and replaces URI SSL options with verified TLS', () => {
  const { poolOptions } = validateCloudConfig(config);
  assert.deepEqual(poolOptions.ssl, { rejectUnauthorized: true });
  assert.equal(poolOptions.options, '-c search_path=pg_catalog,public');
  const uri = new URL(poolOptions.connectionString);
  assert.equal(uri.searchParams.has('ssl'), false);
  assert.equal(uri.searchParams.has('sslmode'), false);
});

test('binding and URL mistakes fail before opening a client and never disclose secret input', async () => {
  const variants = [
    { binding: undefined }, { binding: 'FAKE_SECRET invalid-json' }, { binding: { ...binding, branchId: 'main' } },
    { binding: { ...binding, secret: 'FAKE_SECRET' } },
    { databaseUrl: config.databaseUrl.replace(binding.database.host, 'different.example.invalid') },
    { databaseUrl: config.databaseUrl.replace('gm_worker_runtime:', 'owner:') },
    { databaseUrl: config.databaseUrl.replace('/gm_test?', '/other?') },
    { databaseUrl: config.databaseUrl.replace('?ssl=0&sslmode=disable', '?options=-c%20search_path%3Devil') },
    { databaseUrl: config.databaseUrl.replace('?ssl=0&sslmode=disable', '?host=another.example.invalid') },
    { endpoint: 'https://different.objects.example.invalid/branch' }, { endpoint: `${config.endpoint}?secret=FAKE_SECRET` },
    { bucket: 'other-private' }, { region: 'us-east-2' }, { initializeSchema: true },
    ...['databaseUrl', 'endpoint'].map((field) => ({ [field]: 'FAKE_SECRET not-a-url' }))
  ];
  for (const patch of variants) {
    await assert.rejects(openCloudStores({ ...config, ...patch }, { makePool: () => assert.fail('Must validate before connecting') }), (error) => {
      assert.ok(!String(error).includes('FAKE_SECRET'));
      assert.equal(error.input, undefined);
      return true;
    });
  }
});

test('backup isolation checks reviewed project identity even when roles and endpoints differ', () => {
  const otherBinding = structuredClone(binding);
  otherBinding.branchId = 'br-other-branch';
  otherBinding.database.host = 'ep-other.eu-central-1.aws.neon.tech';
  otherBinding.database.role = 'gm_worker_reader';
  otherBinding.objects.endpoint = 'https://other.objects.example.invalid/branch';
  const other = { ...config, binding: otherBinding, endpoint: otherBinding.objects.endpoint,
    databaseUrl: `postgresql://gm_worker_reader:FAKE_SECRET@${otherBinding.database.host}/gm_test` };
  assert.throws(() => assertIndependentCloudBindings(config, other), { code: 'BACKUP_NOT_ISOLATED' });
  otherBinding.projectId = 'other-synthetic-project';
  assert.doesNotThrow(() => assertIndependentCloudBindings(config, other));
});

test('invalid workspace identifiers fail before database setup or network access', async () => {
  await assert.rejects(connectCloud({ storageMode: 'cloud', singleUser: true, cloud: { workspaceId: '../invalid' } }), /Invalid CLOUD_WORKSPACE_ID/);
});

test('runtime and maintenance share the prefixed binding parser without implicit providers or credentials', () => {
  const actual = cloudConfig({ BACKUP_BINDING_JSON: config.binding, BACKUP_DATABASE_URL: config.databaseUrl,
    BACKUP_OBJECT_ENDPOINT: config.endpoint, BACKUP_OBJECT_BUCKET: config.bucket, BACKUP_OBJECT_REGION: config.region,
    BACKUP_OBJECT_ACCESS_KEY_ID: 'backup-id', BACKUP_OBJECT_SECRET_ACCESS_KEY: 'backup-secret' }, 'BACKUP_');
  assert.equal(actual.binding, config.binding);
  assert.equal(actual.databaseUrl, config.databaseUrl);
  assert.equal(actual.initializeSchema, false);
  assert.equal(actual.accessKeyId, 'backup-id');
  assert.equal(cloudConfig({}).databaseUrl, undefined);
});

test('startup runs only a read-only privilege preflight before creating S3 client', async () => {
  const queries = [];
  let closed = 0, destroyed = 0;
  const stores = await openCloudStores(config, {
    makePool: () => ({ query: async (sql) => { queries.push(sql); return { rows: [allowed()] }; }, connect: () => assert.fail('No transaction at startup'), end: async () => closed++ }),
    makeClient: (options) => { assert.equal(options.forcePathStyle, true); return { send: () => assert.fail('No S3 call at startup'), destroy: () => destroyed++ }; }
  });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^\s*SELECT /);
  assert.doesNotMatch(queries[0], /(?:CREATE|DROP|ALTER|GRANT)\s+(?:TABLE|ROLE|SCHEMA)/i);
  await stores.disconnect();
  assert.equal(closed, 1); assert.equal(destroyed, 1);
});

test('unsafe database grants fail closed and close the pool before S3 is created', async () => {
  for (const field of ['role_safe', 'no_memberships', 'no_database_ddl', 'no_schema_ddl', 'not_owner', 'schema_usage', 'can_read', 'can_write', 'no_destructive_grants']) {
    let closed = false;
    await assert.rejects(openCloudStores(config, {
      makePool: () => ({ query: async () => ({ rows: [{ ...allowed(), [field]: false }] }), end: async () => { closed = true; } }),
      makeClient: () => assert.fail('Do not open object storage after failed database preflight')
    }), { code: 'CLOUD_ACCESS_UNSAFE' });
    assert.equal(closed, true);
  }
});

test('read-only backup source rejects writes before any SQL reservation or S3 call', async () => {
  let queries = 0;
  const stores = await openCloudStores(config, { readOnly: true,
    makePool: () => ({ query: async () => { queries++; return { rows: [{ ...allowed(), can_write: false, read_only: true }] }; }, connect: () => assert.fail('No write transaction'), end: async () => {} }),
    makeClient: () => ({ send: () => assert.fail('No object write'), destroy: () => {} })
  });
  try {
    await assert.rejects(stores.repository.commit('studio', 0, {}), { code: 'READ_ONLY' });
    await assert.rejects(stores.objects.put(Buffer.from('synthetic')), { code: 'READ_ONLY' });
    assert.equal(queries, 1);
  } finally { await stores.disconnect(); }
});

test('raw PostgreSQL failures do not leak connection details', async () => {
  await assert.rejects(openCloudStores(config, {
    makePool: () => ({ query: async () => { throw new Error('FAKE_SECRET'); }, end: async () => {} }),
    makeClient: () => assert.fail('No S3 client after failure')
  }), (error) => error.code === 'CLOUD_ACCESS_UNVERIFIED' && !String(error).includes('FAKE_SECRET'));
});
