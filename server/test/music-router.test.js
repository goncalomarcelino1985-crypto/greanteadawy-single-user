// Router contract tests use a mocked separator. These are NOT evidence of cloud separation.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createMusicRouter } from '../src/music/router.js';
import { SampleLibrary } from '../src/samples.js';
import { ProjectStore } from '../src/store.js';

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gm-music-router-'));
  const samples = await new SampleLibrary(dir).init();
  const store = await new ProjectStore(dir).init();
  let submissions = 0;
  const bytes = Buffer.from('fixture-original-bytes-not-real-audio');
  const info = { frames: 44100, sampleRate: 44100, channels: 2, bitsPerSample: 16, durationSeconds: 1 };
  const audio = {
    prepareAudio: async ({ inputPath, outputPath }) => { await fs.copyFile(inputPath, outputPath); return info; },
    inspectWav: async () => info,
    analyzeTiming: async () => ({ bpm: 127, confidence: 0.75, beatPhaseSeconds: 0.1 }),
    validateStemAlignment: async () => ({ lagFrames: 0 }),
    renderArrangement: async ({ outputPath }) => { await fs.writeFile(outputPath, 'mock-render-not-audio'); return { ...info, outputGain: 1 }; }, ...overrides.audio
  };
  const auth = { requireUser: (req, res, next) => {
    if (!req.headers['x-test-owner']) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id: req.headers['x-test-owner'] }; next();
  }, requireSession: (req, res, next) => req.headers['x-test-session'] ? next() : res.status(403).end() };
  const providerFactory = () => ({ checkFreeAccount: async () => ({ premiumEnabled: false }), separate: async () => {
    submissions++; return { model: 'htdemucs_ft', files: Object.fromEntries(['drums', 'bass', 'vocals', 'other'].map(k => [k, `https://de.mvsep.com/storage/processed/fixture_${k}.wav`])) };
  } });
  const app = express();
  const router = await createMusicRouter({ config: { singleUser: true, storageMode: 'local', dataDir: dir, musicWorkbench: { enabled: true, ffmpegPath: '/mock' } },
    samples, store, auth, users: { update: async () => {} }, audio, providerFactory, fetchImpl: async () => new Response(bytes) });
  app.use('/api/music', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.flush(); await fs.rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, options = {}) => fetch(base + url, { ...options, headers: { 'x-test-owner': 'owner-a', ...options.headers } });
  const post = (url, body) => request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-session': 'yes' }, body: JSON.stringify(body || {}) });
  const poll = async (id, predicate) => {
    for (let i = 0; i < 100; i++) { const j = await (await request(`/api/music/jobs/${id}`)).json(); if (predicate(j)) return j; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('Job did not finish');
  };
  const upload = async (name = 'music.mp3') => {
    const form = new FormData(); form.append('file', new Blob([bytes]), name);
    const res = await request('/api/music/jobs', { method: 'POST', body: form }); assert.equal(res.status, 202);
    const initial = await res.json(); return poll(initial.id, j => !['preparing'].includes(j.status));
  };
  return { base, dir, bytes, request, post, poll, upload, store, get submissions() { return submissions; } };
}

test('private workbench preserves original bytes and hash; importing never submits to provider', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/music/jobs')).status, 401);
  assert.equal((await f.request('/api/music/capabilities')).status, 200);
  const j = await f.upload(); assert.equal(j.status, 'imported');
  assert.equal(j.original.sha256, crypto.createHash('sha256').update(f.bytes).digest('hex'));
  assert.deepEqual(Buffer.from(await (await f.request(j.original.url)).arrayBuffer()), f.bytes);
  assert.equal(f.submissions, 0);
  assert.equal((await f.post(`/api/music/jobs/${j.id}/separate`)).status, 409);
  assert.equal((await f.request(`/api/music/jobs/${j.id}`, { headers: { 'x-test-owner': 'owner-b' } })).status, 404);
  assert.equal((await f.request(`/api/music/jobs/${j.id}/files/job.json`)).status, 404);
});

test('four verified files create aligned DAW audio tracks, unique original, revision-aware export', async t => {
  const f = await fixture(t); const j = await f.upload('music.wav');
  const token = 'test-key-never-persisted';
  assert.equal((await f.post('/api/music/provider', { token })).status, 200);
  assert.equal((await f.post(`/api/music/jobs/${j.id}/separate`)).status, 202);
  const ready = await f.poll(j.id, job => ['ready', 'failed'].includes(job.status));
  assert.equal(ready.status, 'ready', ready.error); assert.equal(ready.stems.length, 4);
  assert.equal(ready.alignment.verified, true); assert.equal(f.submissions, 1);
  const project = await f.store.getOwned(ready.projectId, 'owner-a');
  assert.equal(project.bpm, 127); assert.equal(project.playlist.clips.length, 4);
  assert.ok(project.playlist.clips.every(clip => clip.start === 0 && clip.offset === 0 && clip.rate === 1));
  assert.equal((await f.post(`/api/music/jobs/${j.id}/separate`)).status, 409);
  assert.equal((await f.post(`/api/music/jobs/${j.id}/render`)).status, 202);
  const rendered = await f.poll(j.id, job => job.renderStatus === 'ready');
  assert.equal(rendered.edited.revision, rendered.projectRevision);
  assert.deepEqual(Buffer.from(await (await f.request(j.original.url)).arrayBuffer()), f.bytes);
  const persisted = await fs.readFile(path.join(f.dir, 'music-jobs', j.id, 'job.json'), 'utf8');
  assert.ok(!persisted.includes(token)); assert.ok(!persisted.includes('mvsep.com'));
});

test('alignment failure never exposes partial stems or creates a DAW project', async t => {
  const f = await fixture(t, { audio: { validateStemAlignment: async () => { throw new Error('bad alignment'); } } });
  const j = await f.upload(); await f.post('/api/music/provider', { token: 'unit-test-private-key' });
  await f.post(`/api/music/jobs/${j.id}/separate`);
  const result = await f.poll(j.id, job => job.status === 'failed');
  assert.equal(result.projectId, null);
  assert.equal((await f.request(`/api/music/jobs/${j.id}/files/drums.wav`)).status, 404);
  assert.equal((await f.post(`/api/music/jobs/${j.id}/open`)).status, 409);
  assert.deepEqual(Buffer.from(await (await f.request(j.original.url)).arrayBuffer()), f.bytes);
});

test('unknown or oversized ranges fail while retaining the original for download', async t => {
  const f = await fixture(t); const form = new FormData();
  form.append('file', new Blob([f.bytes]), 'original.mp3'); form.append('durationSeconds', '9999');
  const start = await (await f.request('/api/music/jobs', { method: 'POST', body: form })).json();
  const failed = await f.poll(start.id, j => j.status === 'failed');
  assert.match(failed.error, /Intervalo inválido/);
  assert.deepEqual(Buffer.from(await (await f.request(failed.original.url)).arrayBuffer()), f.bytes);
  assert.equal(f.submissions, 0);
});
