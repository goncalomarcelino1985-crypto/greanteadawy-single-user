// Unit contract tests only: mocked responses are not evidence of cloud separation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMvsepProvider } from '../src/music/mvsep.js';

const token = 'unit-test-private-token';
const jobHash = 'unit-test-job.wav';
const stems = ['drums', 'bass', 'vocals', 'other'];
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const free = () => response({ success: true, data: { premium_enabled: 0, api_token: token, email: 'fixture@example.invalid' } });
const created = () => response({ success: true, data: { hash: jobHash } });
const done = (patch = {}) => ({ success: true, status: 'done', data: { output_format: 1,
  algorithm: 'Demucs4 HT', files: [...stems, 'instrumental'].map(stem => ({
    url: `https://de.mvsep.com/storage/processed/aa/input_htdemucs_ft_mt_0_${stem}.wav`,
    download: `input_htdemucs_ft_mt_0_${stem}.wav`
  })), ...patch } });

async function fixture(t, values = []) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gm-mvsep-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'private-source-title.wav');
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  await writeFile(inputPath, bytes);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(new URL(url).origin, 'https://de.mvsep.com');
    assert.ok(options.signal instanceof AbortSignal);
    const next = values.shift();
    assert.ok(next, 'Unexpected API call');
    if (typeof next === 'function') return next(url, options);
    return next;
  };
  return { dir, inputPath, bytes, calls, fetchImpl,
    provider: createMvsepProvider({ token, fetchImpl, pollIntervalMs: 1, timeoutMs: 1000 }) };
}

test('free check is read-only, requires explicit disabled credits and returns no account secrets', async () => {
  for (const premium_enabled of [0, '0']) {
    const calls = [];
    const provider = createMvsepProvider({ token, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ success: true, data: { premium_enabled, api_token: token, email: 'secret@example.invalid' } });
    } });
    assert.deepEqual(await provider.checkFreeAccount(), { provider: 'MVSEP', premiumEnabled: false, paidCreditsAllowed: false });
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, '/api/app/user');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.redirect, 'error');
  }
});

test('all missing, ambiguous or enabled premium states fail closed before upload', async t => {
  for (const value of [undefined, null, false, true, 1, '1', '', 'false']) {
    const f = await fixture(t, [() => response({ success: true, data: { premium_enabled: value } })]);
    await assert.rejects(f.provider.separate({ inputPath: f.inputPath }), { code: 'MVSEP_FREE_REQUIRED' });
    assert.equal(f.calls.length, 1);
  }
});

test('missing token makes no network request', async () => {
  let calls = 0;
  const provider = createMvsepProvider({ fetchImpl: async () => { calls++; } });
  await assert.rejects(provider.checkFreeAccount(), { code: 'MVSEP_AUTH_REQUIRED' });
  await assert.rejects(provider.separate({ inputPath: '/unused' }), { code: 'MVSEP_AUTH_REQUIRED' });
  assert.equal(calls, 0);
});

test('uploads actual WAV bytes without original title, requests only free four-stem WAV, preserves input', async t => {
  const f = await fixture(t, [free, async (_url, options) => {
    const form = options.body;
    assert.ok(form instanceof FormData);
    assert.deepEqual([...form.keys()].sort(), ['audiofile', 'api_token', 'sep_type', 'add_opt1', 'output_format', 'is_demo'].sort());
    assert.equal(form.get('api_token'), token);
    assert.equal(form.get('sep_type'), '20');
    assert.equal(form.get('add_opt1'), '0');
    assert.equal(form.get('output_format'), '1');
    assert.equal(form.get('is_demo'), '0');
    assert.equal(form.get('audiofile').name, 'input.wav');
    assert.equal(form.get('audiofile').type, 'audio/wav');
    assert.deepEqual(Buffer.from(await form.get('audiofile').arrayBuffer()), f.bytes);
    return created();
  }, () => response({ success: true, status: 'waiting', data: { current_order: 3, message: token } }),
  () => response({ success: true, status: 'processing', data: {} }), () => response(done())]);
  const progress = [];
  const result = await f.provider.separate({ inputPath: f.inputPath, onProgress: value => progress.push(value) });
  assert.equal(result.provider, 'MVSEP');
  assert.equal(result.model, 'htdemucs_ft');
  assert.equal(result.jobHash, jobHash);
  assert.deepEqual(Object.keys(result.files).sort(), [...stems].sort());
  assert.deepEqual(progress, [{ status: 'submitting' }, { status: 'waiting', queuePosition: 3 },
    { status: 'processing' }, { status: 'separated' }]);
  assert.deepEqual(await readFile(f.inputPath), f.bytes);
  for (const { url, options } of f.calls.slice(2)) {
    assert.equal(options.method, 'GET');
    assert.deepEqual([...new URL(url).searchParams.keys()], ['hash']);
    assert.ok(!url.includes(token));
  }
});

