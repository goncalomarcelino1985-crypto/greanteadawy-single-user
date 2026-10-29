import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCloudRoundTrip, runValidationCli } from '../src/cli/cloud-validate.js';
import { sha256, verifyObject } from '../src/persistence/index.js';

function settings() {
  const binding = { projectId: 'synthetic-project-1234', branchId: 'br-synthetic-validation',
    database: { host: 'ep-synthetic.eu-central-1.aws.neon.tech', name: 'gm_ai_worker', role: 'gm_worker_runtime' },
    objects: { endpoint: 'https://synthetic.example.invalid/branch', bucket: 'private-test', region: 'eu-central-1' } };
  const reader = structuredClone(binding);
  reader.database.role = 'gm_worker_reader';
  const config = (b, prefix) => Object.fromEntries(Object.entries({
    BINDING_JSON: JSON.stringify(b), DATABASE_URL: `postgresql://${b.database.role}:FAKE_SECRET@${b.database.host}/${b.database.name}`,
    OBJECT_ENDPOINT: b.objects.endpoint, OBJECT_BUCKET: b.objects.bucket, OBJECT_REGION: b.objects.region,
    OBJECT_ACCESS_KEY_ID: 'FAKE_KEY', OBJECT_SECRET_ACCESS_KEY: 'FAKE_SECRET'
  }).map(([name, value]) => [prefix + name, value]));
  return { ...config(binding, 'CLOUD_'), ...config(reader, 'READER_'),
    CLOUD_VALIDATION_PROJECT_ID: binding.projectId, CLOUD_VALIDATION_BRANCH_ID: binding.branchId };
}

function fakeCloud({ occupied = false, rejectReader = false, corruptReopen = false, readerGuard = true } = {}) {
  const records = new Map(), objects = new Map(), connections = [], writes = [];
  const openStores = async (_config, { readOnly }) => {
    if (readOnly && rejectReader) throw Object.assign(new Error('Unsafe reader'), { code: 'CLOUD_ACCESS_UNSAFE' });
    const connection = { readOnly, closed: 0 };
    connections.push(connection);
    const ordinal = connections.length;
    return {
      repository: {
        readOnly: readOnly && readerGuard,
        async load(id) { return structuredClone(records.get(id) || (occupied ? { generation: 1, state: { schemaVersion: 1, files: {} } } : null)); },
        async getGeneration(id) { return records.get(id)?.generation || 0; },
        async commit(id, generation, state) {
          if (readOnly) throw Object.assign(new Error('Read only'), { code: 'READ_ONLY' });
          assert.equal(generation, records.get(id)?.generation || 0);
          assert.match(id, /^synthetic-validation-[a-f0-9-]{36}$/);
          writes.push({ kind: 'metadata', id, generation: generation + 1, state: structuredClone(state) });
          records.set(id, { generation: generation + 1, state: structuredClone(state) });
          return generation + 1;
        }
      },
      objects: {
        readOnly,
        async put(bytes) {
          if (readOnly) throw Object.assign(new Error('Read only'), { code: 'READ_ONLY' });
          const key = sha256(bytes);
          const type = bytes.subarray(0, 4).toString();
          assert.ok(['RIFF', 'MThd'].includes(type));
          if (type === 'RIFF') assert.equal(bytes.length, 60);
          else assert.ok(bytes.length < 64 * 1024);
          writes.push({ kind: 'object', key });
          objects.set(key, Buffer.from(bytes));
          return { key, sha256: key, size: bytes.length };
        },
        async get(ref) {
          if (corruptReopen && ordinal === (corruptReopen === true ? 3 : corruptReopen)) return Buffer.from('corrupt');
          return verifyObject(ref, Buffer.from(objects.get(ref.key)));
        }
      },
      async disconnect() { connection.closed++; }
    };
  };
  return { openStores, connections, writes, records, objects };
}

