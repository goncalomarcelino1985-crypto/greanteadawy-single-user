import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CloudWorkspace } from '../src/cloud-workspace.js';
import { SampleLibrary } from '../src/samples.js';
import { PluginStore } from '../src/plugins.js';
import { createLocalBackend } from '../src/backend.js';
import { sha256, verifyObject } from '../src/persistence/index.js';

const script = 'gtd.registerEffect({ create() { return { process() {} }; } });';
const plugin = {
  id: 'test.echo', name: 'Synthetic Echo', version: '1.0.0', enabled: true,
  manifest: { id: 'test.echo', main: 'dsp.js', samples: [{ file: 'tone.wav' }] }
};
const records = [
  { id: 'smp_a', ownerId: 'usr_a', name: 'Kick', file: 'smp_a.wav', rev: 1 },
  { id: 'smp_b', ownerId: 'usr_b', name: 'Foreign', file: 'smp_b.wav', rev: 1 }
];

async function fixture(t) {
  const bytes = new Map();
  let reads = 0, puts = 0, loads = 0, generationReads = 0;
  const blob = (text) => {
    const value = Buffer.from(text);
    const hash = sha256(value);
    bytes.set(hash, value);
    return { kind: 'blob', key: hash, sha256: hash, size: value.length, modifiedAt: '2026-10-20T12:00:00.000Z' };
  };
  const state = { schemaVersion: 1, files: {
    'samples/index.json': { kind: 'json', value: records },
    'samples/folders.json': { kind: 'json', value: [] },
    'samples/smp_a.wav': blob('synthetic kick'),
    'samples/smp_b.wav': blob('foreign sample bytes'),
    'exports/usr_a/mix.wav': blob('synthetic render'),
    'exports/usr_a/mix.mp3': blob('existing converted render'),
    'plugins/usr_a/registry.json': { kind: 'json', value: [plugin] },
    'plugins/usr_a/installed/test.echo/plugin.json': { kind: 'json', value: plugin.manifest },
    'plugins/usr_a/installed/test.echo/dsp.js': blob(script),
    'plugins/usr_a/installed/test.echo/tone.wav': blob('plugin tone'),
    'plugins/usr_b/installed/foreign/tone.wav': blob('foreign plugin tone')
  } };
  let checkpoint = { generation: 1, state: structuredClone(state) };
  const repository = {
    load: async () => { loads++; return structuredClone(checkpoint); },
    getGeneration: async () => { generationReads++; return checkpoint.generation; },
    commit: async (_id, expected, next) => {
      assert.equal(expected, checkpoint.generation);
      checkpoint = { generation: expected + 1, state: structuredClone(next) };
      return checkpoint.generation;
    }
  };
  const objects = {
    async get(ref) {
      reads++;
      if (!bytes.has(ref.key)) throw new Error('Missing audio');
      return verifyObject(ref, Buffer.from(bytes.get(ref.key)));
    },
    async put(value) {
      puts++;
      const hash = sha256(value);
      bytes.set(hash, Buffer.from(value));
      return { key: hash, sha256: hash, size: value.length };
    }
  };
  const cloud = await new CloudWorkspace({ repository, objects, workspaceId: 'studio' }).init();
  t.after(() => cloud.close());
  return { cloud, state, bytes, stats: () => ({ reads, puts, loads, generationReads }), checkpoint: () => checkpoint };
}

test('lazy boot reads metadata only; capture and idle requests preserve every unloaded reference', async (t) => {
  const { cloud, state, stats } = await fixture(t);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cloud.dataDir, 'samples/index.json'), 'utf8')), records);
  await assert.rejects(fs.access(path.join(cloud.dataDir, 'samples/smp_a.wav')), { code: 'ENOENT' });
  assert.deepEqual(await cloud.capture(), state);
  await cloud.run(async () => {});
  assert.deepEqual(stats(), { reads: 0, puts: 0, loads: 1, generationReads: 1 });
});

for (const method of ['getGeneration', 'load']) {
  test(`metadata ${method} outage fails closed once before invoking a transaction`, async (t) => {
    const { cloud, state, checkpoint } = await fixture(t);
    const committed = structuredClone(checkpoint());
    let failures = 0, calls = 0;
    cloud.onFailure = () => { failures++; };
    if (method === 'load') delete cloud.repository.getGeneration;
    cloud.repository[method] = async () => { throw new Error('Simulated metadata read outage'); };
    await assert.rejects(cloud.run(async () => { calls++; }), /Simulated metadata read outage/);
    assert.equal(cloud.failed, true);
    assert.equal(failures, 1);
    assert.equal(calls, 0);
    await assert.rejects(cloud.run(async () => { calls++; }), { status: 503 });
    assert.equal(failures, 1);
    assert.equal(calls, 0);
    assert.deepEqual(cloud.state, state);
    assert.deepEqual(checkpoint(), committed);
  });
}

