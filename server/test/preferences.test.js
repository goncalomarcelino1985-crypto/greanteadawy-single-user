import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createPreferencesRouter, validatePreferences } from '../src/preferences.js';
import { apiErrorHandlers } from '../src/api.js';

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-preferences-'));
  const servers = [];
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  let transactions = 0;
  const start = async () => {
    const app = express();
    const auth = { requireSession(req, res, next) {
      if (!req.headers.cookie || req.headers.authorization) return res.status(401).json({ error: 'Session required' });
      req.user = { id: req.headers.cookie }; next();
    } };
    app.use('/api', apiErrorHandlers(createPreferencesRouter({ dataDir, auth, transaction: async (fn) => { transactions++; return fn(); } })));
    const server = http.createServer(app);
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (owner = 'u_one', method = 'GET', body, extra = {}) => {
      const response = await fetch(`${base}/api/preferences`, { method, headers: { ...(owner && { cookie: owner }), 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
  };
  return { start, dataDir, transactions: () => transactions };
}

test('owner preferences survive a fresh server and remain separated from other owners', async (t) => {
  const f = await fixture(t);
  const request = await f.start();
  assert.deepEqual((await request()).body, { revision: 0, preferences: {} });
  const preferences = { snap: 'bar', kbOctave: 3, metronome: true, windows: { mixer: { x: 20, y: 30, w: 600, h: 400, z: 8, open: true, max: false } }, recorderPreferences: { channels: 2, countIn: 2, offsetMs: -80 }, collapsedSampleFolders: ['fld_test', ''] };
  const saved = await request('u_one', 'PUT', { revision: 0, preferences });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.equal(f.transactions(), 1);
  assert.deepEqual((await request('u_two')).body, { revision: 0, preferences: {} });
  const restarted = await f.start();
  assert.deepEqual((await restarted()).body.preferences, preferences);
  const stored = JSON.parse(await fs.readFile(path.join(f.dataDir, 'preferences/u_one.json'), 'utf8'));
  assert.deepEqual(stored, saved.body);
});

test('session requirement, revision conflicts and concurrent tab saves fail closed', async (t) => {
  const f = await fixture(t);
  const request = await f.start();
  assert.equal((await request(null)).status, 401);
  assert.equal((await request('u_one', 'PUT', { revision: 0, preferences: {} }, { authorization: 'Bearer token' })).status, 401);
  const results = await Promise.all([
    request('u_one', 'PUT', { revision: 0, preferences: { snap: 'bar' } }),
    request('u_one', 'PUT', { revision: 0, preferences: { snap: 'beat' } })
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await request()).body.revision, 1);
  assert.equal((await request('../escape')).status, 400);
  assert.equal((await request('u_one', 'PUT', { preferences: {} })).status, 400);
});

test('only bounded UI settings can be persisted', async (t) => {
  const f = await fixture(t);
  const request = await f.start();
  for (const preferences of [{ privateAccessKey: 'no' }, { windows: { unknown: {} } }, { windows: { mixer: { script: 'no' } } }, { kbOctave: 9 }, { snap: 'bad' }, { recorderPreferences: { channels: 3 } }, { recorderPreferences: { monitor: 'true' } }, { collapsedSampleFolders: ['../../no'] }, JSON.parse('{"__proto__":{"admin":true}}')]) {
    assert.equal((await request('u_one', 'PUT', { revision: 0, preferences })).status, 400);
  }
  assert.equal((await request('u_one', 'PUT', { revision: 0, preferences: { recorderPreferences: { deviceId: 'x'.repeat(70000) } } })).status, 413);
  assert.deepEqual((await request()).body, { revision: 0, preferences: {} });
  assert.throws(() => validatePreferences({ windows: { mixer: { x: Infinity } } }), /Invalid preference/);
  assert.deepEqual(validatePreferences({ collapsedSampleFolders: ['fld_one', 'fld_one'] }), { collapsedSampleFolders: ['fld_one'] });
});
