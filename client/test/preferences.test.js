import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreferencesSync, pickPreferences } from '../src/state/preferences.js';

const deferred = () => { let resolve; let reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('cloud GET is authoritative; defaults and secrets are never published before loading', async () => {
  const load = deferred();
  const calls = [];
  let applied;
  const sync = createPreferencesSync({ request: (method, body) => { calls.push({ method, body }); return load.promise; }, apply: (prefs) => { applied = prefs; }, status: () => {} });
  assert.equal(sync.changed({ snap: 'step' }), false);
  const started = sync.start('owner');
  assert.equal(sync.changed({ snap: 'step' }), false);
  load.resolve({ revision: 4, preferences: { snap: 'bar' } });
  assert.equal(await started, true);
  assert.deepEqual(applied, { snap: 'bar' });
  assert.deepEqual(calls.map((c) => c.method), ['GET']);
  assert.deepEqual(pickPreferences({ snap: 'beat', auth: { password: 'private' }, project: { name: 'secret' } }), { snap: 'beat' });
  sync.stop();
});

test('failed load forbids all writes until retry succeeds', async () => {
  const calls = [];
  const states = [];
  let fail = true;
  const sync = createPreferencesSync({ request: async (method) => { calls.push(method); if (fail) throw new Error('Offline'); return { revision: 1, preferences: {} }; }, apply: () => {}, status: (state) => states.push(state) });
  assert.equal(await sync.start('owner'), false);
  assert.equal(sync.changed({ snap: 'beat' }), false);
  await sync.flush();
  assert.deepEqual(calls, ['GET']);
  assert.equal(states.at(-1).phase, 'error');
  assert.equal(states.at(-1).unsaved, true);
  fail = false;
  assert.equal(await sync.retry(), true);
  sync.stop();
});

test('editing after a failed GET stays visibly unsaved; retry reads cloud and never uploads defaults', async () => {
  const calls = [];
  const states = [];
  const applied = [];
  let attempts = 0;
  const sync = createPreferencesSync({ request: async (method, body) => {
    calls.push({ method, body });
    if (++attempts < 3) throw new Error('Offline');
    return { revision: 9, preferences: { snap: 'bar', metronome: true } };
  }, apply: (prefs) => applied.push(prefs), status: (state) => states.push(state) });
  await sync.start('owner');
  assert.equal(sync.changed({ snap: 'step', metronome: false }), false);
  assert.equal(states.at(-1).unsaved, true);
  assert.equal(states.at(-1).phase, 'error');
  await sync.flush();
  await sync.retry();
  assert.equal(states.at(-1).unsaved, true, 'failed retry retains the unsaved warning');
  await sync.retry();
  assert.deepEqual(applied, [{ snap: 'bar', metronome: true }]);
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'GET']);
  assert.equal(states.at(-1).unsaved, false);
  assert.equal(states.at(-1).phase, 'saved');
  sync.stop();
});

test('saves are serial and the latest edit is retained while a prior save is pending', async () => {
  const put = deferred();
  const calls = [];
  const states = [];
  const sync = createPreferencesSync({ request: async (method, body) => { calls.push({ method, body }); if (method === 'GET') return { revision: 2, preferences: {} }; if (calls.length === 2) return put.promise; return { revision: 4, preferences: body.preferences }; }, apply: () => {}, status: (state) => states.push(state), debounceMs: 60000 });
  await sync.start('owner');
  sync.changed({ snap: 'bar' });
  const saved = sync.flush();
  sync.changed({ snap: 'beat', recorderPreferences: { countIn: 2 } });
  await sync.flush();
  assert.equal(calls.length, 2);
  put.resolve({ revision: 3, preferences: { snap: 'bar' } });
  await saved;
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body, { revision: 3, preferences: { snap: 'beat', recorderPreferences: { countIn: 2 } } });
  assert.equal(states.at(-1).phase, 'saved');
  assert.equal(states.at(-1).unsaved, false);
  sync.stop();
});

test('conflict preserves unsaved state and never overwrites newer cloud data', async () => {
  const states = [];
  let writes = 0;
  const sync = createPreferencesSync({ request: async (method) => { if (method === 'GET') return { revision: 1, preferences: {} }; writes++; const error = new Error('Changed in another tab'); error.status = 409; throw error; }, apply: () => {}, status: (state) => states.push(state), debounceMs: 60000 });
  await sync.start('owner');
  sync.changed({ snap: 'bar' });
  await sync.flush();
  assert.equal(writes, 1);
  assert.deepEqual(states.at(-1), { phase: 'error', error: 'Changed in another tab', conflict: true, unsaved: true });
  sync.stop();
});

test('owner switches cancel pending writes and ignore stale reads', async () => {
  const old = deferred();
  const applied = [];
  const calls = [];
  const sync = createPreferencesSync({ request: (method) => { calls.push(method); return calls.length === 1 ? old.promise : Promise.resolve({ revision: 0, preferences: { snap: 'beat' } }); }, apply: (prefs) => applied.push(prefs), status: () => {}, debounceMs: 60000 });
  const first = sync.start('first');
  await sync.start('second');
  old.resolve({ revision: 8, preferences: { snap: 'bar' } });
  await first;
  assert.deepEqual(applied, [{ snap: 'beat' }]);
  sync.changed({ snap: 'none' });
  sync.stop();
  await tick();
  assert.deepEqual(calls, ['GET', 'GET']);
});

test('a failed PUT remains unsaved and retries the same revision without losing the edit', async () => {
  const writes = [];
  const states = [];
  const sync = createPreferencesSync({ request: async (method, body) => {
    if (method === 'GET') return { revision: 7, preferences: { snap: 'step' } };
    writes.push(body);
    if (writes.length === 1) throw new Error('Offline');
    return { revision: 8, preferences: body.preferences };
  }, apply: () => {}, status: (state) => states.push(state), debounceMs: 60000 });
  await sync.start('owner');
  sync.changed({ snap: 'bar' });
  await sync.flush();
  assert.equal(states.at(-1).unsaved, true);
  assert.equal(states.at(-1).phase, 'error');
  await sync.retry();
  assert.deepEqual(writes, [{ revision: 7, preferences: { snap: 'bar' } }, { revision: 7, preferences: { snap: 'bar' } }]);
  assert.equal(states.at(-1).phase, 'saved');
  sync.stop();
});