for (const guard of ['guardBackend', 'guardMethods']) {
  for (const status of [undefined, 500, 400]) {
    test(`${guard} preserves validation errors but fails closed after a caught ${status || 'unexpected'} mutation error`, async (t) => {
      const { cloud, state, checkpoint } = await fixture(t);
      const committed = structuredClone(checkpoint());
      const error = Object.assign(new Error('Simulated mutation failure'), status ? { status } : {});
      let failures = 0;
      cloud.onFailure = () => { failures++; };
      let target = { applyOps: async () => { throw error; } };
      if (guard === 'guardBackend') target = cloud.guardBackend(target);
      else cloud.guardMethods(target, ['applyOps']);
      await assert.rejects(cloud.run(async () => {
        try { await target.applyOps(); } catch { /* MCP can translate an exception into a tool response. */ }
      }), (caught) => caught === error);
      const fatal = status !== 400;
      assert.equal(cloud.failed, fatal);
      assert.equal(failures, fatal ? 1 : 0);
      assert.deepEqual(cloud.state, state);
      assert.deepEqual(checkpoint(), committed);
      if (fatal) await assert.rejects(cloud.run(async () => {}), { status: 503 });
      else await cloud.run(async () => {});
      assert.equal(failures, fatal ? 1 : 0);
    });
  }
}

test('only the requested sample downloads, concurrent reads deduplicate, cache survives checkpoints', async (t) => {
  const { cloud, state, stats } = await fixture(t);
  const samples = await new SampleLibrary(cloud.dataDir, { cloud }).init();
  const [one, two] = await Promise.all([samples.ensureFile('smp_a', 'usr_a'), samples.ensureFile('smp_a', 'usr_a')]);
  assert.equal(one, two);
  assert.equal((await fs.readFile(one)).toString(), 'synthetic kick');
  await samples.ensureFile('smp_a', 'usr_a');
  assert.equal(stats().reads, 1);
  assert.equal(stats().puts, 0);
  assert.deepEqual(await cloud.capture(), state);
  await assert.rejects(fs.access(path.join(cloud.dataDir, 'samples/smp_b.wav')), { code: 'ENOENT' });
});

test('evicting a previously loaded cache file preserves its cloud reference and permits rehydration', async (t) => {
  const { cloud, state, stats } = await fixture(t);
  const name = 'samples/smp_a.wav';
  const file = await cloud.ensureFile(name);
  assert.equal(stats().reads, 1);
  await fs.rm(file);
  assert.equal(await cloud.fileExists(file), true);
  assert.deepEqual(await cloud.capture(), state);
  await cloud.run(async () => {});
  assert.equal(stats().puts, 0);
  assert.equal((await cloud.listFiles(path.dirname(file))).find((entry) => entry.name === 'smp_a.wav').bytes, state.files[name].size);
  assert.equal(await cloud.ensureFile(name), file);
  assert.equal((await fs.readFile(file)).toString(), 'synthetic kick');
  assert.equal(stats().reads, 2);
  assert.deepEqual(await cloud.capture(), state);
});

test('manifest-backed export listing and collision checks fetch no audio', async (t) => {
  const { cloud, stats } = await fixture(t);
  const dir = path.join(cloud.dataDir, 'exports/usr_a');
  assert.deepEqual((await cloud.listFiles(dir)).map((entry) => entry.name).sort(), ['mix.mp3', 'mix.wav']);
  assert.equal((await cloud.listFiles(dir))[0].createdAt, '2026-10-20T12:00:00.000Z');
  assert.equal(await cloud.fileExists(path.join(dir, 'mix.wav')), true);
  assert.equal(await cloud.fileExists(path.join(dir, 'new.wav')), false);
  assert.equal(stats().reads, 0);
});

test('failed sample replacement and foreign deletion preserve all cloud-only references', async (t) => {
  const { cloud, state, stats } = await fixture(t);
  const samples = await new SampleLibrary(cloud.dataDir, { cloud }).init();
  await assert.rejects(samples.replaceFile('smp_a', 'usr_a', { buffer: Buffer.alloc(0), originalName: 'new.wav', mime: 'audio/wav' }), /empty/);
  await assert.rejects(samples.remove('smp_b', 'usr_a'), /not found/);
  assert.deepEqual(await cloud.capture(), state);
  assert.equal(stats().reads, 0);
});

