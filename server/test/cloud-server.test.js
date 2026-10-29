// Full server boundary tests with injected in-memory cloud doubles. These prove
// application behavior, not the availability/durability of any real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from '../src/index.js';
import { CloudWorkspace } from '../src/cloud-workspace.js';
import { loadConfig } from '../src/config.js';
import { openSocket, waitFor, makeWav, mcpClient, callTool } from './helpers.js';

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

class MemoryRepository {
  records = new Map();
  failCommit = false;
  failLoad = false;
  pending = null;
  commits = 0;

  holdNextCommit() {
    const entered = deferred();
    const released = deferred();
    this.pending = { entered, released };
    return { entered: entered.promise, release: () => released.resolve() };
  }

  async load(id) {
    if (this.failLoad) throw new Error('Simulated metadata read outage');
    return structuredClone(this.records.get(id) || null);
  }

  async commit(id, expected, state) {
    const gate = this.pending;
    this.pending = null;
    if (gate) { gate.entered.resolve(); await gate.released.promise; }
    if (this.failCommit) throw new Error('Simulated metadata commit outage');
    const current = this.records.get(id)?.generation || 0;
    if (current !== expected) throw Object.assign(new Error('Checkpoint conflict'), { code: 'CHECKPOINT_CONFLICT' });
    this.records.set(id, { generation: current + 1, state: structuredClone(state) });
    this.commits++;
    return current + 1;
  }
}

class MemoryObjects {
  bytes = new Map();
  failPut = false;

  async put(input) {
    if (this.failPut) throw new Error('Simulated audio upload outage');
    const bytes = Buffer.from(input);
    const sha256 = digest(bytes);
    this.bytes.set(sha256, bytes);
    return { key: sha256, sha256, size: bytes.length };
  }

  async get(ref) {
    const bytes = this.bytes.get(ref.key);
    if (!bytes || bytes.length !== ref.size || digest(bytes) !== ref.sha256) throw new Error('Missing or corrupt audio object');
    return Buffer.from(bytes);
  }
}

function environment() {
  return { repository: new MemoryRepository(), objects: new MemoryObjects(), workspaceId: 'test-studio', key: crypto.randomBytes(32).toString('base64url') };
}

