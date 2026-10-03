// Hardening: malformed socket frames, races, token scope, token-less MCP limits, socket revocation, setup code.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { startServer, agent, openSocket, waitFor, readRpc } from './helpers.js';

let srv;
let admin;

before(async () => {
  srv = await startServer();
  admin = agent(srv.base);
  assert.equal((await admin.post('/api/auth/setup', { username: 'root', password: 'admin-pass-1' })).status, 201);
});
after(async () => srv.close());

const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

/** POST with a custom Host header (fetch can't override Host). Resolves to the status code. */
function postWithHost(base, urlPath, host, body, headers = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: urlPath, method: 'POST', headers: { ...headers, host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end(body);
  });
}
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

test('malformed WebSocket frames are ignored and never crash the server', async () => {
  const sock = openSocket(srv.base, admin.cookie);
  assert.equal(await sock.opened, true);
  for (const frame of ['null', '42', '"x"', '[]', '{"type":5}', '{"type":"ops","ops":null}', '{"type":"subscribe","projectId":{"a":1}}', 'not json']) sock.ws.send(frame);
  sock.ws.send(JSON.stringify({ type: 'ping', t: 7 }));
  await waitFor(() => sock.messages.find((m) => m.type === 'pong' && m.t === 7));
  assert.equal((await admin.get('/api/health')).status, 200);
  sock.ws.close();
});

test('concurrent first-run setup creates exactly one admin', async () => {
  const fresh = await startServer();
  try {
    const tries = await Promise.all(['alice', 'mallory', 'eve'].map((u) => agent(fresh.base).post('/api/auth/setup', { username: u, password: 'password-123' })));
    assert.deepEqual(tries.map((t) => t.status).sort(), [201, 409, 409]);
    assert.equal(fresh.users.count(), 1);
  } finally {
    await fresh.close();
  }
});

test('concurrent creation of the same username yields one account', async () => {
  const tries = await Promise.all([1, 2, 3].map(() => admin.post('/api/admin/users', { username: 'bob', password: 'password-123' })));
  assert.equal(tries.filter((t) => t.status === 201).length, 1);
  assert.equal(srv.users.list().filter((u) => u.username === 'bob').length, 1);
});

test('API tokens cannot use admin, password or token-management endpoints', async () => {
  const token = (await admin.post('/api/me/token')).body.token;
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = (method, url, body) => fetch(srv.base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call('GET', '/api/projects')).status, 200);
  assert.equal((await call('GET', '/api/admin/users')).status, 403);
  assert.equal((await call('PATCH', '/api/admin/settings', { allowRegistration: true })).status, 403);
  assert.equal((await call('POST', '/api/me/password', { currentPassword: 'x', newPassword: 'y'.repeat(10) })).status, 403);
  assert.equal((await call('POST', '/api/me/token')).status, 403);
});

test('revoking a token closes WebSockets opened with it', async () => {
  const token = (await admin.post('/api/me/token')).body.token;
  const ws = new WebSocket(`${srv.base.replace('http', 'ws')}/ws?token=${token}`);
  await new Promise((r) => ws.on('open', r));
  const closed = new Promise((r) => ws.on('close', (code) => r(code)));
  await admin.del('/api/me/token');
  assert.equal(await closed, 4401);
});

test('token-less MCP: only from this computer, never via proxies or rebinding host names', async () => {
  assert.equal((await fetch(`${srv.base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(rpc) })).status, 200);
  const rebind = await postWithHost(srv.base, '/mcp', 'attacker.example', JSON.stringify(rpc), mcpHeaders);
  assert.ok([401, 403].includes(rebind), `rebinding host got ${rebind}`);
  const proxied = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { ...mcpHeaders, 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify(rpc) });
  assert.equal(proxied.status, 401);
  const bad = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: mcpHeaders, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
});

test('MCP_TOKEN disables token-less access', async () => {
  const s = await startServer({ MCP_TOKEN: 'legacy-secret-token' });
  try {
    await agent(s.base).post('/api/auth/setup', { username: 'root', password: 'admin-pass-1' });
    assert.equal((await fetch(`${s.base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(rpc) })).status, 401);
    const ok = await fetch(`${s.base}/mcp`, { method: 'POST', headers: { ...mcpHeaders, authorization: 'Bearer legacy-secret-token' }, body: JSON.stringify(rpc) });
    assert.equal(ok.status, 200);
    assert.ok((await readRpc(ok)).result.tools.length > 50);
  } finally {
    await s.close();
  }
});

