// The flute, beatbox, Indian and East Asian collections in a real browser: Claude builds one arrangement per collection
// over MCP, every channel renders (stems with real levels, no NaN), every instrument plays live, and the Browser and the
// "+ Channel" menu offer the new sections.
import { test, expect } from '@playwright/test';
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

// [channel, instrument, preset, part]: part = drum steps (one bar, repeated) or a melody / chord list
const COLLECTIONS = {
  Flutes: [
    ['Flute', 'flute', 'Lo-fi Flute', 'm:E5:4 G5:4 A5:6 -:2 G5:4 E5:4 D5:8'],
    ['Pan', 'panflute', 'Andes', 'm:A4:4 C5:4 D5:4 E5:4 D5:8 -:8'],
    ['Recorder', 'recorder', 'Soprano', 'c:Am,F'],
    ['Whistle', 'whistle', 'Irish', 'm:D5:2 E5:2 F#5:4 A5:4 B5:4 A5:8 -:8'],
    ['Ocarina', 'ocarina', 'Clay', 'm:C5:8 E5:8 G5:16']
  ],
  Beatbox: [
    ['BB Kick', 'bbkick', 'Classic B', 'x-----x---x-----'],
    ['BB Snare', 'bbsnare', 'Psh Spit Snare', '----x-------x---'],
    ['BB Hat', 'bbhat', 'T Hat', 'x-x-x-x-x-x-x-xo'],
    ['BB Bass', 'bbbass', 'Lip Bass', 'm:C2:6 C2:2 Eb2:4 G1:4 C2:8 Bb1:8'],
    ['BB FX', 'bbfx', 'Scratch', '------------x---']
  ],
  Indian: [
    ['Sitar', 'sitar', 'Sitar', 'm:C4:4 D4:2 E4:2 G4:6 F4:2 E4:4 D4:4 C4:8'],
    ['Tanpura', 'tanpura', 'Tanpura', 'm:G2:8 C3:8 C3:8 C2:8'],
    ['Dha', 'tabla', 'Dha', 'x-------x-------'],
    ['Na', 'tabla', 'Na', '--x-x-x---x-x-x-'],
    ['Bansuri', 'bansuri', 'Bansuri', 'm:G4:8 A4:4 C5:12 -:8'],
    ['Shehnai', 'shehnai', 'Shehnai', 'm:C5:6 D5:2 E5:8 D5:8 C5:8'],
    ['Santoor', 'santoor', 'Santoor', 'm:C5:2 E5:2 G5:2 C6:2 G5:2 E5:2 C5:4 D5:16'],
    ['Harmonium', 'harmonium', 'Male + Female', 'c:C,F']
  ],
  'East Asian': [
    ['Koto', 'koto', 'Koto', 'm:D4:2 E4:2 F4:4 A4:4 Bb4:4 A4:16'],
    ['Guzheng', 'guzheng', 'Guzheng', 'm:G4:2 A4:2 C5:2 D5:2 E5:8 D5:16'],
    ['Pipa', 'pipa', 'Pipa', 'm:E4:1 E4:1 E4:1 E4:1 G4:4 A4:8 -:16'],
    ['Shamisen', 'shamisen', 'Tsugaru', 'm:A3:2 A3:2 E4:4 D4:4 A3:4 -:16'],
    ['Erhu', 'erhu', 'Lament', 'm:G4:8 A4:4 B4:4 D5:16'],
    ['Shakuhachi', 'shakuhachi', 'Shakuhachi', 'm:D4:12 F4:4 G4:16'],
    ['Dizi', 'dizi', 'Dizi', 'm:D5:4 E5:4 G5:8 A5:16'],
    ['Suona', 'suona', 'Suona', 'm:A4:8 C5:8 D5:16'],
    ['Taiko', 'taiko', 'Odaiko', 'x-------x---x---'],
    ['Gong', 'gong', 'Opera Gong', 'x---------------']
  ]
};