async function start(t, env, { initialize = false } = {}) {
  const cloud = await new CloudWorkspace({ ...env, allowInitialize: initialize }).init();
  const ctx = await createServer({ ...loadConfig({ SINGLE_USER: 'true', PRIVATE_ACCESS_KEY: env.key, STORAGE_MODE: 'cloud', FFMPEG_PATH: 'off' }), cloudWorkspace: cloud, port: 0, clientDist: `${cloud.dataDir}/no-client` });
  await new Promise((resolve, reject) => { ctx.server.once('error', reject); ctx.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(ctx.sessions.sweeper);
    clearTimeout(ctx.sessions.timer);
    for (const client of ctx.hub.clients) client.ws.terminate();
    ctx.hub.wss.close();
    ctx.server.closeAllConnections?.();
    await new Promise((resolve) => ctx.server.close(resolve));
    await cloud.close();
  };
  t.after(close);
  return { ...ctx, cloud, base, close };
}

async function browser(srv, previousCookie) {
  const cookie = previousCookie || (await fetch(`${srv.base}/private/access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: srv.config.privateAccessKey }) })).headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const raw = (route, method = 'GET', body, extra = {}) => fetch(srv.base + route, {
    method, headers: { cookie, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...extra },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)
  });
  const request = async (...args) => {
    const response = await raw(...args);
    const body = await response.json();
    return { status: response.status, body };
  };
  return { cookie, raw, request };
}

async function subscribed(srv, cookie, projectId) {
  const socket = openSocket(srv.base, cookie);
  assert.equal(await socket.opened, true);
  socket.ws.send(JSON.stringify({ type: 'hello', clientId: crypto.randomUUID() }));
  socket.ws.send(JSON.stringify({ type: 'subscribe', projectId }));
  await waitFor(() => socket.messages.find((m) => m.type === 'project' && m.project.id === projectId));
  socket.messages.length = 0;
  return socket;
}

function upload(bytes, name = 'synthetic-kick.wav') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), name);
  return form;
}

test('cloud server restores projects, samples, audio/MIDI exports, preferences, owner, token, versions and Undo from a new empty cache', async (t) => {
  const env = environment();
  const first = await start(t, env, { initialize: true });
  const ui = await browser(first);
  const owner = first.users.firstAdmin().id;
  const created = await ui.request('/api/projects', 'POST', { template: 'house', name: 'House sintético 126', bpm: 126 });
  assert.equal(created.status, 201);
  const project = created.body;
  assert.ok(project.channels.length > 0);
  assert.equal((await ui.request('/api/active', 'PUT', { projectId: project.id })).status, 200);
  const tokenResponse = await ui.request('/api/me/token', 'POST');
  assert.equal(tokenResponse.status, 201);
  const token = tokenResponse.body.token;
  assert.equal((await ui.request(`/api/projects/${project.id}/versions`, 'POST', { name: 'Antes da alteração', source: 'mcp' })).status, 201);
  assert.equal((await ui.request(`/api/projects/${project.id}/ops`, 'POST', { source: 'mcp', ops: [{ type: 'project/update', patch: { name: 'House 126 confirmado' } }] })).status, 200);
  const wav = makeWav(0.01);
  const sample = await ui.request('/api/samples', 'POST', upload(wav));
  assert.equal(sample.status, 201);
  const audio = await ui.request('/api/exports', 'POST', upload(wav));
  assert.equal(audio.status, 201);
  const midi = await ui.request(`/api/projects/${project.id}/export-midi`, 'POST', {});
  assert.equal(midi.status, 200);
  const midiBytes = Buffer.from(await (await ui.raw(`/api/exports/${encodeURIComponent(midi.body.name)}`)).arrayBuffer());
  assert.equal(midiBytes.subarray(0, 4).toString(), 'MThd');
  const preferences = { snap: 'bar', metronome: true, kbOctave: 5, recorderPreferences: { countIn: 2, channels: 1 }, collapsedSampleFolders: [] };
  assert.equal((await ui.request('/api/preferences', 'PUT', { revision: 0, preferences })).status, 200);
  const stored = await env.repository.load(env.workspaceId);
  assert.equal(stored.state.files[`projects/${project.id}.json`].kind, 'json');
  assert.equal(stored.state.files[`history/${project.id}.json`].kind, 'json');
  assert.equal(stored.state.files['samples/index.json'].kind, 'json');
  assert.equal(stored.state.files[`samples/${sample.body.file}`].kind, 'blob');
  assert.equal(stored.state.files[`exports/${owner}/${audio.body.export.name}`].kind, 'blob');
  assert.ok(!JSON.stringify(stored.state).includes(token));
  assert.ok(!JSON.stringify(stored.state).includes(env.key));
  const oldDir = first.config.dataDir;
  await first.close();
  await assert.rejects(fs.access(oldDir), { code: 'ENOENT' });

  const second = await start(t, env);
  const resumed = await browser(second, ui.cookie);
  assert.notEqual(second.config.dataDir, oldDir);
  assert.equal(second.users.firstAdmin().id, owner);
  const auth = await resumed.request('/api/auth/status');
  assert.equal(auth.body.singleUser, true);
  assert.equal(auth.body.ephemeralStorage, false);
  assert.equal(auth.body.cloudPreferences, true);
  const fromToken = await fetch(second.base + `/api/projects/${project.id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(fromToken.status, 200);
  const restored = await fromToken.json();
  assert.equal(restored.name, 'House 126 confirmado');
  assert.equal(restored.bpm, 126);
  assert.equal(restored.channels.length, project.channels.length);
  assert.equal((await resumed.request('/api/active')).body.projectId, project.id);
  assert.deepEqual((await resumed.request('/api/preferences')).body, { revision: 1, preferences });
  assert.equal((await resumed.request(`/api/projects/${project.id}/versions`)).body.length, 1);
  assert.deepEqual(Buffer.from(await (await resumed.raw(`/api/samples/${sample.body.id}/file`)).arrayBuffer()), wav);
  assert.deepEqual(Buffer.from(await (await resumed.raw(`/api/exports/${encodeURIComponent(audio.body.export.name)}`)).arrayBuffer()), wav);
  assert.deepEqual(Buffer.from(await (await resumed.raw(`/api/exports/${encodeURIComponent(midi.body.name)}`)).arrayBuffer()), midiBytes);
  const undone = await resumed.request(`/api/projects/${project.id}/undo`, 'POST', {});
  assert.equal(undone.status, 200);
  assert.equal(undone.body.project.name, project.name);
});

test('HTTP success, WebSocket events and concurrent reads wait for the metadata commit', async (t) => {
  const env = environment();
  const srv = await start(t, env, { initialize: true });
  const ui = await browser(srv);
  const project = (await ui.request('/api/projects')).body[0];
  const socket = await subscribed(srv, ui.cookie, project.id);
  const gate = env.repository.holdNextCommit();
  let responseReceived = false;
  const writing = ui.request(`/api/projects/${project.id}/ops`, 'POST', { source: 'mcp', ops: [{ type: 'project/update', patch: { bpm: 126 } }] }).then((result) => { responseReceived = true; return result; });
  await gate.entered;
  let readReceived = false;
  const reading = ui.request(`/api/projects/${project.id}`).then((result) => { readReceived = true; return result; });
  await pause(30);
  assert.equal(responseReceived, false);
  assert.equal(readReceived, false);
  assert.equal(socket.messages.some((m) => m.type === 'ops'), false);
  gate.release();
  assert.equal((await writing).status, 200);
  assert.equal((await reading).body.bpm, 126);
  await waitFor(() => socket.messages.some((m) => m.type === 'ops'));

  socket.messages.length = 0;
  const wsGate = env.repository.holdNextCommit();
  socket.ws.send(JSON.stringify({ type: 'ops', projectId: project.id, opId: 'durable-ack', ops: [{ type: 'project/update', patch: { bpm: 127 } }] }));
  await wsGate.entered;
  await pause(30);
  assert.equal(socket.messages.some((m) => m.type === 'ack'), false);
  wsGate.release();
  const ack = await waitFor(() => socket.messages.find((m) => m.type === 'ack' && m.opId === 'durable-ack'));
  assert.equal((await env.repository.load(env.workspaceId)).state.files[`projects/${project.id}.json`].value.rev, ack.rev);
});

test('MCP SSE success waits for durable commit and a rejected commit never reports tool success', async (t) => {
  const env = environment();
  const srv = await start(t, env, { initialize: true });
  const ui = await browser(srv);
  const project = (await ui.request('/api/projects')).body[0];
  const token = (await ui.request('/api/me/token', 'POST')).body.token;
  const client = await mcpClient(srv.base, token);
  t.after(() => client.close());
  const call = callTool(client);
  const gate = env.repository.holdNextCommit();
  let completed = false;
  const change = call('update_project', { projectId: project.id, bpm: 126 }).then((text) => { completed = true; return text; });
  await gate.entered;
  await pause(30);
  assert.equal(completed, false);
  gate.release();
  assert.match(await change, /126 BPM/);
  assert.equal((await env.repository.load(env.workspaceId)).state.files[`projects/${project.id}.json`].value.bpm, 126);
  env.repository.failCommit = true;
  await assert.rejects(call('update_project', { projectId: project.id, bpm: 140 }));
  assert.equal(srv.cloud.failed, true);
  assert.equal((await env.repository.load(env.workspaceId)).state.files[`projects/${project.id}.json`].value.bpm, 126);
});

test('failed sample cache save cannot expose an uncommitted in-memory edit and restart restores the committed value', async (t) => {
  const env = environment();
  const srv = await start(t, env, { initialize: true });
  const ui = await browser(srv);
  const sample = await ui.request('/api/samples', 'POST', upload(makeWav(0.01)));
  assert.equal(sample.status, 201);
  const before = await env.repository.load(env.workspaceId);
  srv.samples.save = async () => { throw new Error('Simulated cache write failure'); };
  const failed = await ui.request(`/api/samples/${sample.body.id}`, 'PATCH', { name: 'Never committed' });
  assert.equal(failed.status, 503);
  assert.equal(srv.cloud.failed, true);
  assert.equal((await ui.request('/api/samples')).status, 503);
  assert.deepEqual(await env.repository.load(env.workspaceId), before);
  await srv.close();
  const restarted = await start(t, env);
  const resumed = await browser(restarted, ui.cookie);
  const restored = await resumed.request('/api/samples');
  assert.equal(restored.status, 200);
  assert.equal(restored.body.find((entry) => entry.id === sample.body.id).name, sample.body.name);
});

test('commit failure sends no success or edit event, closes sockets and blocks reads until reconstruction', async (t) => {
  const env = environment();
  const srv = await start(t, env, { initialize: true });
  const ui = await browser(srv);
  const project = (await ui.request('/api/projects')).body[0];
  const socket = await subscribed(srv, ui.cookie, project.id);
  const before = await env.repository.load(env.workspaceId);
  const closed = new Promise((resolve) => socket.ws.once('close', resolve));
  env.repository.failCommit = true;
  socket.ws.send(JSON.stringify({ type: 'ops', projectId: project.id, opId: 'never-acknowledged', ops: [{ type: 'project/update', patch: { bpm: 140 } }] }));
  await waitFor(() => srv.cloud.failed);
  assert.equal(await closed, 1012);
  assert.equal(socket.messages.some((m) => m.type === 'ack' || m.type === 'ops'), false);
  assert.equal((await ui.request(`/api/projects/${project.id}`)).status, 503);
  assert.equal((await fetch(srv.base + '/api/health')).status, 503);
  assert.deepEqual(await env.repository.load(env.workspaceId), before);
  await srv.close();
  env.repository.failCommit = false;
  const resumed = await start(t, env);
  const recovered = await browser(resumed, ui.cookie);
  const restored = (await recovered.request(`/api/projects/${project.id}`)).body;
  assert.equal(restored.rev, before.state.files[`projects/${project.id}.json`].value.rev);
  assert.equal(restored.bpm, before.state.files[`projects/${project.id}.json`].value.bpm);
});

test('lost WebSocket ACK and a new cache do not duplicate the same musical operation', async (t) => {
  const env = environment();
  const srv = await start(t, env, { initialize: true });
  const ui = await browser(srv);
  const project = (await ui.request('/api/projects')).body[0];
  const socket = await subscribed(srv, ui.cookie, project.id);
  const operation = { type: 'ops', projectId: project.id, opId: 'lost-ack', ops: [{ type: 'channel/add', channel: { kind: 'kick', name: 'Kick sintético', mixerTrack: 'auto' } }] };
  const gate = env.repository.holdNextCommit();
  socket.ws.send(JSON.stringify(operation));
  await gate.entered;
  socket.ws.terminate();
  gate.release();
  await srv.cloud.tail;
  const committed = (await env.repository.load(env.workspaceId)).state.files[`projects/${project.id}.json`].value;
  await srv.close();
  const second = await start(t, env);
  const resumed = await browser(second, ui.cookie);
  const retrySocket = await subscribed(second, ui.cookie, project.id);
  retrySocket.ws.send(JSON.stringify(operation));
  const ack = await waitFor(() => retrySocket.messages.find((m) => m.type === 'ack' && m.opId === operation.opId));
  assert.equal(ack.duplicate, true);
  assert.equal(ack.rev, committed.rev);
  const actual = (await resumed.request(`/api/projects/${project.id}`)).body;
  assert.equal(actual.rev, committed.rev);
  assert.equal(actual.channels.filter((channel) => channel.name === 'Kick sintético').length, 1);
  retrySocket.ws.send(JSON.stringify({ ...operation, ops: [{ type: 'project/update', patch: { bpm: 155 } }] }));
  const rejected = await waitFor(() => retrySocket.messages.find((m) => m.type === 'error' && m.opId === operation.opId));
  assert.equal(rejected.status, 409);
  assert.equal(second.cloud.failed, false);
  assert.equal((await resumed.request(`/api/projects/${project.id}`)).body.rev, committed.rev);
});

test('an uncertain successful commit closes the old instance and restores the actual cloud revision', async (t) => {
  const env = environment();
  const srv = await start(t, env, { initialize: true });
  const ui = await browser(srv);
  const project = (await ui.request('/api/projects')).body[0];
  const commit = env.repository.commit.bind(env.repository);
  let failOnce = true;
  env.repository.commit = async (...args) => {
    const generation = await commit(...args);
    if (failOnce) { failOnce = false; throw new Error('Reply lost after successful commit'); }
    return generation;
  };
  const result = await ui.request(`/api/projects/${project.id}/ops`, 'POST', { ops: [{ type: 'project/update', patch: { bpm: 126 } }] });
  assert.equal(result.status, 503);
  assert.equal(srv.cloud.failed, true);
  const committed = (await env.repository.load(env.workspaceId)).state.files[`projects/${project.id}.json`].value;
  assert.equal(committed.bpm, 126);
  await srv.close();
  const second = await start(t, env);
  const resumed = await browser(second, ui.cookie);
  assert.equal((await resumed.request(`/api/projects/${project.id}`)).body.rev, committed.rev);
  assert.equal((await resumed.request(`/api/projects/${project.id}`)).body.bpm, 126);
});

test('an old Render instance refuses stale reads after another process commits', async (t) => {
  const env = environment();
  const first = await start(t, env, { initialize: true });
  const ui = await browser(first);
  const project = (await ui.request('/api/projects')).body[0];
  const second = await start(t, env);
  const other = await browser(second, ui.cookie);
  assert.equal((await other.request(`/api/projects/${project.id}/ops`, 'POST', { ops: [{ type: 'project/update', patch: { bpm: 126 } }] })).status, 200);
  assert.equal((await ui.request(`/api/projects/${project.id}`)).status, 503);
  assert.equal(first.cloud.failed, true);
  assert.equal(second.cloud.failed, false);
  assert.equal((await other.request(`/api/projects/${project.id}`)).body.bpm, 126);
});

test('failed object upload preserves the last metadata checkpoint and rejects success', async (t) => {
  const env = environment();
  const srv = await start(t, env, { initialize: true });
  const ui = await browser(srv);
  const before = await env.repository.load(env.workspaceId);
  env.objects.failPut = true;
  const result = await ui.request('/api/samples', 'POST', upload(makeWav(0.01)));
  assert.equal(result.status, 503);
  assert.equal(srv.cloud.failed, true);
  assert.deepEqual(await env.repository.load(env.workspaceId), before);
  await srv.close();
  env.objects.failPut = false;
  const second = await start(t, env);
  assert.deepEqual((await (await browser(second, ui.cookie)).request('/api/samples')).body, []);
});

test('heavy browser jobs are refused over REST and MCP while lightweight musical edits remain available', async (t) => {
  const env = environment();
  const srv = await start(t, env, { initialize: true });
  const ui = await browser(srv);
  const project = (await ui.request('/api/projects')).body[0];
  const socket = await subscribed(srv, ui.cookie, project.id);
  for (const kind of ['render', 'analyze-sample', 'export-stems', 'spatial', 'generator', 'sample-edit']) {
    const rejected = await ui.request('/api/jobs', 'POST', { projectId: project.id, job: { kind } });
    assert.equal(rejected.status, 409, kind);
  }
  const token = (await ui.request('/api/me/token', 'POST')).body.token;
  const client = await mcpClient(srv.base, token);
  t.after(() => client.close());
  const call = callTool(client);
  await assert.rejects(call('render_mix', { project: project.id }), /Heavy jobs|Cloud audio processing/);
  assert.equal(srv.hub.jobs.size, 0);
  assert.equal(socket.messages.some((m) => m.type === 'job'), false);
  assert.equal(srv.cloud.failed, false);
  assert.equal((await ui.request(`/api/projects/${project.id}/ops`, 'POST', { ops: [{ type: 'project/update', patch: { bpm: 126 } }] })).status, 200);
});

test('aborted upload processing poisons the cache and late completion cannot enter the checkpoint', async (t) => {
  const env = environment();
  const srv = await start(t, env, { initialize: true });
  const ui = await browser(srv);
  const before = await env.repository.load(env.workspaceId);
  const entered = deferred();
  const released = deferred();
  const finished = deferred();
  const ingest = srv.samples.ingest.bind(srv.samples);
  srv.samples.ingest = async (...args) => {
    entered.resolve();
    await released.promise;
    try { return await ingest(...args); }
    finally { finished.resolve(); }
  };
  const controller = new AbortController();
  const request = fetch(srv.base + '/api/samples', { method: 'POST', headers: { cookie: ui.cookie }, body: upload(makeWav(0.01)), signal: controller.signal }).catch((error) => error);
  await entered.promise;
  controller.abort();
  await request;
  await waitFor(() => srv.cloud.failed);
  released.resolve();
  await finished.promise;
  await srv.samples.writing;
  assert.deepEqual(await env.repository.load(env.workspaceId), before);
  assert.equal((await ui.request('/api/projects')).status, 503);
});

test('cloud boot refuses absent/unavailable metadata and missing audio is rejected on demand', async () => {
  const env = environment();
  await assert.rejects(new CloudWorkspace(env).init(), /missing/);
  env.repository.failLoad = true;
  await assert.rejects(new CloudWorkspace({ ...env, allowInitialize: true }).init(), /read outage/);
  env.repository.failLoad = false;
  env.repository.records.set(env.workspaceId, { generation: 1, state: { schemaVersion: 1, files: { 'samples/missing.wav': { kind: 'blob', key: 'a'.repeat(64), sha256: 'a'.repeat(64), size: 2 } } } });
  const cloud = new CloudWorkspace(env);
  try {
    await cloud.init();
    await assert.rejects(cloud.ensureFile('samples/missing.wav'), /Missing or corrupt/);
    assert.equal((await cloud.capture()).files['samples/missing.wav'].sha256, 'a'.repeat(64));
  }
  finally { await cloud.close(); }
});