test('first-run setup from another computer (or through a proxy) needs the setup code', async () => {
  const s = await startServer({ SETUP_CODE: 'open-sesame' });
  try {
    const proxied = { 'x-forwarded-for': '203.0.113.7' };
    const a = agent(s.base);
    assert.equal((await a.get('/api/auth/status', proxied)).body.setupCodeRequired, true);
    assert.equal((await a.get('/api/auth/status')).body.setupCodeRequired, false, 'direct local request');
    assert.equal((await a.req('POST', '/api/auth/setup', { username: 'root', password: 'admin-pass-1' }, proxied)).status, 403);
    assert.equal((await a.req('POST', '/api/auth/setup', { username: 'root', password: 'admin-pass-1', setupCode: 'wrong' }, proxied)).status, 403);
    assert.equal((await a.req('POST', '/api/auth/setup', { username: 'root', password: 'admin-pass-1', setupCode: 'open-sesame' }, proxied)).status, 201);
    assert.equal((await a.get('/api/auth/status', proxied)).body.setupCodeRequired, false);
  } finally {
    await s.close();
  }
});

test('behind a configured proxy nothing counts as local (setup code, token-less MCP)', async () => {
  const s = await startServer({ TRUST_PROXY: '1' });
  try {
    assert.equal((await agent(s.base).get('/api/auth/status')).body.setupCodeRequired, true);
    assert.ok(s.setupCode && s.setupCode.length >= 8, 'a code is generated on first run');
    await agent(s.base).post('/api/auth/setup', { username: 'root', password: 'admin-pass-1', setupCode: s.setupCode });
    const r = await fetch(`${s.base}/mcp`, { method: 'POST', headers: mcpHeaders, body: JSON.stringify(rpc) });
    assert.equal(r.status, 401);
  } finally {
    await s.close();
  }
});

test('a deleted project stays deleted even with edits in flight', async () => {
  const p = (await admin.post('/api/projects', { name: 'Doomed' })).body;
  const edits = Array.from({ length: 5 }, (_, i) => admin.post(`/api/projects/${p.id}/ops`, { ops: [{ type: 'project/update', patch: { bpm: 100 + i } }] }));
  const del = admin.del(`/api/projects/${p.id}`);
  await Promise.all([...edits, del]);
  await srv.store.flush();
  await new Promise((r) => setTimeout(r, 600)); // past the save debounce
  assert.equal((await admin.get(`/api/projects/${p.id}`)).status, 404);
  await assert.rejects(fs.access(path.join(srv.dataDir, 'projects', `${p.id}.json`)));
  assert.ok(!(await admin.get('/api/projects')).body.some((x) => x.id === p.id));
});

test('deleting a user removes their projects, samples and exports', async () => {
  const u = (await admin.post('/api/admin/users', { username: 'carol', password: 'password-123' })).body;
  const carol = agent(srv.base);
  await carol.post('/api/auth/login', { username: 'carol', password: 'password-123' });
  const pid = (await carol.get('/api/projects')).body[0].id;
  assert.equal((await carol.post(`/api/projects/${pid}/export-midi`, {})).status, 200);
  assert.equal((await carol.post('/api/samples/folders', { name: 'Carol Drums' })).status, 201);
  const exportDir = path.join(srv.dataDir, 'exports', u.id);
  await fs.access(exportDir);
  assert.equal((await admin.del(`/api/admin/users/${u.id}`)).status, 200);
  await assert.rejects(fs.access(exportDir));
  assert.equal((await srv.store.list(u.id)).length, 0);
  assert.deepEqual(srv.samples.listFolders(u.id), []);
  assert.ok(!JSON.parse(await fs.readFile(path.join(srv.dataDir, 'samples', 'folders.json'), 'utf8')).some((f) => f.ownerId === u.id));
  assert.equal((await carol.get('/api/me')).status, 401);
});

test('MIDI export over HTTP does not reveal server paths', async () => {
  const pid = (await admin.get('/api/projects')).body[0].id;
  const r = await admin.post(`/api/projects/${pid}/export-midi`, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.path, undefined);
  assert.match(r.body.url, /\/api\/exports\//);
});

test('oversized login bodies are rejected cheaply', async () => {
  const r = await fetch(`${srv.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'x'.repeat(200000), password: 'y' }) });
  assert.equal(r.status, 413);
  const long = await agent(srv.base).post('/api/auth/login', { username: 'x'.repeat(5000), password: 'y' });
  assert.equal(long.status, 400);
});

test('security headers are set', async () => {
  const r = await fetch(`${srv.base}/api/health`);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  // the recorder may use the microphone on the studio page itself only; no camera, location, payment…
  assert.match(r.headers.get('permissions-policy'), /microphone=\(self\), camera=\(\)/);
});

test('a protocol-level WebSocket error closes only that socket', async () => {
  const net = await import('node:net');
  const { port } = new URL(srv.base);
  const sock = net.connect(Number(port), '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  const key = Buffer.from('0123456789abcdef').toString('base64');
  sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: ${admin.cookie}\r\n\r\n`);
  await new Promise((r) => sock.once('data', r)); // 101 Switching Protocols
  sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); // unmasked client frame = protocol error
  await new Promise((r) => sock.once('close', r));
  assert.equal((await admin.get('/api/health')).status, 200);
});

