import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, agent, mcpClient, openSocket, waitFor, readRpc } from './helpers.js';

let srv;
let admin;

before(async () => {
  srv = await startServer();
  admin = agent(srv.base);
});
after(async () => srv.close());

test('first run requires setup; setup creates an admin with a welcome project', async () => {
  const anon = agent(srv.base);
  const s0 = await anon.get('/api/auth/status');
  assert.equal(s0.body.setupRequired, true);
  assert.equal((await anon.get('/api/projects')).status, 401);
  assert.equal((await anon.post('/api/auth/setup', { username: 'Al', password: 'short' })).status, 400);
  const r = await admin.post('/api/auth/setup', { username: 'alice', password: 'correct horse', displayName: 'Alice' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, 'admin');
  assert.ok(admin.cookie);
  assert.equal((await anon.post('/api/auth/setup', { username: 'mallory', password: 'password123' })).status, 409);
  const list = await admin.get('/api/projects');
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].name, 'Welcome Trap Beat');
  const st = await admin.get('/api/auth/status');
  assert.equal(st.body.user.username, 'alice');
});

test('login, wrong password, logout and rate limiting', async () => {
  const a = agent(srv.base);
  assert.equal((await a.post('/api/auth/login', { username: 'alice', password: 'nope-nope' })).status, 401);
  const ok = await a.post('/api/auth/login', { username: 'ALICE', password: 'correct horse' });
  assert.equal(ok.status, 200);
  assert.equal((await a.get('/api/me')).body.user.username, 'alice');
  await a.post('/api/auth/logout');
  assert.equal((await a.get('/api/me')).status, 401);
  const b = agent(srv.base);
  let last;
  for (let i = 0; i < 11; i++) last = await b.post('/api/auth/login', { username: 'ratelimited', password: 'wrong-password' });
  assert.equal(last.status, 429);
});

test('registration is closed by default; admin can open it and manage users', async () => {
  const anon = agent(srv.base);
  assert.equal((await anon.post('/api/auth/register', { username: 'eve', password: 'password123' })).status, 403);
  const created = await admin.post('/api/admin/users', { username: 'bob', password: 'bob-password', displayName: 'Bob' });
  assert.equal(created.status, 201);
  assert.equal(created.body.projects, 1);
  assert.equal((await admin.patch('/api/admin/settings', { allowRegistration: true })).body.allowRegistration, true);
  const reg = await anon.post('/api/auth/register', { username: 'carol', password: 'carol-password' });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.role, 'user');
  // non-admins can't use admin routes
  assert.equal((await anon.get('/api/admin/users')).status, 403);
  // last admin protections
  const me = (await admin.get('/api/me')).body.user;
  assert.equal((await admin.patch(`/api/admin/users/${me.id}`, { role: 'user' })).status, 400);
  assert.equal((await admin.del(`/api/admin/users/${me.id}`)).status, 400);
  // disable carol -> her session stops working
  const carolId = reg.body.user.id;
  assert.equal((await admin.patch(`/api/admin/users/${carolId}`, { disabled: true })).status, 200);
  assert.equal((await anon.get('/api/me')).status, 401);
  assert.equal((await admin.del(`/api/admin/users/${carolId}`)).status, 200);
  await admin.patch('/api/admin/settings', { allowRegistration: false });
});

test('users only see their own projects and samples', async () => {
  const bob = agent(srv.base);
  await bob.post('/api/auth/login', { username: 'bob', password: 'bob-password' });
  const aliceProject = (await admin.get('/api/projects')).body[0];
  assert.equal((await bob.get(`/api/projects/${aliceProject.id}`)).status, 404);
  assert.equal((await bob.post(`/api/projects/${aliceProject.id}/ops`, { ops: [{ type: 'project/update', patch: { bpm: 99 } }] })).status, 404);
  assert.equal((await bob.del(`/api/projects/${aliceProject.id}`)).status, 404);
  const bobs = (await bob.get('/api/projects')).body;
  assert.equal(bobs.length, 1);
  assert.notEqual(bobs[0].id, aliceProject.id);
  // project/replace can't move a project to another owner
  const me = (await bob.get('/api/me')).body.user;
  const full = (await bob.get(`/api/projects/${bobs[0].id}`)).body;
  await bob.post(`/api/projects/${bobs[0].id}/ops`, { ops: [{ type: 'project/replace', project: { ...full, ownerId: 'usr_someoneelse' } }] });
  assert.equal((await bob.get(`/api/projects/${bobs[0].id}`)).body.ownerId, me.id);
  // websocket: bob can't subscribe to alice's project
  const sock = openSocket(srv.base, bob.cookie);
  assert.equal(await sock.opened, true);
  sock.ws.send(JSON.stringify({ type: 'subscribe', projectId: aliceProject.id }));
  await waitFor(() => sock.messages.find((m) => m.type === 'error'));
  sock.ws.close();
  // unauthenticated websocket is refused
  assert.equal(await openSocket(srv.base, '').opened, 401);
});