test('list_instruments groups the new collections', async () => {
  const list = await claude.call('list_instruments', {});
  for (const label of ['Flutes', 'Beatbox', 'Indian', 'East Asian']) expect(list).toMatch(new RegExp(`^## ${label}$`, 'm'));
  for (const kind of ['flute', 'bbkick', 'sitar', 'tabla', 'koto', 'erhu', 'taiko', 'gong']) expect(list).toMatch(new RegExp(`^${kind} \\(`, 'm'));
  const indian = await claude.call('list_instruments', { category: 'indian' });
  expect(indian).toMatch(/^tabla \(/m);
  expect(indian).not.toMatch(/^koto \(/m);
  expect(await claude.call('list_instruments', { kind: 'sitar' })).toMatch(/sympathetic/);
});

for (const [collection, channels] of Object.entries(COLLECTIONS)) {
  test(`${collection}: Claude arranges every instrument and each one renders`, async () => {
    await claude.call('create_project', { name: `E2E ${collection}`, bpm: 92, template: 'empty' });
    await expect(page).toHaveTitle(new RegExp(`E2E ${collection}`));
    await claude.call('create_pattern', { name: 'Main', bars: 2 });
    for (const [name, instrument, preset, part] of channels) {
      expect(await claude.call('add_channel', { name, instrument, preset })).toMatch(new RegExp(name));
      if (part.startsWith('m:')) await claude.call('write_melody', { pattern: 'Main', channel: name, melody: part.slice(2) });
      else if (part.startsWith('c:')) await claude.call('add_chords', { pattern: 'Main', channel: name, chords: part.slice(2).split(','), octave: 4 });
      else await claude.call('write_drums', { pattern: 'Main', tracks: { [name]: part + part } });
    }
    await claude.call('place_pattern', { pattern: 'Main', startBar: 1, track: 1 });
    const report = await claude.call('render_mix', { stems: true });
    expect(report).not.toMatch(/INVALID RENDER|NaN/);
    expect(report).toMatch(/LUFS integrated/);
    for (const [name] of channels) expect(report).toMatch(new RegExp(`${name}[^\\n]*-\\d+(\\.\\d)? LUFS`));
  });
}

test('every new instrument plays live from the keyboard', async () => {
  await claude.call('create_project', { name: 'E2E World Live', template: 'empty' });
  await expect(page).toHaveTitle(/E2E World Live/);
  const kinds = [...new Set(Object.values(COLLECTIONS).flat().map(([, kind]) => kind))];
  for (const kind of kinds) await claude.call('add_channel', { name: kind, instrument: kind });
  const voices = await page.evaluate(async () => {
    const { store } = window.greanteadawy;
    const eng = await store.getState().unlockAudio();
    const out = {};
    for (const ch of store.getState().project.channels) {
      const v = eng.noteOn(ch.id, 60, 0.8);
      out[ch.name] = !!v;
      await new Promise((r) => setTimeout(r, 40));
      v?.release(eng.ctx.currentTime + 0.03);
    }
    return out;
  });
  for (const kind of kinds) expect(voices[kind], kind).toBe(true);
});

test('the Browser and the + Channel menu offer the new collections', async () => {
  await page.getByRole('tab', { name: 'Sounds' }).click();
  for (const cat of ['Flutes', 'Beatbox', 'Indian', 'East Asian']) await expect(page.locator('.br-cat', { hasText: new RegExp(`^${cat}$`) })).toBeVisible();
  const before = await page.locator('.ch-row').count();
  await page.locator('.br-item', { hasText: 'Shakuhachi' }).locator('.br-add').click();
  await expect(page.locator('.ch-row')).toHaveCount(before + 1);
  // + Channel: collection → instrument → preset
  await page.evaluate(() => window.greanteadawy.store.getState().openWindow('channelRack'));
  await page.locator('[data-window="channelRack"] .add-channel').click();
  await page.locator('.context-menu .cm-item', { hasText: 'Indian' }).hover();
  await page.locator('.cm-sub .cm-item', { hasText: 'Tabla' }).hover();
  await menuItem(page, 'Dhin');
  await expect(page.locator('.ch-row')).toHaveCount(before + 2);
  const last = await page.evaluate(() => window.greanteadawy.store.getState().project.channels.at(-1));
  expect(last.instrument).toMatchObject({ kind: 'tabla', preset: 'Dhin', params: { stroke: 'dhin' } });
});

test('velocity-0 notes are skipped without disturbing the transport', async () => {
  await claude.call('create_project', { name: 'E2E Zero', template: 'empty', bpm: 120 });
  await expect(page).toHaveTitle(/E2E Zero/);
  await claude.call('add_channel', { name: 'Kick', instrument: 'kick' });
  await claude.call('add_channel', { name: 'Roll', instrument: 'bbfx', preset: 'Click Roll' });
  await claude.call('add_channel', { name: 'Clap', instrument: 'clap' });
  await claude.call('create_pattern', { name: 'Beat', bars: 1 });
  await claude.call('write_drums', { pattern: 'Beat', tracks: { Kick: 'x---x---x---x---' } });
  for (const channel of ['Roll', 'Clap']) await claude.call('add_notes', { pattern: 'Beat', channel, notes: [{ note: 'C4', start: 8, length: 1, velocity: 0 }] });
  const kicks = await page.evaluate(async () => {
    const { store, engine } = window.greanteadawy;
    await store.getState().unlockAudio();
    const eng = engine();
    const kick = store.getState().project.channels.find((c) => c.name === 'Kick').id;
    store.getState().selectPattern(store.getState().project.patterns.find((x) => x.name === 'Beat').id);
    const starts = [];
    const orig = eng.triggerNote.bind(eng);
    eng.triggerNote = (id, ...rest) => { if (id === kick) starts.push(rest[2]); return orig(id, ...rest); };
    store.getState().play({ mode: 'pattern' });
    await new Promise((r) => setTimeout(r, 1300));
    store.getState().stop();
    eng.triggerNote = orig;
    return starts;
  });
  // the kicks keep coming, each scheduled exactly once (a refused voice used to make the scheduler retry the same
  // range on every tick, stacking duplicates)
  expect(kicks.length).toBeGreaterThanOrEqual(2);
  expect(new Set(kicks.map((t) => t.toFixed(4))).size).toBe(kicks.length);
});

test('no uncaught errors in the browser', async () => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