test('rejects missing, duplicate, contradictory and non-WAV stems', async t => {
  const results = [
    done({ files: done().data.files.slice(0, 3) }),
    done({ files: [...done().data.files, done().data.files[0]] }),
    done({ files: done().data.files.map((f, i) => i ? f : { ...f, category: 'bass' }) }),
    done({ files: done().data.files.map((f, i) => i ? f : { ...f, url: f.url.replace('.wav', '.mp3') }) }),
    done({ output_format: 0 })
  ];
  for (const result of results) {
    const f = await fixture(t, [free, created, () => response(result)]);
    await assert.rejects(f.provider.separate({ inputPath: f.inputPath }), error => error.code.startsWith('MVSEP_INVALID_'));
  }
});

test('does not confuse stem words in input names with terminal stem identity', async t => {
  const value = done({ files: stems.map(stem => ({ url: `https://sg.mvsep.com/storage/processed/aa/my_vocals_bass_drums_song_${stem}.wav` })) });
  const f = await fixture(t, [free, created, () => response(value)]);
  const result = await f.provider.separate({ inputPath: f.inputPath });
  assert.deepEqual(Object.keys(result.files), stems);
});

test('rejects external hosts, non-HTTPS, credentials, unexpected path and redirects', async t => {
  for (const url of ['https://mvsep.com.evil.invalid/storage/processed/a/drums.wav',
    'https://other.mvsep.com/storage/processed/a/drums.wav', 'http://de.mvsep.com/storage/processed/a/drums.wav',
    'https://user:password@de.mvsep.com/storage/processed/a/drums.wav', 'https://de.mvsep.com:8443/storage/processed/a/drums.wav',
    'https://de.mvsep.com/private/drums.wav', 'https://de.mvsep.com/storage/processed/a/drums.wav#secret']) {
    const result = done(); result.data.files[0].url = url;
    const f = await fixture(t, [free, created, () => response(result)]);
    await assert.rejects(f.provider.separate({ inputPath: f.inputPath }), { code: 'MVSEP_INVALID_RESPONSE' });
  }
  const f = await fixture(t, [() => new Response(null, { status: 302, headers: { location: 'https://evil.invalid' } })]);
  await assert.rejects(f.provider.separate({ inputPath: f.inputPath }), { code: 'MVSEP_REDIRECT' });
  assert.equal(f.calls.length, 1);
});

test('only WAV regular files are sent and symlinks are refused', async t => {
  const f = await fixture(t);
  const link = path.join(f.dir, 'linked.wav'); await symlink(f.inputPath, link);
  await assert.rejects(f.provider.separate({ inputPath: link }), { code: 'MVSEP_INPUT' });
  await writeFile(f.inputPath, 'ID3 this is not a decoded WAV');
  await assert.rejects(f.provider.separate({ inputPath: f.inputPath }), { code: 'MVSEP_INPUT' });
  assert.equal(f.calls.length, 0);
});

test('remote failures and low-level errors never echo secrets, URLs or source paths; create is not retried', async t => {
  const f = await fixture(t, [free, () => { throw new Error(`network ${token} ${f.inputPath}`); }]);
  await assert.rejects(f.provider.separate({ inputPath: f.inputPath }), error => {
    assert.equal(error.code, 'MVSEP_NETWORK');
    assert.ok(!String(error.stack).includes(token));
    assert.ok(!String(error.stack).includes(f.inputPath));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(f.calls.length, 2);
  const failed = await fixture(t, [free, created,
    () => response({ success: true, status: 'failed', data: { message: `secret ${token}` } })]);
  await assert.rejects(failed.provider.separate({ inputPath: failed.inputPath }), { code: 'MVSEP_JOB_FAILED' });
});

test('unknown status and oversized or malformed JSON are rejected', async t => {
  for (const value of [() => new Response('not-json'), () => new Response(' '.repeat(512 * 1024 + 1)),
    () => response({ success: true, status: 'secret', data: {} })]) {
    const f = await fixture(t, [free, created, value]);
    await assert.rejects(f.provider.separate({ inputPath: f.inputPath }), { code: 'MVSEP_INVALID_RESPONSE' });
  }
});

test('timeout stops polling without new submission or cancellation and concurrent job is refused', async t => {
  let unblock;
  const f = await fixture(t, [free, created, () => new Promise(resolve => { unblock = resolve; })]);
  const first = f.provider.separate({ inputPath: f.inputPath });
  while (!unblock) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.provider.separate({ inputPath: f.inputPath }), { code: 'MVSEP_BUSY' });
  unblock(response(done()));
  await first;
  const requests = [];
  const provider = createMvsepProvider({ token, pollIntervalMs: 50, timeoutMs: 25, fetchImpl: async (url) => {
    requests.push(url);
    if (url.includes('/app/user')) return free();
    if (url.includes('/create')) return created();
    return response({ success: true, status: 'waiting', data: {} });
  } });
  await assert.rejects(provider.separate({ inputPath: f.inputPath }), { code: 'MVSEP_TIMEOUT' });
  assert.equal(requests.filter(url => url.includes('/create')).length, 1);
  assert.equal(requests.length, 3);
});