test('API tokens: generate, use for MCP, regenerate, revoke; token-less MCP setting', async () => {
  assert.equal((await admin.get('/api/me/token')).body.token, null);
  const g = await admin.post('/api/me/token');
  assert.equal(g.status, 201);
  assert.match(g.body.token, /^gtd_/);
  assert.equal((await admin.get('/api/me/token')).body.token.prefix, g.body.info.prefix);
  // token works for REST and MCP
  const viaToken = await fetch(`${srv.base}/api/projects`, { headers: { authorization: `Bearer ${g.body.token}` } });
  assert.equal(viaToken.status, 200);
  const client = await mcpClient(srv.base, g.body.token);
  const status = await client.callTool({ name: 'get_studio_status', arguments: {} });
  assert.match(status.content[1].text, /alice/);
  await client.close();
  // tokens can't manage tokens
  const self = await fetch(`${srv.base}/api/me/token`, { method: 'POST', headers: { authorization: `Bearer ${g.body.token}` } });
  assert.equal(self.status, 403);
  // regenerate invalidates the old token
  const g2 = await admin.post('/api/me/token');
  assert.notEqual(g2.body.token, g.body.token);
  assert.equal((await fetch(`${srv.base}/api/projects`, { headers: { authorization: `Bearer ${g.body.token}` } })).status, 401);
  // ?token= works for MCP clients that can't set headers
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const q = await fetch(`${srv.base}/mcp?token=${g2.body.token}`, { method: 'POST', headers: h, body: JSON.stringify(rpc) });
  assert.equal(q.status, 200);
  assert.ok((await readRpc(q)).result.tools.length >= 55);
  // token-less MCP allowed on loopback by default; can be turned off
  assert.equal((await fetch(`${srv.base}/mcp`, { method: 'POST', headers: h, body: JSON.stringify(rpc) })).status, 200);
  await admin.patch('/api/admin/settings', { mcpWithoutToken: false });
  const denied = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: h, body: JSON.stringify(rpc) });
  assert.equal(denied.status, 401);
  assert.match((await denied.json()).error.message, /requires an API token/);
  const bad = await fetch(`${srv.base}/mcp`, { method: 'POST', headers: { ...h, authorization: 'Bearer gtd_nope_nope' }, body: JSON.stringify(rpc) });
  assert.equal(bad.status, 401);
  await admin.patch('/api/admin/settings', { mcpWithoutToken: true });
  // revoke
  assert.equal((await admin.del('/api/me/token')).status, 200);
  assert.equal((await fetch(`${srv.base}/api/projects`, { headers: { authorization: `Bearer ${g2.body.token}` } })).status, 401);
});

test('changing the password signs out other sessions', async () => {
  const other = agent(srv.base);
  await other.post('/api/auth/login', { username: 'alice', password: 'correct horse' });
  assert.equal((await other.get('/api/me')).status, 200);
  assert.equal((await admin.post('/api/me/password', { currentPassword: 'wrong', newPassword: 'new-password-1' })).status, 400);
  assert.equal((await admin.post('/api/me/password', { currentPassword: 'correct horse', newPassword: 'new-password-1' })).status, 200);
  assert.equal((await admin.get('/api/me')).status, 200);
  assert.equal((await other.get('/api/me')).status, 401);
  await admin.post('/api/me/password', { currentPassword: 'new-password-1', newPassword: 'correct horse' });
});

test('passwords and tokens are never stored in plain text', async () => {
  const fs = await import('node:fs/promises');
  const raw = await fs.readFile(`${srv.dataDir}/users.json`, 'utf8');
  assert.ok(!raw.includes('correct horse'));
  assert.match(raw, /scrypt\$/);
});

test('reset-password CLI sets a new password and ends sessions', async () => {
  const { execFile } = await import('node:child_process');
  const { UserStore } = await import('../src/auth/users.js');
  const a = agent(srv.base);
  await admin.post('/api/admin/users', { username: 'forgetful', password: 'old-password-1' });
  await a.post('/api/auth/login', { username: 'forgetful', password: 'old-password-1' });
  await srv.sessions.flush();
  await new Promise((resolve, reject) => execFile(process.execPath, ['src/cli/reset-password.js', 'forgetful'], {
    env: { ...process.env, DATA_DIR: srv.dataDir, NEW_PASSWORD: 'brand-new-pass-2' }
  }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
  const fresh = await new UserStore(srv.dataDir).init();
  assert.ok(await fresh.authenticate('forgetful', 'brand-new-pass-2'));
  assert.equal(await fresh.authenticate('forgetful', 'old-password-1'), null);
});
