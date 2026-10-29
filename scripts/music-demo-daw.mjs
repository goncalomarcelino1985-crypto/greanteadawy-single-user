#!/usr/bin/env node
/* global window */
// Run after source separation + npm run build in GitHub Actions. No production
// endpoint, real credential, synthetic oscillator or local-Mac audio processing.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(repo, 'demo-output');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const labels = { mixture: 'Original preservado', vocals: 'Voz', drums: 'Bateria', bass: 'Baixo', other: 'Outros instrumentos' };
const bpm = 126;
const report = { status: 'starting', generatedAt: new Date().toISOString(), execution: 'GitHub Actions Linux; isolated loopback DAW',
  syntheticAudioCreated: false, productionAccessed: false, tempoGridBpm: bpm,
  tempoNote: '126 BPM is the arrangement grid; imported recordings are not time-stretched.', commands: [], inputs: {}, exports: {} };
let server, browser, page, mcp, temporary;
const stage = (name) => { report.stage = name; console.log(`Music demo: ${name}`); };

const writeJson = (name, value) => fs.writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
const musicalState = (project) => {
  const copy = structuredClone(project);
  for (const key of ['rev', 'createdAt', 'updatedAt']) delete copy[key];
  return copy;
};
const portable = (project) => {
  const copy = structuredClone(project);
  delete copy.ownerId;
  return copy;
};

function audioFacts(bytes, decodeWav) {
  const decoded = decodeWav(new Uint8Array(bytes));
  let peak = 0, square = 0, count = 0;
  for (const channel of decoded.channels) for (const value of channel) {
    assert.ok(Number.isFinite(value), 'Audio contains a non-finite sample');
    peak = Math.max(peak, Math.abs(value)); square += value * value; count++;
  }
  assert.ok(count && peak > 1e-7, 'Audio must contain real non-silent samples');
  return { facts: { sha256: hash(bytes), bytes: bytes.length, sampleRate: decoded.sampleRate,
    channels: decoded.channels.length, frames: decoded.totalFrames, durationSeconds: decoded.totalFrames / decoded.sampleRate,
    bitsPerSample: decoded.bitsPerSample, peak, peakDb: 20 * Math.log10(peak), rms: Math.sqrt(square / count), nonzero: true }, decoded };
}

