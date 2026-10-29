#!/usr/bin/env node
// Test service only. Models and DAW renders already ran on the CI runner.
// First boot imports the reviewed public bundle; subsequent boots preserve edits.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/src/index.js';
import { loadConfig } from '../server/src/config.js';
import { exportsDir } from '../server/src/backend.js';
import { runningServer, writeLock } from '../server/src/lockfile.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'demo-output');
const targetService = 'srv-dbggemuk1f9s73e86bsg';
const targetUrl = 'https://gm-greanteadawy-test.onrender.com';
const inputFiles = ['mixture.wav', 'vocals.wav', 'drums.wav', 'bass.wav', 'other.wav'];
const exportFiles = ['original-daw.wav', 'stems-before-daw.wav', 'altered-daw.wav'];
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

async function readBundleFile(name, limit = 16 * 1024 * 1024) {
  const file = path.join(bundle, name);
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, `Invalid demo file: ${name}`);
  return fs.readFile(file);
}

async function readBundle() {
  const json = async (name) => JSON.parse(await readBundleFile(name, 2 * 1024 * 1024));
  const [separation, daw, samples, project, original] = await Promise.all([
    json('report.json'), json('daw-report.json'), json('samples.json'), json('project.json'), json('original-project.json')
  ]);
  assert.equal(daw.status, 'verified', 'Only a successfully rendered DAW demo can be served');
  assert.equal(separation.source.sha256, '66e0b1dcbd0825dc70674e7b53faa1c1195fc78a0d2afdd767734d9c3c10f936');
  assert.equal(separation.license.id, 'CC-BY-3.0');
  assert.deepEqual(separation.clip, { startSeconds: 60, durationSeconds: 30 });
  assert.equal(samples.length, 5);
  assert.equal(new Set(samples.map((sample) => sample.id)).size, 5);
  assert.deepEqual(samples.map((sample) => sample.file).sort(), [...inputFiles].sort());
  const audio = new Map();
  for (const name of [...inputFiles, ...exportFiles]) {
    const bytes = await readBundleFile(name);
    const expected = inputFiles.includes(name) ? separation.audio[name] : daw.exports[name];
    assert.equal(digest(bytes), expected.sha256, `Demo audio hash mismatch: ${name}`);
    assert.equal(bytes.length, expected.bytes, `Demo audio size mismatch: ${name}`);
    assert.ok(expected.durationSeconds > 0 && expected.durationSeconds < 35);
    audio.set(name, bytes);
  }
  const ids = new Set(samples.map((sample) => sample.id));
  for (const p of [project, original]) {
    assert.ok(p.playlist.clips.length > 0 && p.playlist.clips.length <= 4);
    assert.ok(p.playlist.clips.every((clip) => clip.kind === 'audio' && ids.has(clip.refId)), 'Unknown sample in demo project');
    assert.equal(p.channels.length, 0, 'This preview imports only the audio-clip demonstration');
  }
  return { samples, project, original, audio };
}

function configuration() {
  assert.equal(process.platform, 'linux', 'This test service is hosted online; do not start it on the Mac');
  assert.ok(process.env.RENDER_SERVICE_ID === targetService ||
    (!process.env.RENDER_SERVICE_ID && process.env.GITHUB_ACTIONS === 'true'), 'Wrong service: this entry point is test-only');
  assert.equal(process.env.SINGLE_USER, 'true', 'Single-user protection is required');
  assert.equal(process.env.STORAGE_MODE || 'local', 'local', 'The demo must not connect to the cloud data stores');
  const dataDir = process.env.DATA_DIR || 'data-music-demo';
  assert.ok(/^data-music-demo(?:-[a-z0-9-]+)?$/.test(path.basename(dataDir)), 'Use a dedicated data-music-demo directory');
  assert.ok(!Object.keys(process.env).some((key) => /^CLOUD_/.test(key) && process.env[key]), 'Cloud credentials must not be supplied to this demo');
  // Explicit allow-list: no .env loading, inherited database access or legacy MCP token.
  const config = loadConfig({ SINGLE_USER: 'true', PRIVATE_ACCESS_KEY: process.env.PRIVATE_ACCESS_KEY,
    HOST: process.env.HOST || '0.0.0.0', PORT: process.env.PORT || '10000',
    PUBLIC_URL: targetUrl, ALLOWED_HOSTS: 'gm-greanteadawy-test.onrender.com', TRUST_PROXY: '1',
    STORAGE_MODE: 'local', DATA_DIR: dataDir, EPHEMERAL_STORAGE: 'true',
    MAX_UPLOAD_MB: '50', PLUGINS_ENABLED: 'false', FFMPEG_PATH: 'off' });
  assert.ok(!process.env.PUBLIC_URL || process.env.PUBLIC_URL === targetUrl, 'Wrong public service URL');
  return config;
}

async function seed(ctx, content) {
  const owner = ctx.users.firstAdmin();
  const ids = new Map();
  for (const sample of content.samples) {
    const added = await ctx.samples.add({ ownerId: owner.id, name: sample.name,
      buffer: content.audio.get(sample.file), originalName: sample.file, mime: 'audio/wav' });
    ids.set(sample.id, added.id);
  }
  const imported = [];
  for (const source of [content.original, content.project]) {
    const project = structuredClone(source);
    for (const clip of project.playlist.clips) clip.refId = ids.get(clip.refId);
    imported.push(await ctx.store.create({ ownerId: owner.id, project }));
  }
  const dir = exportsDir(ctx.config.dataDir, owner.id);
  await fs.mkdir(dir, { recursive: true });
  for (const name of exportFiles) {
    await fs.copyFile(path.join(bundle, name), path.join(dir, name), constants.COPYFILE_EXCL);
  }
  await ctx.users.update(owner.id, { activeProjectId: imported.at(-1).id });
  await ctx.store.flush();
  await fs.writeFile(path.join(ctx.config.dataDir, 'music-demo-seeded.json'), JSON.stringify({
    createdAt: new Date().toISOString(), projectIds: imported.map((project) => project.id),
    source: 'Rataxes feat. Snowflake — A Better Way, CC BY 3.0',
    note: 'Public test excerpt. Render test storage is temporary; existing edits are never overwritten on restart.'
  }, null, 2), { flag: 'wx' });
}

async function main() {
  const config = configuration();
  assert.equal(await runningServer(config.dataDir), null, 'Another server is using this demo directory');
  const entries = await fs.readdir(config.dataDir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  // Once anything exists, never re-import, reset or overwrite user work.
  const fresh = entries.length === 0;
  const content = fresh ? await readBundle() : null;
  const ctx = await createServer(config);
  if (fresh) await seed(ctx, content);
  console.log(fresh ? 'Public music demonstration imported and verified.' : 'Existing demo data preserved; no re-import performed.');
  await new Promise((resolve, reject) => {
    ctx.server.once('error', reject);
    ctx.server.listen(config.port, config.host, resolve);
  });
  writeLock(config.dataDir, ctx.server.address().port, config.host);
  console.log(`GM AI WORKER test studio: ${targetUrl}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const client of ctx.hub.clients) client.ws.close(1001, 'Test service restart');
    ctx.hub.wss.close();
    ctx.server.closeAllConnections();
    await new Promise((resolve) => ctx.server.close(resolve));
    await ctx.store.flush(); await ctx.sessions.flush(); await ctx.users.writing; await ctx.samples.writing;
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error) => { console.error(`Music demo startup refused: ${error.message}`); process.exitCode = 1; });