test('synthetic validation reopens independent connections/cache, checks hashes and reader guards, and retains only its fixture', async () => {
  const env = settings();
  // An existing deployment workspace setting must never select the test target.
  env.CLOUD_WORKSPACE_ID = 'existing-workspace-must-not-be-used';
  const fake = fakeCloud();
  const progress = [];
  const result = await validateCloudRoundTrip({ env, openStores: fake.openStores, onProgress: (event) => progress.push(event) });
  assert.equal(result.status, 'verified');
  assert.match(result.workspaceId, /^synthetic-validation-/);
  assert.equal(result.generation, 2);
  assert.match(result.metadataSha256, /^[a-f0-9]{64}$/);
  assert.match(result.objectSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.objectBytes, 60);
  assert.equal(result.freshConnectionVerified, true);
  assert.equal(result.freshCacheVerified, true);
  assert.equal(result.readerDatabasePrivilegesVerified, true);
  assert.equal(result.readerMetadataWriteGuardVerified, true);
  assert.equal(result.readerObjectApplicationGuardVerified, true);
  for (const key of ['preferencesVerified', 'audioExportVerified', 'midiExportVerified', 'undoHistoryRestored',
    'operationReceiptRestored', 'retryIdempotencyVerified', 'undoRoundTripVerified']) assert.equal(result[key], true);
  assert.match(result.midiExportSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.midiExportBytes > 14 && result.midiExportBytes < 64 * 1024);
  assert.equal(result.objectCredentialReadOnlyVerified, false);
  assert.equal(result.independentBackupVerified, false);
  assert.equal(result.syntheticDataRetained, true);
  assert.equal(result.productionDeploymentPerformed, false);
  assert.deepEqual(fake.connections.map((c) => c.readOnly), [false, true, true, false, true]);
  assert.deepEqual(fake.connections.map((c) => c.closed), [1, 1, 1, 1, 1]);
  assert.deepEqual(fake.writes.map((w) => w.kind), ['object', 'object', 'object', 'metadata', 'metadata']);
  assert.equal(fake.records.size, 1);
  assert.equal(fake.objects.size, 2);
  const checkpoints = fake.writes.filter((write) => write.kind === 'metadata');
  assert.deepEqual(checkpoints.map((write) => write.generation), [1, 2]);
  const historyFile = Object.keys(checkpoints[0].state.files).find((name) => name.startsWith('history/'));
  const projectFile = Object.keys(checkpoints[0].state.files).find((name) => name.startsWith('projects/'));
  assert.equal(checkpoints[0].state.files[historyFile].value.undo.length, 1);
  assert.equal(checkpoints[1].state.files[historyFile].value.undo.length, 0);
  assert.equal(checkpoints[1].state.files[historyFile].value.receipts[0].rev, 1);
  assert.equal(checkpoints[0].state.files[projectFile].value.name, 'Synthetic storage validation edited');
  assert.equal(checkpoints[1].state.files[projectFile].value.name, 'Synthetic storage validation');
  assert.equal(checkpoints[1].state.files[projectFile].value.bpm, 126);
  assert.equal(checkpoints[1].state.files[projectFile].value.rev, 2);
  for (const name of Object.keys(checkpoints[0].state.files).filter((name) => /^(samples|exports|preferences)\//.test(name))) {
    assert.deepEqual(checkpoints[1].state.files[name], checkpoints[0].state.files[name]);
  }
  assert.deepEqual(progress.map((p) => p.status), ['starting', 'committed']);
  assert.ok(!JSON.stringify({ result, progress }).includes('FAKE_SECRET'));
});

test('missing or mismatched reviewed targets reject before any connection', async () => {
  const env = settings();
  const variants = [{ CLOUD_VALIDATION_PROJECT_ID: '' }, { CLOUD_VALIDATION_BRANCH_ID: '' },
    { CLOUD_VALIDATION_PROJECT_ID: 'another-project' }, { CLOUD_VALIDATION_BRANCH_ID: 'br-other' },
    { CLOUD_VALIDATION_DATABASE: 'another_database' }, { READER_BINDING_JSON: undefined },
    { READER_BINDING_JSON: env.CLOUD_BINDING_JSON, READER_DATABASE_URL: env.CLOUD_DATABASE_URL }];
  for (const patch of variants) {
    await assert.rejects(validateCloudRoundTrip({ env: { ...env, ...patch }, openStores: () => assert.fail('No network allowed') }));
  }
});

test('an occupied synthetic namespace is retained without object or metadata writes', async () => {
  const fake = fakeCloud({ occupied: true });
  await assert.rejects(validateCloudRoundTrip({ env: settings(), openStores: fake.openStores }), { code: 'VALIDATION_NAMESPACE_OCCUPIED' });
  assert.deepEqual(fake.writes, []);
  assert.deepEqual(fake.connections.map((c) => c.closed), [1, 1]);
});

test('reader privilege preflight must succeed before synthetic writes', async () => {
  const fake = fakeCloud({ rejectReader: true });
  await assert.rejects(validateCloudRoundTrip({ env: settings(), openStores: fake.openStores }), { code: 'CLOUD_ACCESS_UNSAFE' });
  assert.deepEqual(fake.writes, []);
  assert.deepEqual(fake.connections.map((c) => c.closed), [1]);
});

test('corrupt bytes after reopening fail validation and preserve the committed fixture', async () => {
  const fake = fakeCloud({ corruptReopen: true });
  await assert.rejects(validateCloudRoundTrip({ env: settings(), openStores: fake.openStores }), { code: 'OBJECT_CORRUPT' });
  assert.equal(fake.records.size, 1);
  assert.equal(fake.objects.size, 2);
  assert.deepEqual(fake.connections.map((c) => c.closed), [1, 1, 1]);
});

test('a missing reader guard cannot be reported as successful validation', async () => {
  const fake = fakeCloud({ readerGuard: false });
  await assert.rejects(validateCloudRoundTrip({ env: settings(), openStores: fake.openStores }), { code: 'VALIDATION_READER_GUARD' });
  assert.deepEqual(fake.writes.map((w) => w.kind), ['object', 'object', 'object', 'metadata']);
  assert.equal(fake.records.size, 1);
});

test('final verification must reopen and read cloud bytes again after durable Undo', async () => {
  const fake = fakeCloud({ corruptReopen: 5 });
  await assert.rejects(validateCloudRoundTrip({ env: settings(), openStores: fake.openStores }), { code: 'OBJECT_CORRUPT' });
  assert.equal([...fake.records.values()][0].generation, 2);
  assert.equal(fake.objects.size, 2);
  assert.deepEqual(fake.connections.map((c) => c.closed), [1, 1, 1, 1, 1]);
});

test('CLI redacts raw provider messages/codes and refuses a manual workspace argument', async () => {
  const reports = [];
  const result = await runValidationCli({ env: settings(), args: [], output: (value) => reports.push(value), errorOutput: (value) => reports.push(value),
    openStores: async () => { throw Object.assign(new Error('postgresql://owner:FAKE_SECRET@example.invalid/db'), { code: 'FAKE_SECRET' }); } });
  assert.equal(result, 1);
  assert.equal(reports.at(-1).code, 'CLOUD_VALIDATION_FAILED');
  assert.ok(!JSON.stringify(reports).includes('FAKE_SECRET'));
  assert.equal(await runValidationCli({ env: settings(), args: ['production'],
    openStores: () => assert.fail('No network allowed'), errorOutput: (value) => reports.push(value) }), 1);
  assert.equal(reports.at(-1).code, 'VALIDATION_NO_ARGUMENTS');
});

test('CLI reports object access denial explicitly without disclosing provider details', async () => {
  const reports = [];
  assert.equal(await runValidationCli({ env: settings(), args: [], output: (value) => reports.push(value), errorOutput: (value) => reports.push(value),
    openStores: async () => { throw Object.assign(new Error('FAKE_SECRET raw denial'), { code: 'OBJECT_ACCESS_DENIED' }); } }), 1);
  assert.deepEqual(reports.at(-1), { status: 'failed', code: 'OBJECT_ACCESS_DENIED' });
  assert.ok(!JSON.stringify(reports).includes('FAKE_SECRET'));
});
