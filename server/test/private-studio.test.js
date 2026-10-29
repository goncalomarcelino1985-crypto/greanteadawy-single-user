import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer, openSocket, mcpClient } from './helpers.js';
import { createPrivateStudio } from '../src/auth/private-studio.js';
import { loadConfig } from '../src/config.js';

const key = crypto.randomBytes(32).toString('base64url');
const env = { SINGLE_USER: 'true', PRIVATE_ACCESS_KEY: key, EPHEMERAL_STORAGE: 'true' };
const access = async (srv, value = key, headers = {}) => fetch(`${srv.base}/private/access`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ key: value }) });
const cookieFor = async (srv) => (await access(srv)).headers.get('set-cookie').split(';')[0];

test('single-user fails closed without a strong key or HTTPS for public deployment', async () => {
  await assert.rejects(createPrivateStudio(loadConfig({ SINGLE_USER: 'true' }), {}), /PRIVATE_ACCESS_KEY/);
  await assert.rejects(createPrivateStudio(loadConfig({ ...env, HOST: '0.0.0.0' }), {}), /HTTPS/);
  await assert.rejects(createPrivateStudio(loadConfig({ ...env, PUBLIC_URL: 'https://studio.example', HOST: '0.0.0.0' }), {}), /ALLOWED_HOSTS/);
});

test('private owner is bootstrapped; anonymous REST, assets and WebSocket are denied', async (t) => {
  const srv = await startServer(env); t.after(() => srv.close());
  assert.equal(srv.users.count(), 1);
  assert.equal(srv.users.firstAdmin().displayName, 'Gonçalo');
  assert.equal(srv.setupCode, null);
  for (const path of ['/', '/api/auth/status', '/api/projects', '/api/samples', '/api/me', '/assets/app.js', '/mcp', '/api/auth/setup']) {
    assert.equal((await fetch(srv.base + path)).status, 401, path);
  }
  assert.equal((await fetch(srv.base + '/api/health')).status, 200);
  const ws = openSocket(srv.base); assert.equal(await ws.opened, 401); ws.ws.terminate();
  assert.equal((await access(srv, 'wrong')).status, 401);
  assert.equal((await access(srv, key, { Origin: 'https://evil.example' })).status, 403);
  const page = await (await fetch(srv.base + '/access')).text();
  assert.ok(!page.includes(key)); assert.ok(!page.includes('password'));
});

test('private cookie opens the studio, blocks account changes, supports a separate revocable MCP token', async (t) => {
  const srv = await startServer(env); t.after(() => srv.close());
  const result = await access(srv);
  const raw = result.headers.get('set-cookie');
  assert.match(raw, /HttpOnly/); assert.match(raw, /SameSite=Strict/); assert.ok(!raw.includes(key));
  const cookie = raw.split(';')[0];
  const request = (path, method = 'GET', body) => fetch(srv.base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const status = await (await request('/api/auth/status')).json();
  assert.equal(status.singleUser, true); assert.equal(status.ephemeralStorage, true); assert.equal(status.setupRequired, false); assert.equal(status.mcpWithoutToken, false);
  assert.equal((await request('/')).status, 200);
  const projects = await (await request('/api/projects')).json(); assert.equal(projects.length, 1); assert.equal(projects[0].name, 'Estúdio do Gonçalo');
  for (const path of ['/api/auth/setup', '/api/auth/login', '/api/auth/register', '/api/me/password', '/api/admin/users', '/api/admin/settings', '/API/AUTH/register', '/api/auth/%72egister']) {
    assert.equal((await request(path, 'POST', {})).status, 403, path);
  }
  assert.equal(srv.users.count(), 1);
  const ws = openSocket(srv.base, cookie); assert.equal(await ws.opened, true); ws.ws.close();
  const minted = await request('/api/me/token', 'POST'); assert.equal(minted.status, 201);
  const { token } = await minted.json(); assert.notEqual(token, key);
  const client = await mcpClient(srv.base, token); t.after(() => client.close());
  const listed = await client.listTools(); assert.ok(listed.tools.length > 50);
  assert.equal((await fetch(srv.base + '/api/projects?token=' + token)).status, 401);
  await request('/api/me/token', 'DELETE');
  assert.equal((await fetch(srv.base + '/api/projects', { headers: { authorization: `Bearer ${token}` } })).status, 401);
  const tampered = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
  assert.equal((await fetch(srv.base + '/api/projects', { headers: { cookie: tampered } })).status, 401);
});

test('cookie survives fresh ephemeral instance, expires, and key rotation revokes access', async (t) => {
  const first = await startServer(env); t.after(() => first.close());
  const cookie = await cookieFor(first);
  const second = await startServer(env); t.after(() => second.close());
  assert.equal((await fetch(second.base + '/api/auth/status', { headers: { cookie } })).status, 200);
  const rotated = await startServer({ ...env, PRIVATE_ACCESS_KEY: crypto.randomBytes(32).toString('base64url') }); t.after(() => rotated.close());
  assert.equal((await fetch(rotated.base + '/api/auth/status', { headers: { cookie } })).status, 401);
  const payload = `1.${crypto.randomBytes(16).toString('base64url')}`;
  const sig = crypto.createHmac('sha256', key).update(`private-studio-v1:${payload}`).digest('base64url');
  assert.equal((await fetch(first.base + '/api/projects', { headers: { cookie: `gtd_private=${payload}.${sig}` } })).status, 401);
  assert.equal(first.hub.stillValid({ userId: first.users.firstAdmin().id, expiresAt: 1 }), false);
});

test('HTTPS deployment uses a secure host-only cookie and access attempts are rate limited', async (t) => {
  const srv = await startServer({ ...env, PUBLIC_URL: 'https://studio.example', ALLOWED_HOSTS: 'studio.example,127.0.0.1', TRUST_PROXY: '1' }); t.after(() => srv.close());
  assert.match((await access(srv)).headers.get('set-cookie'), /^__Host-gtd_private=.*; Secure$/);
  for (let i = 0; i < 20; i++) assert.equal((await access(srv, 'wrong')).status, 401);
  const limited = await access(srv, 'wrong'); assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
});
