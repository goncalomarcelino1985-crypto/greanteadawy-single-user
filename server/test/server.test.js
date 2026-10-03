import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startServer, agent, openSocket, waitFor, makeWav } from './helpers.js';
import { ProjectStore } from '../src/store.js';

let srv;
let user;

before(async () => {
  srv = await startServer();
  user = agent(srv.base);
  await user.post('/api/auth/setup', { username: 'tester', password: 'tester-pass' });
});
after(async () => srv.close());

test('REST: projects, ops validation, templates, export', async () => {
  const list = (await user.get('/api/projects')).body;
  const id = list[0].id;
  const r = await user.post(`/api/projects/${id}/ops`, { ops: [{ type: 'project/update', patch: { bpm: 150 } }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.project.bpm, 150);
  assert.equal((await user.post(`/api/projects/${id}/ops`, { ops: [{ type: 'channel/remove', id: 'nope' }] })).status, 400);
  assert.equal((await user.post(`/api/projects/${id}/ops`, { ops: [] })).status, 400);
  assert.equal((await user.post('/api/projects', { template: 'nope' })).status, 400);
  const created = await user.post('/api/projects', { name: 'House', template: 'house' });
  assert.equal(created.status, 201);
  assert.ok(created.body.playlist.clips.length > 0);
  const exp = await user.get(`/api/projects/${created.body.id}/export`);
  assert.equal(exp.body.ownerId, undefined);
  assert.equal((await user.post('/api/projects', { project: exp.body, name: 'Imported' })).status, 201);
  const dup = await user.post(`/api/projects/${created.body.id}/duplicate`, { name: 'Copy' });
  assert.equal(dup.body.name, 'Copy');
  assert.equal((await user.del(`/api/projects/${dup.body.id}`)).status, 200);
  // versions via REST
  const v = await user.post(`/api/projects/${id}/versions`, { name: 'v1' });
  assert.equal(v.status, 201);
  assert.equal((await user.get(`/api/projects/${id}/versions`)).body[0].name, 'v1');
  assert.equal((await user.post(`/api/projects/${id}/versions/${v.body.id}/restore`)).status, 200);
  assert.equal((await user.get('/api/projects/../../etc/passwd')).status, 404);
  assert.equal((await user.post('/api/projects/bad%20id/ops', { ops: [{ type: 'project/update', patch: {} }] })).status, 400);
});

test('version: one version across the workspaces; the About dialog reads it from /api/status', async () => {
  const read = async (f) => JSON.parse(await fs.readFile(new URL(`../../${f}`, import.meta.url), 'utf8')).version;
  const versions = await Promise.all(['package.json', 'server/package.json', 'client/package.json', 'packages/core/package.json'].map(read));
  assert.equal(new Set(versions).size, 1, `package versions differ: ${versions}`);
  const status = (await user.get('/api/status')).body;
  assert.equal(status.version, versions[0]);
});

test('security: host header, cross-origin requests and websockets, safe sample content-type', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${srv.base}/api/auth/status`, { headers: { host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403); // (only /api/health answers to any Host name)
  const csrf = await user.post('/api/projects', { name: 'x' }, { origin: 'http://evil.example' });
  assert.equal(csrf.status, 403);
  const ws = new (await import('ws')).default(`${srv.base.replace('http', 'ws')}/ws`, { headers: { origin: 'http://evil.example', cookie: user.cookie } });
  const res = await new Promise((resolve) => { ws.on('open', () => resolve('open')); ws.on('unexpected-response', (q, r) => resolve(r.statusCode)); ws.on('error', () => resolve('error')); });
  assert.notEqual(res, 'open');
  const fd = new FormData();
  fd.append('file', new Blob([makeWav(0.1)], { type: 'text/html' }), 'evil.wav');
  const up = await user.post('/api/samples', fd);
  assert.equal(up.status, 201);
  const file = await fetch(`${srv.base}/api/samples/${up.body.id}/file`, { headers: { cookie: user.cookie } });
  assert.equal(file.headers.get('content-type'), 'audio/wav');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await user.del(`/api/samples/${up.body.id}`)).status, 200);
  const bad = new FormData();
  bad.append('file', new Blob(['<html>'], { type: 'text/html' }), 'x.html');
  assert.equal((await user.post('/api/samples', bad)).status, 400);
});

test('websocket live sync: ack, reject + resync, dedupe of re-sent ops', async () => {
  const pid = (await user.get('/api/projects')).body[0].id;
  const sock = openSocket(srv.base, user.cookie);
  assert.equal(await sock.opened, true);
  sock.ws.send(JSON.stringify({ type: 'hello', clientId: 'c1' }));
  sock.ws.send(JSON.stringify({ type: 'subscribe', projectId: pid }));
  await waitFor(() => sock.messages.find((m) => m.type === 'project'));
  const op = { type: 'ops', projectId: pid, opId: 'op-1', ops: [{ type: 'clip/add', clips: [{ id: 'clip_dup', kind: 'pattern', refId: (await user.get(`/api/projects/${pid}`)).body.patterns[0].id, track: 9, start: 0, length: 96 }] }] };
  sock.ws.send(JSON.stringify(op));
  await waitFor(() => sock.messages.find((m) => m.type === 'ack' && m.opId === 'op-1'));
  sock.ws.send(JSON.stringify(op));
  await waitFor(() => sock.messages.find((m) => m.type === 'ack' && m.opId === 'op-1' && m.duplicate));
  const p = (await user.get(`/api/projects/${pid}`)).body;
  assert.equal(p.playlist.clips.filter((c) => c.id === 'clip_dup').length, 1);
  sock.ws.send(JSON.stringify({ type: 'ops', projectId: pid, opId: 'op-2', ops: [{ type: 'pattern/update', id: 'missing', patch: {} }] }));
  await waitFor(() => sock.messages.find((m) => m.type === 'reject' && m.opId === 'op-2' && m.project));
  sock.ws.close();
});

test('parallel edits are serialized (standalone stdio store: no cache, immediate writes)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-par-'));
  const store = await new ProjectStore(dir, { saveDelay: 0, cache: false }).init();
  const p = await store.create({ ownerId: 'usr_x', name: 'Par', template: 'empty' });
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.applyOps(p.id, [{ type: 'channel/add', channel: { id: `ch_p${i}`, name: `C${i}`, kind: 'kick', mixerTrack: 'auto' } }], { userId: 'usr_x' })));
  const saved = await new ProjectStore(dir, { saveDelay: 0, cache: false }).get(p.id);
  assert.equal(saved.channels.length, 12);
  assert.equal(new Set(saved.channels.map((c) => c.mixerTrack)).size, 12);
  await assert.rejects(store.applyOps(p.id, [{ type: 'project/update', patch: { bpm: 90 } }], { userId: 'usr_other' }), /not found/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('orphaned data (from before accounts existed) is adopted by the first admin', async () => {
  const s2 = await startServer();
  const store = new ProjectStore(s2.dataDir);
  await store.init();
  // simulate a legacy project file without ownerId
  const legacy = { ...(await s2.store.create({ ownerId: 'tmp', name: 'Legacy' })) };
  delete legacy.ownerId;
  await fs.writeFile(path.join(s2.dataDir, 'projects', `${legacy.id}.json`), JSON.stringify(legacy));
  s2.store.cache.clear();
  const a = agent(s2.base);
  await a.post('/api/auth/setup', { username: 'admin', password: 'admin-pass' });
  const names = (await a.get('/api/projects')).body.map((p) => p.name);
  assert.ok(names.includes('Legacy'));
  await s2.close();
});