test('unloaded sample deletion and extension replacement cannot resurrect old bytes', async (t) => {
  const { cloud, state, stats } = await fixture(t);
  const samples = await new SampleLibrary(cloud.dataDir, { cloud }).init();
  samples.ingest = async (id) => {
    const file = `${id}.mp3`;
    await fs.writeFile(path.join(samples.dir, file), 'replacement');
    return { file, mime: 'audio/mpeg', size: 11 };
  };
  await samples.replaceFile('smp_a', 'usr_a', {});
  let captured = await cloud.capture();
  assert.equal(captured.files['samples/smp_a.wav'], undefined);
  assert.equal(captured.files['samples/smp_a.mp3'].sha256, sha256('replacement'));
  assert.deepEqual(captured.files['samples/smp_b.wav'], state.files['samples/smp_b.wav']);
  await samples.remove('smp_a', 'usr_a');
  captured = await cloud.capture();
  assert.equal(captured.files['samples/smp_a.mp3'], undefined);
  assert.deepEqual(captured.files['samples/smp_b.wav'], state.files['samples/smp_b.wav']);
  assert.equal(stats().reads, 0);
});

test('plugin code and sample hydrate individually; removal forgets only that plugin', async (t) => {
  const { cloud, state, stats } = await fixture(t);
  const plugins = await new PluginStore(cloud.dataDir, { cloud }).init();
  assert.equal(await plugins.code('usr_a', plugin), script);
  assert.equal(stats().reads, 1);
  assert.equal((await plugins.sample('usr_a', plugin, 'tone.wav')).data.toString(), 'plugin tone');
  assert.equal(stats().reads, 2);
  await plugins.remove('usr_a', plugin.id);
  const captured = await cloud.capture();
  assert.equal(Object.keys(captured.files).some((name) => name.startsWith('plugins/usr_a/installed/test.echo/')), false);
  assert.deepEqual(captured.files['plugins/usr_b/installed/foreign/tone.wav'], state.files['plugins/usr_b/installed/foreign/tone.wav']);
});

test('plugin update drops unloaded obsolete files without downloading them', async (t) => {
  const { cloud, state, stats } = await fixture(t);
  const plugins = await new PluginStore(cloud.dataDir, { cloud }).init();
  const manifest = { ...plugin.manifest, version: '2.0.0', name: plugin.name, type: 'effect', samples: [] };
  plugins.pending.set('token', { userId: 'usr_a', expires: Date.now() + 10000, manifest, sha256: 'a'.repeat(64),
    files: new Map([['plugin.json', Buffer.from(JSON.stringify(manifest))], ['dsp.js', Buffer.from(script + '\n// updated')]]) });
  await plugins.install('usr_a', 'token');
  const captured = await cloud.capture();
  assert.equal(captured.files['plugins/usr_a/installed/test.echo/tone.wav'], undefined);
  assert.equal(captured.files['plugins/usr_a/installed/test.echo/dsp.js'].sha256, sha256(script + '\n// updated'));
  assert.deepEqual(captured.files['plugins/usr_b/installed/foreign/tone.wav'], state.files['plugins/usr_b/installed/foreign/tone.wav']);
  assert.equal(stats().reads, 0);
});

test('conversion hydrates its input and knows unloaded output collisions; export deletion needs no fetch', async (t) => {
  const { cloud, state, stats } = await fixture(t);
  const backend = createLocalBackend({ store: { dataDir: cloud.dataDir }, samples: {}, users: {}, user: { id: 'usr_a', username: 'owner' }, cloud,
    ffmpeg: { async convert({ input, fileExists }) {
      assert.equal((await fs.readFile(input)).toString(), 'synthetic render');
      assert.equal(await fileExists(path.join(path.dirname(input), 'mix.mp3')), true);
      assert.equal(await fileExists(path.join(path.dirname(input), 'mix-2.mp3')), false);
      return { name: 'mix-2.mp3', bytes: 10, format: 'mp3', encoder: 'test' };
    } } });
  assert.equal((await backend.convertExport('mix.wav', { format: 'mp3' })).name, 'mix-2.mp3');
  assert.equal(stats().reads, 1);
  await backend.deleteExport('mix.mp3');
  const captured = await cloud.capture();
  assert.equal(captured.files['exports/usr_a/mix.mp3'], undefined);
  assert.deepEqual(captured.files['exports/usr_a/mix.wav'], state.files['exports/usr_a/mix.wav']);
  assert.equal(stats().reads, 1);
});

test('missing audio is rejected on demand without deleting its authoritative reference', async (t) => {
  const { cloud, state, bytes } = await fixture(t);
  bytes.delete(state.files['samples/smp_a.wav'].key);
  await assert.rejects(cloud.ensureFile('samples/smp_a.wav'), /Missing audio/);
  assert.deepEqual(await cloud.capture(), state);
  await assert.rejects(cloud.ensureFile('../outside'), /Invalid cloud/);
});
