// Production workflow in a real browser: Claude builds a track with the production tools (groove, fills,
// transitions, markers, kick-triggered sidechain), measures sounds, renders against a target and exports stems.
// Named so it runs after studio.spec.js (which performs first-run setup).
import { test, expect } from '@playwright/test';
import { decodeWav } from '@greanteadawy/core';
import { ADMIN, connectMcp, menuItem } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let claude;
const errors = [];

test.beforeAll(async ({ browser, baseURL }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto('/');
  const status = await (await page.request.get('/api/auth/status')).json();
  if (status.setupRequired) await page.request.post('/api/auth/setup', { data: ADMIN });
  else if (!status.user) await page.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
  await page.goto('/');
  await expect(page.locator('.toolbar')).toBeVisible();
  claude = await connectMcp(baseURL);
});
test.afterAll(async () => {
  await claude?.close();
  await page?.close();
});

test('Claude builds a trap track with the production tools', async () => {
  await claude.call('create_project', { name: 'E2E Production', template: 'trap' });
  await expect(page).toHaveTitle(/E2E Production/);
  expect(await claude.call('apply_groove', { preset: 'trap' })).toMatch(/trap/);
  expect(await claude.call('add_fill', { pattern: 'Drums', style: 'hat_roll' })).toMatch(/Drums Fill/);
  expect(await claude.call('add_transition', { type: 'impact', atBar: 5 })).toMatch(/impact/);
  expect(await claude.call('add_transition', { type: 'riser', atBar: 5, bars: 2 })).toMatch(/riser/);
  // the template already marks Intro and Hook: re-adding them changes nothing, a new one appears in the playlist
  expect(await claude.call('set_markers', { add: [{ bar: 1, name: 'Intro' }, { bar: 5, name: 'Hook' }, { bar: 13, name: 'Outro' }] })).toMatch(/Outro/);
  await expect(page.locator('.pl-marker', { hasText: 'Hook' })).toHaveCount(1);
  await expect(page.locator('.pl-marker', { hasText: 'Outro' })).toBeVisible();
  // the template's 808 ducks on the kick (pump with a source channel)
  expect(await claude.call('get_project', {})).toMatch(/pump\[[^\]]+\]\{source:"Kick"/);
});

test('analyze_sound measures single sounds in the browser', async () => {
  const bass = await claude.call('analyze_sound', { channel: '808', note: 'C2' });
  expect(bass).toMatch(/SOUND — "808" note C2/);
  expect(bass).toMatch(/Low end: strongest frequency (6[0-9]|7[0-2])(\.\d)? Hz/); // C2 = 65.4 Hz
  expect(bass).toMatch(/Envelope: attack \d+ ms/);
  const kick = await claude.call('analyze_sound', { channel: 'Kick', through: 'insert' });
  expect(kick).toMatch(/Level: -\d+(\.\d)? LUFS/);
});

test('render_mix reports true peak, limiter work and the distance to a target', async () => {
  const report = await claude.call('render_mix', { target: 'streaming', stems: true });
  expect(report).toMatch(/true peak -?\d+(\.\d)? dBTP/);
  expect(report).toMatch(/Master limiter: gain reduction/);
  expect(report).toMatch(/Target streaming .*-14 LUFS/);
  expect(report).toMatch(/low peak \d+(\.\d)? Hz/); // bass stems name their low note
});

test('export_stems writes one 24-bit WAV per channel into exports', async () => {
  const out = await claude.call('export_stems', { mode: 'pattern', pattern: 'Drums', loops: 1 });
  const m = out.match(/Exported (\d+) stems \(24-bit/);
  expect(m, out).toBeTruthy();
  expect(Number(m[1])).toBeGreaterThanOrEqual(3);
  const url = out.match(/(\/api\/exports\/[^\s)]+\.wav)/)[1];
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  const wav = decodeWav(new Uint8Array(await res.body()));
  expect(wav.bitsPerSample).toBe(24);
  expect(wav.channels.length).toBe(2);
});

test('File menu: stems and 24-bit WAV export', async () => {
  await page.locator('.tbtn.logo').click();
  await menuItem(page, 'Export stems');
  await expect(page.locator('.toast', { hasText: /Exported \d+ stems/ })).toBeVisible({ timeout: 60000 });
});

