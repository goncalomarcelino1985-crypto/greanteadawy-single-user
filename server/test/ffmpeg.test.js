// ffmpeg export: detection, safe arguments, timeouts, the REST routes, the MCP tools — with a fake ffmpeg (always)
// and the real one (when installed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFfmpeg, cleanMetadata, readWavInfo } from '../src/ffmpeg.js';
import { loadConfig } from '../src/config.js';
import { startServer, agent, mcpClient, callTool, openSocket, makeWav } from './helpers.js';

let tmp;
let fake;
const realFfmpeg = (() => {
  try { execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** A 24-bit stereo WAV (sine). */
function wav24(seconds = 0.5, sr = 44100) {
  const n = Math.round(seconds * sr);
  const buf = Buffer.alloc(44 + n * 6);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 6, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 6, 28); buf.writeUInt16LE(6, 32); buf.writeUInt16LE(24, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 6, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 4000000);
    for (let c = 0; c < 2; c++) buf.writeIntLE(v, 44 + (i * 2 + c) * 3, 3);
  }
  return buf;
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-ffmpeg-'));
  // a fake ffmpeg: reports a version and a few encoders, records its arguments, can fail or hang on request
  fake = path.join(tmp, 'fake-ffmpeg.cjs');
  await fs.writeFile(fake, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('-version')) { console.log('ffmpeg version 9.9-fake Copyright (c) the FFmpeg developers'); process.exit(0); }
if (args.includes('-encoders')) { console.log(' V....D libx264  H.264\\n A....D libmp3lame  MP3\\n A....D aac  AAC\\n A....D flac  FLAC'); process.exit(0); }
const out = args[args.length - 1].replace(/^file:/, '');
const title = args.find((a) => a.startsWith('title=')) || '';
if (title === 'title=SLEEP') { setTimeout(() => {}, 60000); return; }
if (title === 'title=FAIL') { console.error('Invalid data found when processing input'); process.exit(1); }
fs.writeFileSync(out, 'FAKE AUDIO');
fs.writeFileSync(out + '.args', JSON.stringify({ args, env: Object.keys(process.env) }));
`, { mode: 0o755 });
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test('detection: disabled, missing and fake ffmpeg; formats know what they need', async () => {
  const off = createFfmpeg({ path: 'off' });
  assert.equal((await off.status()).available, false);
  const offFormats = await off.formats();
  assert.deepEqual(offFormats.filter((f) => f.available).map((f) => f.id), ['wav']);
  assert.match(offFormats.find((f) => f.id === 'mp3').reason, /Disabled/);

  const missing = createFfmpeg({ path: path.join(tmp, 'nope', 'ffmpeg') });
  const st = await missing.status();
  assert.equal(st.available, false);
  assert.doesNotMatch(st.reason, /nope/); // the configured path is never shown to users

  const f = createFfmpeg({ path: fake });
  const s = await f.status();
  assert.equal(s.available, true);
  assert.equal(s.version, '9.9-fake');
  assert.deepEqual(s.encoders, ['libmp3lame', 'aac', 'flac']); // video encoders ignored
  const byId = Object.fromEntries((await f.formats()).map((x) => [x.id, x]));
  assert.equal(byId.mp3.available, true);
  assert.equal(byId.mp3.encoder, 'libmp3lame');
  assert.equal(byId.aac.encoder, 'aac');
  assert.equal(byId.opus.available, false);
  assert.match(byId.opus.reason, /libopus/);
  assert.equal(byId.wav.available, true);
});

test('conversion arguments: file-only protocol, forced input format, sanitized metadata, stripped environment', async () => {
  const dir = path.join(tmp, 'exports-a');
  await fs.mkdir(dir);
  const input = path.join(dir, 'My_Song.wav');
  await fs.writeFile(input, wav24(0.1));
  const f = createFfmpeg({ path: fake });
  process.env.GTD_TEST_SECRET = 'x';
  const out = await f.convert({ input, format: 'mp3', bitrate: 192, metadata: { title: 'Hi\u0000\nthere -i /etc/passwd', artist: 'A'.repeat(500), evil: 'x' } });
  delete process.env.GTD_TEST_SECRET;
  assert.equal(out.name, 'My_Song.mp3');
  assert.equal(out.bitrate, 192);
  const { args, env } = JSON.parse(await fs.readFile(`${out.path}.args`, 'utf8'));
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('-protocol_whitelist'), 'file');
  assert.equal(at('-i'), `file:${input}`);
  // "-f wav -c:a pcm_s24le" right before the input: no format probing, and only the PCM decoder runs on user data
  assert.deepEqual(args.slice(args.indexOf('-i') - 4, args.indexOf('-i')), ['-f', 'wav', '-c:a', 'pcm_s24le']);
  assert.equal(args.at(-1), `file:${out.path}`);
  assert.ok(args.includes('-nostdin'));
  assert.equal(at('-b:a'), '192k');
  const meta = args.filter((a, i) => args[i - 1] === '-metadata');
  assert.ok(meta.includes('title=Hi there -i /etc/passwd')); // one argument: never parsed as options
  assert.ok(meta.some((m) => m.startsWith('artist=') && m.length === 'artist='.length + 200));
  assert.ok(meta.includes('comment=Made with GreanTeaDawy'));
  assert.ok(!meta.some((m) => m.startsWith('evil=')));
  assert.ok(!env.includes('GTD_TEST_SECRET'));

  // a second conversion never overwrites the first
  assert.equal((await f.convert({ input, format: 'mp3' })).name, 'My_Song-2.mp3');
  await assert.rejects(f.convert({ input, format: 'mp3', bitrate: 100 }), /bitrate must be one of/);
  await assert.rejects(f.convert({ input, format: 'opus' }), /no encoder/);
  await assert.rejects(f.convert({ input, format: 'wav' }), /no conversion needed/);
  await assert.rejects(f.convert({ input, format: 'exe' }), /Unknown format/);
  await fs.writeFile(path.join(dir, 'fake.wav'), 'not a wav');
  await assert.rejects(f.convert({ input: path.join(dir, 'fake.wav'), format: 'flac' }), /Only PCM\/float WAV/);
  // a failing ffmpeg leaves no file behind
  await assert.rejects(f.convert({ input, format: 'flac', metadata: { title: 'FAIL' } }), /Invalid data/);
  assert.deepEqual((await fs.readdir(dir)).filter((x) => x.endsWith('.flac')), []);
  assert.deepEqual(cleanMetadata({ date: 2026, genre: '' }), { date: '2026' });
  // prototype keys are not formats
  for (const format of ['__proto__', 'constructor', 'toString']) await assert.rejects(f.convert({ input, format }), /Unknown format/);
  // only PCM/float WAVs: a compressed codec inside a RIFF file (here MP3, tag 0x55) never reaches ffmpeg's decoders
  const mp3InWav = wav24(0.05);
  mp3InWav.writeUInt16LE(0x55, 20);
  await fs.writeFile(path.join(dir, 'odd.wav'), mp3InWav);
  await assert.rejects(f.convert({ input: path.join(dir, 'odd.wav'), format: 'flac' }), /Only PCM\/float WAV/);
  // formats have channel limits: say so instead of failing inside ffmpeg (or folding a 5.1 mix to stereo)
  const six = wav24(0.05);
  six.writeUInt16LE(6, 22);
  await fs.writeFile(path.join(dir, 'surround.wav'), six);
  await assert.rejects(f.convert({ input: path.join(dir, 'surround.wav'), format: 'mp3' }), (e) => e.status === 422 && /at most 2 channels; this render has 6/.test(e.message));
  // channels without speaker positions (an ADM/object render) only go to lossless formats
  await assert.rejects(f.convert({ input: path.join(dir, 'surround.wav'), format: 'aac' }), (e) => e.status === 422 && /without speaker positions/.test(e.message));
  six.writeUInt16LE(12, 22);
  await fs.writeFile(path.join(dir, 'atmos.wav'), six);
  await assert.rejects(f.convert({ input: path.join(dir, 'atmos.wav'), format: 'flac' }), /at most 8 channels; this render has 12. Use WAV or AIFF/);
  // ffmpeg's failure reason is shown (422), without the server's folders
  await assert.rejects(f.convert({ input, format: 'flac', metadata: { title: 'FAIL' } }), (e) => e.status === 422 && !e.message.includes(dir));
});

test('numeric settings: invalid values fall back to their defaults, valid ones are clamped', () => {
  const c = loadConfig({ FFMPEG_MAX_JOBS: 'x', FFMPEG_TIMEOUT_SEC: 'soon', PORT: '3005', MAX_UPLOAD_MB: '-4', SESSION_TTL_DAYS: '7' });
  assert.equal(c.ffmpegMaxJobs, 2);
  assert.equal(c.ffmpegTimeoutSec, 300);
  assert.equal(c.port, 3005);
  assert.equal(c.maxUploadMb, 1);
  assert.equal(c.sessionTtlDays, 7);
  assert.equal(loadConfig({ FFMPEG_MAX_JOBS: '1000' }).ffmpegMaxJobs, 64);
});

test('a hanging ffmpeg is killed after the timeout and runs are limited to maxJobs at a time', async () => {
  const dir = path.join(tmp, 'exports-b');
  await fs.mkdir(dir);
  const input = path.join(dir, 'x.wav');
  await fs.writeFile(input, wav24(0.05));
  const f = createFfmpeg({ path: fake, timeoutSec: 1, maxJobs: 1 });
  const t0 = Date.now();
  const hung = f.convert({ input, format: 'mp3', metadata: { title: 'SLEEP' } });
  const queued = f.convert({ input, format: 'aac' }); // waits for the slot
  await assert.rejects(hung, /longer than 1 s/);
  const ok = await queued;
  assert.ok(Date.now() - t0 >= 1000, 'the second run waited for the first');
  assert.equal(ok.name, 'x.m4a');
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.mp3')), []);
  // one user can't fill the queue, and waiting conversions don't leave placeholder files
  const g = createFfmpeg({ path: fake, timeoutSec: 2, maxJobs: 1 });
  const runs = [0, 1, 2].map(() => g.convert({ input, format: 'flac', owner: 'u1', metadata: { title: 'SLEEP' } }));
  runs.forEach((r) => r.catch(() => {})); // they time out later; settled below
  await assert.rejects(g.convert({ input, format: 'flac', owner: 'u1' }), (e) => e.status === 429); // counted at once
  const flacs = async () => (await fs.readdir(dir)).filter((n) => n.endsWith('.flac')).length;
  for (let i = 0; i < 100 && (await flacs()) === 0; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await flacs(), 1); // only the running one has an output file; the waiting ones reserve theirs later
  const other = g.convert({ input, format: 'mp3', owner: 'u2' }); // other users still queue
  await Promise.allSettled(runs);
  assert.match((await other).name, /^x(-\d+)?\.mp3$/);
});

test('real ffmpeg: every format converts and lossless keeps 24-bit', { skip: !realFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = path.join(tmp, 'exports-real');
  await fs.mkdir(dir);
  const input = path.join(dir, 'Real.wav');
  await fs.writeFile(input, wav24(0.5));
  assert.deepEqual(await readWavInfo(input), { format: 'pcm', channels: 2, sampleRate: 44100, bitsPerSample: 24, mask: null });
  const f = createFfmpeg({});
  const formats = (await f.formats()).filter((x) => x.available && x.id !== 'wav');
  assert.ok(formats.length >= 3, `only ${formats.map((x) => x.id)}`);
  const magic = { mp3: /^(ID3|\xff[\xfb\xf3\xf2])/, aac: /^....ftyp/s, alac: /^....ftyp/s, ogg: /^OggS/, opus: /^OggS/, flac: /^fLaC/, aiff: /^FORM....AIFF/s };
  for (const fmt of formats) {
    const out = await f.convert({ input, format: fmt.id, metadata: { title: 'Real Test', artist: 'Tester' } });
    const head = (await fs.readFile(out.path)).subarray(0, 16).toString('latin1');
    assert.match(head, magic[fmt.id], `${fmt.id} header`);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out.path]).toString());
    const stream = probe.streams[0];
    assert.equal(stream.channels, 2, fmt.id);
    if (['flac', 'alac', 'aiff'].includes(fmt.id)) assert.equal(Number(stream.bits_per_raw_sample || stream.bits_per_sample), 24, `${fmt.id} bit depth`);
    if (fmt.id === 'opus') assert.equal(Number(stream.sample_rate), 48000);
    const tags = { ...probe.format.tags, ...stream.tags };
    const title = Object.entries(tags).find(([k]) => k.toLowerCase() === 'title')?.[1];
    assert.equal(title, 'Real Test', `${fmt.id} title tag`);
  }
});

test('REST: status, formats, conversion of the user\'s own WAV exports only', async () => {
  const srv = await startServer({ FFMPEG_PATH: fake });
  try {
    const admin = agent(srv.base);
    await admin.post('/api/auth/setup', { username: 'boss', password: 'boss-pass-1' });
    const st = await admin.get('/api/system/ffmpeg');
    assert.equal(st.status, 200);
    assert.equal(st.body.ffmpeg.available, true);
    assert.ok(st.body.formats.find((f) => f.id === 'mp3').available);
    assert.equal((await admin.post('/api/system/ffmpeg/refresh', {})).status, 200);
    const token = (await admin.post('/api/me/token')).body.token;
    assert.equal((await admin.post('/api/system/ffmpeg/refresh', {}, { authorization: `Bearer ${token}`, cookie: '' })).status, 403);

    // a WAV export to convert
    const fd = new FormData();
    fd.append('file', new Blob([makeWav(0.2)], { type: 'audio/wav' }), 'x.wav');
    fd.append('name', 'Beat');
    const up = await admin.post('/api/exports', fd);
    assert.equal(up.status, 201);
    const name = up.body.export.name;
    const conv = await admin.post(`/api/exports/${name}/convert`, { format: 'mp3', bitrate: 256, metadata: { title: 'Beat' } });
    assert.equal(conv.status, 201, JSON.stringify(conv.body));
    assert.equal(conv.body.export.name, 'Beat.mp3');
    const list = (await admin.get('/api/exports')).body.map((e) => e.name);
    assert.ok(list.includes('Beat.mp3') && list.includes('Beat.wav'));
    assert.ok(!list.some((n) => n.endsWith('.args'))); // only real exports are listed
    assert.equal((await admin.get('/api/exports/Beat.mp3')).status, 200);

    assert.equal((await admin.post('/api/exports/Beat.mp3/convert', { format: 'flac' })).status, 400); // only WAVs
    assert.equal((await admin.post('/api/exports/..%2F..%2Fusers.json/convert', { format: 'mp3' })).status, 400);
    assert.equal((await admin.post('/api/exports/.upload-x.wav/convert', { format: 'mp3' })).status, 400);
    assert.equal((await admin.post('/api/exports/missing.wav/convert', { format: 'mp3' })).status, 404);
    assert.equal((await admin.post(`/api/exports/${name}/convert`, { format: 'mp4' })).status, 400);
    assert.equal((await admin.post(`/api/exports/${name}/convert`, { format: 'mp3', metadata: 'x' })).status, 400);
    assert.equal((await admin.post(`/api/exports/${name}/convert`, { format: 'opus' })).status, 409);

    // another user can't see or convert it
    await admin.post('/api/admin/users', { username: 'other', password: 'other-pass-1' });
    const other = agent(srv.base);
    await other.post('/api/auth/login', { username: 'other', password: 'other-pass-1' });
    assert.equal((await other.post(`/api/exports/${name}/convert`, { format: 'mp3' })).status, 404);
  } finally {
    await srv.close();
  }
});

test('MCP: list_export_formats and export_audio (browser render, server conversion, WAV cleaned up)', async () => {
  const srv = await startServer({ FFMPEG_PATH: fake });
  try {
    const user = agent(srv.base);
    await user.post('/api/auth/setup', { username: 'mcp', password: 'mcp-pass-1' });
    const client = await mcpClient(srv.base, (await user.post('/api/me/token')).body.token);
    const call = callTool(client);
    await call('create_project', { name: 'Export Me', template: 'empty' });
    const formats = await call('list_export_formats');
    assert.match(formats, /ffmpeg 9\.9-fake is available/);
    assert.match(formats, /- mp3 — MP3: .*bitrates 128\/160\/192\/256\/320 kbps \(default 320\)/);
    assert.match(formats, /- opus — Opus \[unavailable\]/);

    // fails fast, before any render, for formats or bitrates that can't be made
    await assert.rejects(call('export_audio', { format: 'opus' }), /can't be exported here/);
    await assert.rejects(call('export_audio', { format: 'flac', bitrate: 320 }), /no bitrate setting/);
    await assert.rejects(call('export_audio', { format: 'mp3', bitrate: 99 }), /bitrate must be one of/);

    const sock = openSocket(srv.base, user.cookie);
    assert.equal(await sock.opened, true);
    const jobs = [];
    sock.ws.on('message', async (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type !== 'job') return;
      jobs.push(msg.job);
      const fd = new FormData();
      fd.append('result', JSON.stringify({ mix: { lufs: -14.2, truePeakDb: -1.1 } }));
      fd.append('name', msg.job.name);
      fd.append('file', new Blob([makeWav(0.2)], { type: 'audio/wav' }), 'x.wav');
      await fetch(`${srv.base}/api/jobs/${msg.jobId}/result`, { method: 'POST', headers: { cookie: user.cookie }, body: fd });
    });
    const out = await call('export_audio', { format: 'mp3', bitrate: 256, artist: 'Claude & Pat' });
    assert.match(out, /Exported Export_Me-[\w-]+\.mp3 \(MP3, 256 kbps, .*-14\.2 LUFS integrated/);
    assert.equal(jobs[0].kind, 'render');
    assert.equal(jobs[0].bitDepth, 24); // lossy formats are encoded from a 24-bit render
    assert.equal(jobs[0].save, true);
    const files = (await user.get('/api/exports')).body.map((e) => e.name);
    assert.ok(files.some((n) => /\.mp3$/.test(n)));
    assert.ok(!files.some((n) => /\.wav$/.test(n)), 'intermediate WAV removed'); // keepWav defaults to false

    const wavOut = await call('export_audio', { format: 'wav', bitDepth: 16 });
    assert.match(wavOut, /16-bit WAV/);
    assert.equal(jobs[1].bitDepth, 16);
    sock.ws.close();
    await client.close();
  } finally {
    await srv.close();
  }
});
