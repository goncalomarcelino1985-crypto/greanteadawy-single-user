// The GarageBand-style band instruments in a real browser: Claude builds a band arrangement over MCP, the physical
// models (piano, guitar, bass, pizzicato) render in background workers, and every instrument plays live and offline.
import { test, expect } from '@playwright/test';
import { ADMIN, connectMcp } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let claude;
const errors = [];
const workerScripts = [];

test.beforeAll(async ({ browser, baseURL }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('worker', (w) => workerScripts.push(w.url()));
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

const BAND = [
  { name: 'Piano', instrument: 'piano', preset: 'Grand' },
  { name: 'Rhodes', instrument: 'epiano', preset: 'Suitcase' },
  { name: 'Organ', instrument: 'organ', preset: 'Gospel' },
  { name: 'Guitar', instrument: 'guitar', preset: 'Clean Electric' },
  { name: 'Bass', instrument: 'bass', preset: 'Finger' },
  { name: 'Strings', instrument: 'strings', preset: 'Ensemble' },
  { name: 'Pizz', instrument: 'strings', preset: 'Pizzicato' }
];

test('list_instruments describes the band instruments', async () => {
  const list = await claude.call('list_instruments', {});
  for (const kind of ['piano', 'epiano', 'organ', 'guitar', 'bass', 'strings']) expect(list).toMatch(new RegExp(`^${kind} \\(`, 'm'));
  expect(await claude.call('list_instruments', { kind: 'organ' })).toMatch(/db16/);
});

test('Claude builds a band arrangement that renders cleanly', async () => {
  await claude.call('create_project', { name: 'E2E Band', bpm: 96 });
  await expect(page).toHaveTitle(/E2E Band/);
  for (const ch of BAND) expect(await claude.call('add_channel', ch)).toMatch(new RegExp(ch.name));
  const chords = ['Cmaj7', 'Am7', 'Dm7', 'G7'];
  await claude.call('create_pattern', { name: 'Band' });
  for (const channel of ['Piano', 'Rhodes', 'Organ', 'Strings']) {
    await claude.call('add_chords', { pattern: 'Band', channel, chords, voicing: 'drop2', register: channel === 'Strings' ? 'G4' : 'E4' });
  }
  await claude.call('add_chords', { pattern: 'Band', channel: 'Guitar', chords, style: 'rhythm', rhythm: 'x--x--x-', octave: 3 });
  await claude.call('add_chords', { pattern: 'Band', channel: 'Pizz', chords, style: 'arp-up', octave: 4 });
  await claude.call('add_bassline', { pattern: 'Band', channel: 'Bass', chords, line: 'R:4 5:2 R:2~ 8:4 b7:4' });
  await claude.call('place_pattern', { pattern: 'Band', startBar: 1, track: 1 });
  const report = await claude.call('render_mix', { stems: true });
  expect(report).not.toMatch(/INVALID RENDER|NaN/);
  expect(report).toMatch(/LUFS integrated/);
  for (const ch of BAND) expect(report).toMatch(new RegExp(`${ch.name}[^\\n]*LUFS`));
  // the bass guitar is a bass in the mix advice (its low note is reported like an 808's)
  expect(report).toMatch(/Bass[^\n]*low peak \d+(\.\d)? Hz/);
});

test('Claude asks for the export formats and exports the band as FLAC (ffmpeg on the server)', async () => {
  const formats = await claude.call('list_export_formats', {});
  expect(formats).toMatch(/- wav — WAV/);
  if (!/ffmpeg [^\s]+ is available/.test(formats)) {
    await expect(claude.call('export_audio', { format: 'flac' })).rejects.toThrow(/can't be exported here/);
    return;
  }
  const out = await claude.call('export_audio', { format: 'flac', title: 'Band Demo', artist: 'E2E' });
  expect(out).toMatch(/Exported E2E_Band-[\w-]+\.flac \(FLAC, 24-bit/);
  const url = out.match(/(\/api\/exports\/[^\s)]+\.flac)/)[1];
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  expect((await res.body()).subarray(0, 4).toString('latin1')).toBe('fLaC');
});

test('physical models render in background workers; every band instrument plays live', async () => {
  await expect.poll(() => workerScripts.some((u) => /modelWorker/.test(u)), { timeout: 15000 }).toBe(true);
  const voices = await page.evaluate(async () => {
    const { store } = window.greanteadawy;
    const eng = await store.getState().unlockAudio();
    const out = {};
    for (const ch of store.getState().project.channels) {
      const v = eng.noteOn(ch.id, 60, 0.8);
      out[ch.name] = !!v;
      await new Promise((r) => setTimeout(r, 60));
      v?.release(eng.ctx.currentTime + 0.05);
    }
    return out;
  });
  for (const ch of BAND) expect(voices[ch.name], ch.name).toBe(true);
});

test('Browser lists the Keys, Guitar and Strings categories', async () => {
  for (const cat of ['Keys', 'Guitar', 'Strings']) await expect(page.locator('.br-cat', { hasText: cat })).toBeVisible();
  await expect(page.locator('.br-name', { hasText: 'Drawbar Organ' })).toBeVisible();
});

test('no uncaught errors in the browser', async () => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
