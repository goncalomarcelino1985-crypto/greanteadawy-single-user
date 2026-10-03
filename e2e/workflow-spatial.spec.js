// Spatial (Atmos-style) mixing in a real browser: Claude places 3D objects, the studio monitors binaurally, and the
// exports (binaural, 5.1, 7.1.4, object stems, ADM BWF) put the sound where the objects are.
import { test, expect } from '@playwright/test';
import { decodeWav, SPEAKER_LAYOUTS } from '@greanteadawy/core';
import { ADMIN, connectMcp } from './helpers.js';

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

const fetchWav = async (out, ext = 'wav') => {
  const url = out.match(new RegExp(`(/api/exports/[^\\s)]+\\.${ext})`))[1];
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  return new Uint8Array(await res.body());
};
const energy = (ch) => { let s = 0; for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i]; return s; };
const chunkIds = (bytes) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ids = [];
  for (let o = 12; o + 8 <= bytes.length;) {
    const id = String.fromCharCode(...bytes.subarray(o, o + 4));
    const size = v.getUint32(o + 4, true);
    ids.push([id, o + 8, size]);
    o += 8 + size + (size % 2);
  }
  return ids;
};

test('one object: 5.1 puts it in its speaker, 7.1.4 lifts it to the heights, binaural to the ear', async () => {
  await claude.call('create_project', { name: 'E2E Space', template: 'empty', bpm: 120 });
  await expect(page).toHaveTitle(/E2E Space/);
  await claude.call('add_channel', { name: 'Lead', instrument: 'synth', preset: 'Square Lead' });
  await claude.call('create_pattern', { name: 'Tune', bars: 1 });
  await claude.call('write_melody', { pattern: 'Tune', channel: 'Lead', melody: 'C5:4 E5:4 G5:4 C6:4' });
  expect(await claude.call('place_object', { insert: 'Lead', position: 'rear-left' })).toMatch(/x -1, y -1, z 0/);

  const out51 = await claude.call('export_spatial', { format: '5.1', mode: 'pattern', pattern: 'Tune', loops: 1 });
  expect(out51).toMatch(/Exported 5\.1 speakers/);
  const w51 = await fetchWav(out51);
  expect(new DataView(w51.buffer).getUint32(40, true)).toBe(SPEAKER_LAYOUTS['5.1'].mask);
  const d51 = decodeWav(w51);
  expect(d51.channels.length).toBe(6);
  expect(d51.sampleRate).toBe(48000);
  const e = d51.channels.map(energy);
  const ls = SPEAKER_LAYOUTS['5.1'].speakers.findIndex(([id]) => id === 'Ls');
  // rear-left (-135°) pans between Ls (-110°) and, across the back, Rs (+110°): mostly Ls, nothing in the front
  expect(e[ls]).toBeGreaterThan(0.85 * e.reduce((a, b) => a + b, 0));
  expect(e[0] + e[1] + e[2]).toBeLessThan(e[ls] * 0.001);

  await claude.call('place_object', { insert: 'Lead', position: 'overhead' });
  const w714 = decodeWav(await fetchWav(await claude.call('export_spatial', { format: '7.1.4', mode: 'pattern', pattern: 'Tune', loops: 1 })));
  expect(w714.channels.length).toBe(12);
  const e714 = w714.channels.map(energy);
  const tops = e714.slice(8).reduce((a, b) => a + b, 0);
  expect(tops).toBeGreaterThan(0.95 * e714.reduce((a, b) => a + b, 0));

  await claude.call('place_object', { insert: 'Lead', position: 'left' });
  const outB = await claude.call('export_spatial', { format: 'binaural', mode: 'pattern', pattern: 'Tune', loops: 1 });
  expect(outB).toMatch(/Binaural loudness -?\d+(\.\d)? LUFS/);
  const wb = decodeWav(await fetchWav(outB));
  expect(wb.channels.length).toBe(2);
  expect(energy(wb.channels[0])).toBeGreaterThan(4 * energy(wb.channels[1])); // HRTF: the left ear hears it louder
});