async function main() {
  stage('validate real input audio');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Audio demo runs only in GitHub Actions, never on the personal computer');
  assert.equal(process.platform, 'linux', 'This demo requires the isolated Linux CI runner');
  await fs.access(path.join(repo, 'client/dist/index.html'));
  const [{ chromium }, { createServer }, { loadConfig }, { connectMcp }, { decodeWav }] = await Promise.all([
    import('@playwright/test'), import('../server/src/index.js'), import('../server/src/config.js'),
    import('../e2e/helpers.js'), import('@greanteadawy/core')
  ]);
  const inputs = {};
  for (const name of Object.keys(labels)) {
    const bytes = await fs.readFile(path.join(output, `${name}.wav`));
    const { facts } = audioFacts(bytes, decodeWav);
    assert.ok(facts.durationSeconds >= 2 && facts.durationSeconds <= 30.1, 'Demo inputs must be short real excerpts, 2–30 seconds');
    inputs[name] = bytes; report.inputs[name] = facts;
  }
  const duration = report.inputs.mixture.durationSeconds;
  for (const facts of Object.values(report.inputs)) {
    assert.equal(facts.sampleRate, report.inputs.mixture.sampleRate, 'Stem sample rates must match');
    assert.equal(facts.frames, report.inputs.mixture.frames, 'Stems must remain sample-aligned');
  }

  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gm-real-music-demo-'));
  stage('start isolated single-user DAW');
  const privateKey = crypto.randomBytes(32).toString('base64url');
  // Deliberately do not merge process.env: the demo cannot inherit cloud credentials.
  server = await createServer({ ...loadConfig({ HOST: '127.0.0.1', PORT: '0', SINGLE_USER: 'true',
    PRIVATE_ACCESS_KEY: privateKey, STORAGE_MODE: 'local', FFMPEG_PATH: 'off', PLUGINS_ENABLED: 'false' }),
    dataDir: path.join(temporary, 'data'), clientDist: path.join(repo, 'client/dist') });
  await new Promise((resolve, reject) => { server.server.once('error', reject); server.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === base || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  const authorized = await context.request.post(`${base}/private/access`, { data: { key: privateKey } });
  assert.equal(authorized.status(), 200, 'Temporary single-user browser authorization failed');
  page = await context.newPage();
  const browserErrors = [];
  report.browserErrors = browserErrors;
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto(base);
  await page.locator('.toolbar').waitFor();
  await page.waitForFunction(() => window.greanteadawy?.store.getState().connected && window.greanteadawy.store.getState().project);
  assert.equal(await page.evaluate(() => window.greanteadawy.store.getState().auth.singleUser), true);
  const tokenResponse = await context.request.post(`${base}/api/me/token`);
  assert.equal(tokenResponse.status(), 201);
  mcp = await connectMcp(base, (await tokenResponse.json()).token);

  async function call(name, args = {}, command) {
    stage(`MCP ${name}`);
    const result = await mcp.client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
    const blocks = result.content.filter((entry) => entry.type === 'text').map((entry) => entry.text);
    if (result.isError) throw new Error(`${name}: ${blocks.join('\n')}`);
    report.commands.push({ tool: name, ...(command ? { commandPortuguese: command } : {}), args });
    let data;
    for (const text of blocks) { try { data = JSON.parse(text); } catch { /* The leading block is a human-readable report. */ } }
    return { text: blocks.join('\n'), data };
  }
  const getProject = async (id) => {
    const response = await context.request.get(`${base}/api/projects/${encodeURIComponent(id)}`);
    assert.equal(response.status(), 200); return response.json();
  };
  async function waitForProject(id, revision) {
    stage(`wait for browser project ${id}${revision === undefined ? '' : ` at revision ${revision}`}`);
    report.expectedBrowser = { projectId: id, revision };
    await page.waitForFunction(({ id, revision }) => {
      const app = window.greanteadawy;
      const p = app?.store.getState().project;
      // Incremental ops advance Sync.rev. The project snapshot's rev remains
      // its last full-load revision until a resync; it is not the live counter.
      return p?.id === id && app.sync.projectId === id &&
        (revision === undefined || app.sync.rev === revision);
    }, { id, revision }, { timeout: 20_000 });
    if (revision !== undefined) {
      const visible = await page.evaluate(() => window.greanteadawy.store.getState().project);
      assert.deepEqual(musicalState(visible), musicalState(await getProject(id)), 'Browser musical state differs from the server');
    }
  }
  const samples = {};
  for (const [name, bytes] of Object.entries(inputs)) {
    stage(`upload and analyse ${name}.wav`);
    const response = await context.request.post(`${base}/api/samples`, { multipart: {
      file: { name: `${name}.wav`, mimeType: 'audio/wav', buffer: bytes }, name: labels[name]
    }, timeout: 120_000 });
    assert.equal(response.status(), 201, `${name}: upload failed`);
    samples[name] = await response.json();
    assert.ok(samples[name].analysis, `${name}: actual server WAV analysis missing`);
    await call('get_sample_info', { sampleId: samples[name].id }, `Analisa o ficheiro real: ${labels[name]}.`);
  }
  await page.mouse.click(900, 45);
  await page.evaluate(async (ids) => {
    const state = window.greanteadawy.store.getState();
    await state.refreshSamples();
    const engine = await state.unlockAudio();
    for (const id of ids) await engine.loadSample(id);
  }, Object.values(samples).map((sample) => sample.id));
  await writeJson('samples.json', Object.entries(samples).map(([name, sample]) => ({ ...sample, ownerId: undefined, file: `${name}.wav`, sourceStem: name })));

  async function createProject(name) {
    await call('create_project', { name, bpm, template: 'empty' }, `Cria o projeto ${name}, com grelha de ${bpm} BPM.`);
    const response = await context.request.get(`${base}/api/active`);
    assert.equal(response.status(), 200);
    const id = (await response.json()).projectId;
    await waitForProject(id);
    return id;
  }
  async function exportWav(id, file) {
    await waitForProject(id);
    const { data } = await call('export_audio', { projectId: id, format: 'wav', mode: 'song', bitDepth: 24 }, 'Exporta o áudio real deste arranjo em WAV.');
    assert.ok(data?.export?.name, 'DAW export did not return its saved WAV');
    const response = await context.request.get(`${base}/api/exports/${encodeURIComponent(data.export.name)}`);
    assert.equal(response.status(), 200);
    const bytes = await response.body();
    const metrics = audioFacts(bytes, decodeWav);
    assert.equal(metrics.facts.bitsPerSample, 24);
    assert.ok(Math.abs(metrics.facts.durationSeconds - (duration + 1.5)) < 0.05, 'DAW render duration differs from the source plus render tail');
    await fs.writeFile(path.join(output, file), bytes);
    report.exports[file] = { ...metrics.facts, generatedBy: 'DAW export_audio → browser render job → WAV export' };
    return metrics;
  }

  const originalId = await createProject('GM AI WORKER — original preservado');
  await call('add_audio_clip', { projectId: originalId, sampleId: samples.mixture.id, startBar: 1, track: 1 });
  await call('update_track', { projectId: originalId, track: 1, name: labels.mixture });
  await writeJson('original-project.json', portable(await getProject(originalId)));
  await exportWav(originalId, 'original-daw.wav');

  const projectId = await createProject('GM AI WORKER — demonstração real');
  for (const [index, name] of ['vocals', 'drums', 'bass', 'other'].entries()) {
    await call('add_audio_clip', { projectId, sampleId: samples[name].id, startBar: 1, track: index + 1 });
    await call('update_track', { projectId, track: index + 1, name: labels[name],
      color: ['#61c2ff', '#ff9e63', '#91d676', '#cc9bff'][index] });
  }
  const before = await getProject(projectId);
  assert.equal(before.playlist.clips.length, 4);
  await waitForProject(projectId, before.rev);
  await call('play', { projectId, mode: 'song' }, 'Reproduz o arranjo com as quatro pistas reais.');
  await page.waitForFunction(() => window.greanteadawy.store.getState().playing &&
    window.greanteadawy.engine()?.getLevels().some((level) => level > 1e-5), null, { timeout: 15_000 });
  report.playback = await page.evaluate(() => ({ playing: window.greanteadawy.store.getState().playing,
    audioContextState: window.greanteadawy.engine().ctx.state, peakMeter: Math.max(...window.greanteadawy.engine().getLevels()) }));
  await call('stop', { projectId });
  const beforeAudio = await exportWav(projectId, 'stems-before-daw.wav');
  await call('save_version', { projectId, name: 'Antes de alterar bateria e baixo' });
  const drum = before.playlist.clips.find((clip) => clip.refId === samples.drums.id);
  const bass = before.playlist.clips.find((clip) => clip.refId === samples.bass.id);
  const secondsPerBar = 4 * 60 / bpm;
  const muteBars = duration >= 5 * secondsPerBar ? 4 : Math.max(0.25, Math.min(3, Math.floor(duration / secondsPerBar / 2)));
  const totalBars = drum.length / 384;
  const change = { projectId, clips: [
    { clipId: drum.id, startBar: 1 + muteBars, offsetBars: muteBars, bars: totalBars - muteBars },
    { clipId: bass.id, gainDb: -3 }
  ] };
  await call('update_clips', change, `Mantém tudo; silencia a bateria nos primeiros ${muteBars} compassos e reduz o baixo 3 dB.`);
  const changed = await getProject(projectId);
  const changedDrum = changed.playlist.clips.find((clip) => clip.id === drum.id);
  const changedBass = changed.playlist.clips.find((clip) => clip.id === bass.id);
  assert.equal(changedDrum.start, Math.round(muteBars * 384));
  assert.equal(changedDrum.offset, Math.round(muteBars * 384));
  assert.ok(Math.abs(changedBass.gain - 10 ** (-3 / 20)) < 1e-8);
  const untouchedBefore = structuredClone(before), untouchedAfter = structuredClone(changed);
  for (const p of [untouchedBefore, untouchedAfter]) p.playlist.clips = p.playlist.clips.filter((clip) => ![drum.id, bass.id].includes(clip.id));
  assert.deepEqual(musicalState(untouchedAfter), musicalState(untouchedBefore), 'Unrequested parts of the project changed');

  await call('undo', { projectId }, 'Desfaz a última alteração, recuperando a bateria e o baixo originais.');
  assert.deepEqual(musicalState(await getProject(projectId)), musicalState(before), 'Undo did not recover the exact arrangement');
  const { tools } = await mcp.client.listTools();
  const nativeRedo = tools.some((tool) => tool.name === 'redo');
  if (nativeRedo) await call('redo', { projectId }, 'Refaz a alteração.');
  else await call('update_clips', change, 'Repõe exatamente a alteração anterior da bateria e do baixo.');
  const final = await getProject(projectId);
  assert.deepEqual(musicalState(final), musicalState(changed), 'Reapplying the edit did not restore the changed arrangement');
  report.edit = { drumsSilentBars: muteBars, drumsSilentSeconds: muteBars * secondsPerBar, bassGainDb: -3,
    untouchedPartsVerified: true, undoExactStateVerified: true, nativeMcpRedoAvailable: nativeRedo,
    redoMethod: nativeRedo ? 'redo' : 'reapplied identical MCP update_clips command', redoExactStateVerified: true };
  await waitForProject(projectId, final.rev);
  const afterAudio = await exportWav(projectId, 'altered-daw.wav');
  assert.notEqual(beforeAudio.facts.sha256, afterAudio.facts.sha256, 'Before/after WAV files are identical');
  assert.equal(beforeAudio.decoded.totalFrames, afterAudio.decoded.totalFrames);
  let difference = 0, count = 0;
  for (let c = 0; c < beforeAudio.decoded.channels.length; c++) {
    const a = beforeAudio.decoded.channels[c], b = afterAudio.decoded.channels[c];
    for (let i = 0; i < a.length; i++) { difference += (a[i] - b[i]) ** 2; count++; }
  }
  report.edit.audioDifferenceRms = Math.sqrt(difference / count);
  assert.ok(report.edit.audioDifferenceRms > 1e-6, 'The musical edit must change real rendered audio');
  await writeJson('project.json', portable(final));
  await page.evaluate(() => {
    const state = window.greanteadawy.store.getState();
    state.openWindow('playlist'); state.moveWindow('playlist', { max: true });
  });
  await page.locator('[data-window="playlist"]').waitFor();
  await page.screenshot({ path: path.join(output, 'screenshot.png'), fullPage: true });
  for (const name of Object.keys(labels)) assert.equal(hash(await fs.readFile(path.join(output, `${name}.wav`))), report.inputs[name].sha256, 'An input WAV was modified');
  assert.deepEqual(browserErrors, [], 'The DAW raised browser exceptions');
  report.status = 'verified';
  report.projectId = projectId; report.originalProjectId = originalId;
  report.originalInputUnchanged = true; report.browserErrors = browserErrors;
  report.previewImport = 'project.json references sample IDs listed in samples.json; upload/remap those WAVs when importing into another studio.';
  await writeJson('daw-report.json', report);
  console.log(JSON.stringify({ status: report.status, project: 'GM AI WORKER — demonstração real',
    exports: Object.keys(report.exports), undoVerified: true, audioDifferenceRms: report.edit.audioDifferenceRms }));
}

try { await main(); }
catch (error) {
  report.status = 'failed'; report.failure = error.message;
  report.failureStack = error.stack;
  if (page) report.browserAtFailure = await page.evaluate(() => {
    const app = window.greanteadawy;
    const state = app?.store.getState();
    return { connected: state?.connected, authPhase: state?.auth?.phase, followClaude: state?.followClaude,
      projectId: state?.project?.id, projectRevision: state?.project?.rev, syncProjectId: app?.sync.projectId,
      syncRevision: app?.sync.rev, clipCount: state?.project?.playlist.clips.length };
  }).catch(() => ({ unavailable: true }));
  await fs.mkdir(output, { recursive: true });
  await writeJson('daw-report.json', report);
  console.error(`Real music DAW demonstration failed at ${report.stage}: ${error.stack}`);
  console.error(JSON.stringify({ expected: report.expectedBrowser, actual: report.browserAtFailure, browserErrors: report.browserErrors,
    completedTools: report.commands.map((command) => command.tool) }));
  process.exitCode = 1;
} finally {
  await mcp?.close().catch(() => {});
  await browser?.close().catch(() => {});
  if (server) {
    for (const client of server.hub.clients) client.ws.terminate();
    server.hub.wss.close();
    server.server.closeAllConnections();
    await new Promise((resolve) => server.server.close(resolve));
    await server.store.flush(); await server.sessions.flush(); await server.users.writing;
  }
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
}