test('reverb buses add space, not level (regression guard)', async () => {
  const diffs = await page.evaluate(async () => {
    const p = window.greanteadawy.store.getState().project;
    const chords = p.patterns.find((x) => x.name === 'Chords');
    const padInsert = p.channels.find((c) => c.name === 'Pad').mixerTrack;
    const noMaster = { ...p, mixer: p.mixer.map((m, i) => (i === 0 ? { ...m, effects: [] } : m)) };
    const variant = (amount) => ({ ...noMaster, mixer: noMaster.mixer.map((m, i) => ({ ...m, sends: i === padInsert && amount ? m.sends.map((s) => ({ ...s, amount })) : [] })) });
    const db = (b) => {
      let s = 0;
      let n = 0;
      for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) s += d[i] * d[i]; n += d.length; }
      return 10 * Math.log10(s / n);
    };
    const render = async (proj) => db((await window.greanteadawy.render(proj, { mode: 'pattern', patternId: chords.id, loops: 1, encode: false, tail: 3 })).buffer);
    const dry = await render(variant(0));
    return { full: (await render(variant(1))) - dry, normal: (await render(variant(0.35))) - dry };
  });
  // a full send to a 100%-wet reverb adds a clearly audible but not louder-than-dry return; a normal send is subtle
  expect(diffs.full).toBeGreaterThan(0.2);
  expect(diffs.full).toBeLessThan(6);
  expect(Math.abs(diffs.normal)).toBeLessThan(2);
});

test('File menu: 24-bit WAV download', async () => {
  await page.locator('.tbtn.logo').click();
  await page.locator('.context-menu .cm-item', { hasText: 'Export song as WAV' }).first().hover();
  const download = page.waitForEvent('download', { timeout: 90000 });
  await page.locator('.cm-sub .cm-item', { hasText: '24-bit' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/24-bit\)\.wav$/);
  const fs = await import('node:fs/promises');
  const bytes = new Uint8Array(await fs.readFile(await file.path()));
  expect(decodeWav(bytes).bitsPerSample).toBe(24);
});

test('audio clip fades and repitch render without errors', async () => {
  const n = 44100;
  const bytes = new Uint8Array(44 + n * 2);
  const v = new DataView(bytes.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 330 * i) / 44100) * 12000), true);
  const up = await page.request.post('/api/samples', { multipart: { file: { name: 'e2e-loop.wav', mimeType: 'audio/wav', buffer: Buffer.from(bytes) } } });
  expect(up.status()).toBe(201);
  const id = (await up.json()).id;
  expect(await claude.call('add_audio_clip', { sampleId: id, startBar: 1, fit: 'repitch', sampleBpm: 120, gainDb: -3, fadeInSteps: 2, fadeOutSteps: 4 })).toMatch(/Repitched/);
  const report = await claude.call('render_mix', { stems: false });
  expect(report).toMatch(/LUFS integrated/);
  expect(report).not.toMatch(/INVALID RENDER/);
});

test('Settings → Audio export shows ffmpeg; File → Export song as… MP3 downloads an MP3', async () => {
  const info = await (await page.request.get('/api/exports/formats')).json();
  await page.locator('.tbtn.logo').click();
  await menuItem(page, 'Settings…');
  await page.locator('.settings-tabs button', { hasText: 'Audio export' }).click();
  const status = page.getByTestId('ffmpeg-status');
  await expect(status).toContainText(info.ffmpeg.available ? `ffmpeg ${info.ffmpeg.version} is available` : 'ffmpeg is not available');
  await expect(page.locator('.export-formats tr', { hasText: 'FLAC' })).toBeVisible();
  await page.locator('.window.settings .wbtn.close').click();
  await page.locator('.tbtn.logo').click();
  await page.locator('.context-menu .cm-item', { hasText: 'Export song as…' }).hover();
  const mp3 = page.locator('.cm-sub .cm-item', { hasText: /^MP3 \(320 kbps\)/ });
  if (!info.formats.find((f) => f.id === 'mp3').available) {
    await expect(mp3).toBeDisabled();
    return;
  }
  const download = page.waitForEvent('download', { timeout: 120000 });
  await mp3.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.mp3$/);
  const fs = await import('node:fs/promises');
  const head = (await fs.readFile(await file.path())).subarray(0, 3);
  expect(head.toString('latin1') === 'ID3' || head[0] === 0xff).toBe(true);
  // the intermediate WAV is gone, the MP3 stays in Exports
  const names = (await (await page.request.get('/api/exports')).json()).map((x) => x.name);
  expect(names.some((n) => n.endsWith('.mp3'))).toBe(true);
});

test('no uncaught errors in the browser', async () => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