test('a burst of parallel wrong logins is still rate-limited', async () => {
  await admin.post('/api/admin/users', { username: 'target', password: 'target-pass-1' });
  const tries = await Promise.all(Array.from({ length: 40 }, () => agent(srv.base).post('/api/auth/login', { username: 'target', password: 'nope-nope-nope' })));
  const limited = tries.filter((t) => t.status === 429).length;
  assert.ok(limited >= 25, `only ${limited} of 40 were limited`);
});

test('disabling a user closes their sockets; non-string ids are rejected', async () => {
  const u = (await admin.post('/api/admin/users', { username: 'dora', password: 'dora-pass-12' })).body;
  const dora = agent(srv.base);
  await dora.post('/api/auth/login', { username: 'dora', password: 'dora-pass-12' });
  const sock = openSocket(srv.base, dora.cookie);
  assert.equal(await sock.opened, true);
  const closed = new Promise((r) => sock.ws.on('close', (code) => r(code)));
  assert.equal((await admin.patch(`/api/admin/users/${u.id}`, { disabled: 'false' })).status, 400, 'string booleans are rejected');
  await admin.patch(`/api/admin/users/${u.id}`, { disabled: true });
  assert.equal(await closed, 4401);
  const pid = (await admin.get('/api/projects')).body[0].id;
  assert.equal((await admin.put('/api/active', { projectId: [pid] })).status, 400);
});

test('anonymous requests cannot make the server parse large bodies', async () => {
  const big = JSON.stringify({ ops: [{ type: 'project/update', patch: { name: 'x'.repeat(2 * 1024 * 1024) } }] });
  const anon = await fetch(`${srv.base}/api/projects/prj_x/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
  assert.equal(anon.status, 401);
  const other = await fetch(`${srv.base}/api/samples/smp_x`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: admin.cookie }, body: big });
  assert.equal(other.status, 413);
});

test('reset-password refuses to run while a server uses the data directory', async () => {
  const { execFile } = await import('node:child_process');
  const { writeLock } = await import('../src/lockfile.js');
  const { port, hostname } = new URL(srv.base);
  const remove = writeLock(srv.dataDir, Number(port), hostname); // pretend this test process is the server
  const err = await new Promise((resolve) => execFile(process.execPath, ['src/cli/reset-password.js', 'root'], {
    env: { ...process.env, DATA_DIR: srv.dataDir, NEW_PASSWORD: 'whatever-123' }
  }, (e, stdout, stderr) => resolve({ code: e?.code, stderr })));
  remove();
  assert.equal(err.code, 1);
  assert.match(err.stderr, /server is running/);
});

test('a stale lock (live pid, nothing listening on its port) does not block maintenance', async () => {
  const net = await import('node:net');
  const { runningServer, writeLock } = await import('../src/lockfile.js');
  const free = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  const remove = writeLock(srv.dataDir, free, '127.0.0.1');
  try {
    // runningServer ignores its own pid, so check from a child process (where this pid is "another" process)
    const { execFile } = await import('node:child_process');
    const code = `import('./src/lockfile.js').then(async (m) => console.log(JSON.stringify(await m.runningServer(${JSON.stringify(srv.dataDir)}))))`;
    const out = await new Promise((resolve, reject) => execFile(process.execPath, ['-e', code], (e, stdout) => (e ? reject(e) : resolve(stdout.trim()))));
    assert.equal(out, 'null');
    assert.equal(await runningServer(srv.dataDir), null);
  } finally {
    remove();
  }
});

test('Host allow-list: only the health check answers to other names (container health checks)', async () => {
  const srv2 = await startServer({ ALLOWED_HOSTS: 'beats.example.com', HOST: '0.0.0.0' });
  const get = (urlPath, host) => new Promise((resolve, reject) => {
    const u = new URL(srv2.base);
    http.get({ hostname: u.hostname, port: u.port, path: urlPath, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  try {
    assert.equal(await get('/api/health', '127.0.0.1:3001'), 200);
    assert.equal(await get('/api/auth/status', '127.0.0.1:3001'), 403);
    assert.equal(await get('/api/auth/status', 'evil.example.net'), 403);
    assert.equal(await get('/api/health/../auth/status', 'evil.example.net'), 403);
    assert.equal(await get('/api/auth/status', 'beats.example.com'), 200);
  } finally {
    await srv2.close();
  }
});