test('Claude spatializes a band: moving objects, object stems with positions, ADM BWF', async () => {
  await claude.call('create_project', { name: 'E2E Atmos Band', template: 'band' });
  await expect(page).toHaveTitle(/E2E Atmos Band/);
  await claude.call('place_object', { insert: 'Strings', position: 'overhead' });
  await claude.call('place_object', { insert: 'Guitar', position: 'wide-left' });
  await claude.call('place_object', { insert: 'Piano', position: 'front-right', z: 0.3 });
  expect(await claude.call('move_object', { insert: 'Strings', path: 'circle', startBar: 13, bars: 8, height: 0.6 })).toMatch(/circle/);
  expect(await claude.call('set_spatial', { monitor: 'binaural' })).toMatch(/monitoring binaural/);

  const objs = await claude.call('export_spatial', { format: 'objects', mode: 'pattern', pattern: 'Strings', loops: 1 });
  expect(objs).toMatch(/E2E_Atmos_Band-bed\.wav/);
  expect(objs).toMatch(/obj\d\d-Strings\.wav/);
  const positions = JSON.parse(Buffer.from(await fetchWav(objs, 'json')).toString('utf8'));
  expect(positions.objects.map((o) => o.name).sort()).toEqual(['Guitar', 'Piano', 'Strings']);

  const adm = await claude.call('export_spatial', { format: 'adm' });
  expect(adm).toMatch(/ADM BWF is experimental/);
  const bytes = await fetchWav(adm);
  const ids = chunkIds(bytes);
  expect(ids.map(([id]) => id)).toEqual(['fmt ', 'bext', 'chna', 'axml', 'data']);
  const [, at, size] = ids.find(([id]) => id === 'axml');
  const xml = Buffer.from(bytes.subarray(at, at + size)).toString('utf8');
  expect(xml).toMatch(/audioObjectName="Strings"/);
  // the circling strings have many timed blocks, the static guitar one
  const blocksOf = (name) => {
    const ch = xml.split('<audioChannelFormat ').find((c) => c.includes(`audioChannelFormatName="${name}"`));
    return (ch.match(/<audioBlockFormat /g) || []).length;
  };
  expect(blocksOf('Strings')).toBeGreaterThan(8);
  expect(blocksOf('Guitar')).toBe(1);
  expect(decodeWav(bytes).channels.length).toBe(2 + 3);
});

test('the Spatial window shows the objects and dragging one moves it', async () => {
  await page.locator('.tbtn.win[title^="Spatial mixer"]').click();
  const win = page.locator('.window.spatial');
  await expect(win).toBeVisible();
  await expect(win.locator('.toggle', { hasText: '3D ON' })).toBeVisible();
  const state = () => page.evaluate(() => window.greanteadawy.store.getState().project);
  const p = await state();
  const guitar = p.mixer.findIndex((m) => m.name === 'Guitar');
  const dot = win.getByTestId(`obj-${guitar}`);
  await expect(dot).toBeVisible();
  const room = await win.locator('svg.room').boundingBox();
  const box = await dot.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(room.x + room.width * 0.8, room.y + room.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await state()).mixer[guitar].spatial.x).toBeGreaterThan(0.3);
  // the mixer strip shows "3D" instead of a pan knob
  await page.keyboard.press('F9');
  await expect(page.locator('.window.mixer .strip-3d').first()).toBeVisible();
});

test('binaural monitoring plays live through HRTF panners', async () => {
  const r = await page.evaluate(async () => {
    const { store } = window.greanteadawy;
    const eng = await store.getState().unlockAudio();
    const p = store.getState().project;
    const ch = p.channels.find((c) => c.name === 'Strings');
    const v = eng.noteOn(ch.id, 67, 0.8);
    await new Promise((res) => setTimeout(res, 100));
    v?.release(eng.ctx.currentTime + 0.05);
    return { mode: eng.rig.mode, panners: eng.rig.nodes.size, voice: !!v };
  });
  expect(r).toEqual({ mode: 'binaural', panners: 3, voice: true });
});

test('no uncaught errors in the browser', async () => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
