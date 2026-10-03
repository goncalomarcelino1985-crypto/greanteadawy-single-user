// The sample library (folders, search, moving, deleting with a usage warning), the wave editor (selection, cut, undo,
// fades, save as new / replace original), pitch correction (auto-tune + a note moved by hand), the recorder (a fake
// microphone, alone and over the song) and Claude's edit_sample — in a real browser.
import { test, expect } from '@playwright/test';
import { trackPitch, findNotes, decodeWav } from '@greanteadawy/core';
import { ADMIN, connectMcp, makeWav, menuItem, voiceWav } from './helpers.js';

test.describe.configure({ mode: 'serial' });
test.use({
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['microphone']
});

/** @type {import('@playwright/test').Page} */
let page;
let claude;
const errors = [];

const sharp = (hz, cents) => hz * Math.pow(2, cents / 1200);

const state = (fn, arg) => page.evaluate(([f, a]) => new Function('s', 'a', `return (${f})(s, a)`)(window.greanteadawy.store.getState(), a), [fn.toString(), arg]);
const sampleByName = (name) => state((s, n) => s.samples.find((x) => x.name === n) || null, name);
const upload = async (name, buffer) => {
  const r = await page.request.post('/api/samples', { multipart: { file: { name: `${name}.wav`, mimeType: 'audio/wav', buffer } } });
  expect(r.status()).toBe(201);
  const item = await r.json();
  await expect.poll(() => sampleByName(name).then((s) => !!s)).toBe(true);
  return item;
};
const row = (name) => page.locator('.br-item.sample', { has: page.locator('.br-name', { hasText: new RegExp(`^${name}$`) }) });
const folderHeader = (name) => page.locator('.br-folder', { has: page.locator('.br-name', { hasText: new RegExp(`^${name}$`) }) });

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
  await claude.call('create_project', { name: 'E2E Samples', bpm: 120, template: 'empty', key: 'C', scale: 'major' });
  await expect(page).toHaveTitle(/E2E Samples/);
  await page.getByRole('tab', { name: 'Samples' }).click();
});
test.afterAll(async () => {
  await claude?.close();
  await page?.close();
});

test('folders: create, file by menu and by drag, search, collapse, bulk move', async () => {
  await upload('Kick Punch', makeWav({ freq: 60, seconds: 0.4 }));
  await upload('Snare Crack', makeWav({ freq: 200, seconds: 0.3 }));
  await upload('Vox Hook', voiceWav([{ hz: 220, dur: 0.6 }]));
  // no folders yet: a plain list
  if (!(await state((s) => s.sampleFolders.length))) await expect(page.locator('.br-folder')).toHaveCount(0);
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.locator('.modal input').fill('Drums');
  await page.locator('.modal .btn.primary').click();
  await expect(folderHeader('Drums')).toBeVisible();
  await expect(folderHeader('Unfiled')).toBeVisible();
  // ⋯ → Move to folder → Drums
  await row('Kick Punch').getByRole('button', { name: 'More actions for Kick Punch' }).click();
  await page.locator('.context-menu .cm-item', { hasText: 'Move to folder' }).hover();
  await page.locator('.cm-sub .cm-item', { hasText: 'Drums' }).click();
  await expect(folderHeader('Drums').locator('.br-meta')).toHaveText('1');
  // drag a sample onto the folder header
  await row('Snare Crack').dragTo(folderHeader('Drums'));
  await expect(folderHeader('Drums').locator('.br-meta')).toHaveText('2');
  expect((await sampleByName('Snare Crack')).folderId).toBeTruthy();
  // search matches name words across folders
  const search = page.getByRole('searchbox', { name: 'Search samples' });
  await search.fill('snare crack');
  await expect(page.locator('.br-item.sample')).toHaveCount(1);
  await search.fill('vox hook');
  await expect(page.locator('.br-item.sample')).toHaveCount(1);
  await expect(folderHeader('Drums')).toHaveCount(0);
  await search.fill('nothing like this');
  await expect(page.locator('.br-empty', { hasText: 'No samples match' })).toBeVisible();
  await search.fill('');
  // collapse remembers
  await folderHeader('Drums').getByRole('button', { name: 'Collapse Drums' }).click();
  await expect(row('Kick Punch')).toHaveCount(0);
  await folderHeader('Drums').getByRole('button', { name: 'Expand Drums' }).click();
  await expect(row('Kick Punch')).toBeVisible();
  // select mode: move two to a new folder
  await page.getByRole('button', { name: 'Select several samples' }).click();
  await row('Kick Punch').getByRole('checkbox').check();
  await row('Vox Hook').getByRole('checkbox').check();
  await expect(page.locator('.smp-bulk')).toContainText('2 selected');
  await page.locator('.smp-bulk').getByRole('button', { name: 'Move to…' }).click();
  await menuItem(page, 'New folder…');
  await page.locator('.modal input').fill('Keepers');
  await page.locator('.modal .btn.primary').click();
  await expect(folderHeader('Keepers').locator('.br-meta')).toHaveText('2');
  await page.locator('.smp-bulk').getByRole('button', { name: 'Done' }).click();
  // Claude sees the same folders
  const keepers = await claude.call('list_samples', { folder: 'Keepers' });
  expect(keepers).toMatch(/^## Keepers \[fld_\w+\]$/m);
  expect(keepers).toMatch(/Kick Punch/);
  expect(keepers).toMatch(/Vox Hook/);
  expect(keepers).toMatch(/Showing 2 of \d+ samples/);
  expect(await claude.call('list_samples', { query: 'snare' })).toMatch(/## Drums/);
  // rename and delete a folder from its menu: the samples stay (unfiled)
  const unfiledBefore = Number(await folderHeader('Unfiled').locator('.br-meta').textContent());
  await folderHeader('Keepers').getByRole('button', { name: 'Actions for folder Keepers' }).click();
  await menuItem(page, 'Delete folder…');
  await expect(page.locator('.modal')).toContainText('Its 2 samples will be kept');
  await page.locator('.modal .btn.danger').click();
  await expect(folderHeader('Keepers')).toHaveCount(0);
  await expect(folderHeader('Unfiled').locator('.br-meta')).toHaveText(String(unfiledBefore + 2));
});

test('deleting a sample that a project uses says where, and the channels go silent', async () => {
  const snare = await sampleByName('Snare Crack');
  await claude.call('add_channel', { name: 'Snare S', instrument: 'sampler', sampleId: snare.id });
  await claude.call('add_audio_clip', { sampleId: snare.id, startBar: 2 });
  await row('Snare Crack').getByRole('button', { name: 'More actions for Snare Crack' }).click();
  await menuItem(page, 'Delete…');
  const modal = page.locator('.modal');
  await expect(modal).toContainText('Still in use');
  await expect(modal).toContainText('E2E Samples (channel Snare S, 1 clip)');
  await modal.locator('.btn.danger').click();
  await expect(row('Snare Crack')).toHaveCount(0);
  expect(await sampleByName('Snare Crack')).toBeNull();
});

test('wave editor: select, delete, undo, fade, save as new, replace original (with the usage warning)', async () => {
  const vox = await sampleByName('Vox Hook');
  await claude.call('add_audio_clip', { sampleId: vox.id, startBar: 1 });
  await row('Vox Hook').getByRole('button', { name: 'More actions for Vox Hook' }).click();
  await menuItem(page, 'Edit in wave editor');
  const ed = page.getByTestId('wave-editor');
  await expect(ed).toBeVisible();
  await expect(page.getByTestId('wave-info')).toContainText('0.600 s');
  // drag-select the middle third, delete it, then undo
  const cv = page.getByTestId('wave-canvas');
  const b = await cv.boundingBox();
  await page.mouse.move(b.x + b.width / 3, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + (2 * b.width) / 3, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('wave-info')).toContainText('Selection');
  await ed.getByRole('button', { name: 'Delete selection' }).click();
  await expect(page.getByTestId('wave-info')).toContainText(/0\.4\d\d s/);
  await expect(page.locator('[data-window="waveEditor"] .window-name')).toContainText('•');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('wave-info')).toContainText('0.600 s');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByTestId('wave-info')).toContainText(/0\.4\d\d s/);
  // the project's undo was not touched by the editor's shortcuts
  expect(await state((s) => s.project.playlist.clips.length)).toBe(2);
  // a click on another window takes the keyboard there; a click on the editor's title bar brings it back
  await page.locator('[data-window="playlist"] .window-name').click();
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="wave-editor"]'))).toBe(false);
  await state((s) => s.focusWindow('waveEditor')); // (the playlist now covers the editor's title bar)
  await page.locator('[data-window="waveEditor"] .window-name').click();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('wave-info')).toContainText('0.600 s');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByTestId('wave-info')).toContainText(/0\.4\d\d s/);
  // … also when it is maximized (its title bar doesn't drag then)
  await state((s) => s.moveWindow('waveEditor', { max: true }));
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator('[data-window="waveEditor"] .window-name').click();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="wave-editor"]'))).toBe(true);
  // a second click keeps it there (the keys stay the editor's)
  await page.locator('[data-window="waveEditor"] .window-name').click();
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('wave-info')).toContainText('0.600 s');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.getByTestId('wave-info')).toContainText(/0\.4\d\d s/);
  await state((s) => s.moveWindow('waveEditor', { max: false }));
  expect(await state((s) => s.project.playlist.clips.length)).toBe(2);
  await ed.getByRole('button', { name: 'Fade out' }).click();
  // save as new: the original stays
  await ed.getByRole('button', { name: 'Save as new…' }).click();
  await page.locator('.modal input').fill('Vox Hook short');
  await page.locator('.modal .btn.primary').click();
  await expect.poll(() => sampleByName('Vox Hook short').then((s) => s?.duration)).toBeLessThan(0.5);
  expect((await sampleByName('Vox Hook')).duration).toBeCloseTo(0.6, 2);
  await expect(page.locator('[data-window="waveEditor"] .window-name')).toHaveText('Edit — Vox Hook short');
  // the focus is back in the editor (Ctrl+Z / Space stay its own, not the project's)
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="wave-editor"]'))).toBe(true);
  // replace the original: the warning names the project, the sample keeps its id and every user hears the new audio
  await row('Vox Hook').getByRole('button', { name: 'More actions for Vox Hook' }).click();
  await menuItem(page, 'Edit in wave editor');
  await expect(page.locator('[data-window="waveEditor"] .window-name')).toHaveText('Edit — Vox Hook');
  await expect(page.getByTestId('wave-info')).toContainText('0.600 s');
  await ed.locator('canvas.we-main').dblclick();
  await ed.getByRole('button', { name: 'Normalise' }).click();
  await ed.getByRole('button', { name: 'Replace original…' }).click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText('used in 1 project');
  await expect(modal).toContainText('E2E Samples');
  await modal.locator('.btn.danger').click();
  await expect.poll(() => sampleByName('Vox Hook').then((s) => s.rev)).toBe(2);
  // the engine drops the old decoded audio and loads the new revision
  await expect.poll(() => page.evaluate(async (id) => {
    const eng = await window.greanteadawy.store.getState().unlockAudio();
    const buf = await eng.loadSample(id);
    let peak = 0;
    for (const v of buf.getChannelData(0)) peak = Math.max(peak, Math.abs(v));
    return Math.round(20 * Math.log10(peak));
  }, vox.id)).toBe(-1);
  await expect(page.locator('[data-window="waveEditor"] .window-name')).not.toContainText('•');
});

test('pitch correction: auto-tune to the key, move a note by hand, save as a sample', async () => {
  // C4 +40 cents, D4 -35 cents, G4 +30 cents
  await upload('Vocal Take', voiceWav([{ hz: sharp(261.63, 40), dur: 0.45 }, { hz: 0, dur: 0.1 }, { hz: sharp(293.66, -35), dur: 0.45 }, { hz: 0, dur: 0.1 }, { hz: sharp(392, 30), dur: 0.45 }]));
  await row('Vocal Take').getByRole('button', { name: 'More actions for Vocal Take' }).click();
  await menuItem(page, 'Edit in wave editor');
  await page.locator('.we-tabs').getByRole('tab', { name: 'Pitch' }).click();
  await expect(page.getByTestId('pitch-status')).toContainText('3 notes');
  await expect(page.getByTestId('pitch-status')).toContainText(/largest move 0\.(3|4)\d semitones/);
  // the project is in C major: Key C, Scale major
  await expect(page.locator('.pv-controls select').first()).toHaveValue('C');
  await expect(page.locator('.pv-controls select').nth(1)).toHaveValue('major');
  await page.locator('.pv-presets').getByRole('button', { name: 'Robotic' }).click();
  // drag the last note (G4, sung 30 cents sharp) up two semitones to A4: its block is the longest blue run in a column
  const cv = page.getByTestId('pitch-canvas');
  const b = await cv.boundingBox();
  const noteY = (xr) => page.evaluate((xr) => {
    const c = document.querySelector('[data-testid="pitch-canvas"]');
    const dpr = window.devicePixelRatio || 1;
    const data = c.getContext('2d').getImageData(Math.round(c.clientWidth * xr * dpr), 0, 1, c.height).data;
    let best = -1;
    let len = 0;
    let run = 0;
    for (let y = 0; y < c.height; y++) {
      const [r, g, bl] = [data[4 * y], data[4 * y + 1], data[4 * y + 2]];
      run = bl > 120 && bl > r + 30 && g > 60 ? run + 1 : 0;
      if (run > len) { len = run; best = y - Math.floor(run / 2); }
    }
    return best / dpr;
  }, xr);
  const yOfNote = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="pitch-canvas"]');
    const dpr = window.devicePixelRatio || 1;
    const data = c.getContext('2d').getImageData(Math.round(c.clientWidth * 0.86 * dpr), 0, 1, c.height).data;
    let best = -1;
    let len = 0;
    let run = 0;
    for (let y = 0; y < c.height; y++) {
      const [r, g, bl] = [data[4 * y], data[4 * y + 1], data[4 * y + 2]];
      run = bl > 120 && bl > r + 30 && g > 60 ? run + 1 : 0;
      if (run > len) { len = run; best = y - Math.floor(run / 2); }
    }
    return best / dpr;
  });
  expect(yOfNote).toBeGreaterThan(0);
  const x = b.x + b.width * 0.86;
  await page.mouse.move(x, b.y + yOfNote);
  await page.mouse.down();
  for (let dy = 4; dy < 160; dy += 3) {
    await page.mouse.move(x, b.y + yOfNote - dy);
    if (/largest move 1\.[67]\d/.test(await page.getByTestId('pitch-status').textContent())) break;
  }
  await page.mouse.up();
  await expect(page.getByTestId('pitch-status')).toContainText(/largest move 1\.[67]\d semitones/);
  // split the first note in two, then join the halves again (fixing the detection by hand)
  await page.mouse.click(b.x + b.width * 0.12, b.y + (await noteY(0.12)), { button: 'right' });
  await menuItem(page, 'Split the note here');
  await expect(page.getByTestId('pitch-status')).toContainText('4 notes');
  await page.mouse.click(b.x + b.width * 0.05, b.y + (await noteY(0.05)), { button: 'right' });
  await menuItem(page, 'Join with the next note');
  await expect(page.getByTestId('pitch-status')).toContainText('3 notes');
  // the hand-placed note survives a look at the waveform
  await page.locator('.we-tabs').getByRole('tab', { name: 'Wave' }).click();
  await page.locator('.we-tabs').getByRole('tab', { name: 'Pitch' }).click();
  await expect(page.getByTestId('pitch-status')).toContainText(/largest move 1\.[67]\d semitones/);
  await expect(page.locator('.pv-presets .btn.on')).toHaveText('Robotic');
  await page.locator('.pv-controls').getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('pitch-status')).toContainText(/3 notes · largest move 0\.0\d/, { timeout: 30000 });
  await page.getByTestId('wave-editor').getByRole('button', { name: 'Save as new…' }).click();
  await page.locator('.modal input').fill('Vocal Tuned');
  await page.locator('.modal .btn.primary').click();
  await expect.poll(() => sampleByName('Vocal Tuned').then((s) => !!s)).toBe(true);
  const tuned = await sampleByName('Vocal Tuned');
  const res = await page.request.get(`/api/samples/${tuned.id}/file`);
  const wav = decodeWav(new Uint8Array(await res.body()));
  const notes = findNotes(trackPitch(wav.channels[0], wav.sampleRate));
  expect(notes.map((n) => Math.round(n.center))).toEqual([60, 62, 69]);
  for (const n of notes) expect(Math.abs(n.center - Math.round(n.center))).toBeLessThan(0.08);
  expect(tuned.folderId).toBe((await sampleByName('Vocal Take')).folderId);
  await page.locator('[data-window="waveEditor"] .wbtn.close').click();
});

test('recorder: a take from the (fake) microphone, alone and over the song, saved in Recordings and placed', async () => {
  await page.getByRole('button', { name: 'Record audio' }).click();
  const rec = page.getByTestId('recorder');
  await expect(rec).toBeVisible();
  await rec.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(rec.getByRole('meter')).toBeVisible();
  await expect.poll(() => rec.getByRole('meter').getAttribute('data-db').then(Number), { timeout: 10000 }).toBeGreaterThan(-40);
  // microphone only
  await rec.locator('select').nth(2).selectOption('none');
  await rec.getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(1200);
  await rec.getByRole('button', { name: 'Stop' }).click();
  await expect(rec.locator('.rec-take')).toHaveCount(1, { timeout: 15000 });
  const take1 = await state((s) => s.samples.find((x) => /^Take 1/.test(x.name)));
  expect(take1.duration).toBeGreaterThan(0.9);
  expect(take1.duration).toBeLessThan(1.8);
  const folders = await state((s) => s.sampleFolders.map((f) => f.name));
  expect(folders).toContain('Recordings');
  expect(take1.folderId).toBe(await state((s) => s.sampleFolders.find((f) => f.name === 'Recordings').id));
  // the focus stays in the recorder after saving (the Stop button isn't disabled), and a click on a blank part keeps
  // Space away from the studio's transport
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="recorder"]'))).toBe(true);
  await rec.locator('.rec-takes .br-cat').click();
  await page.keyboard.press(' ');
  await page.waitForTimeout(200);
  expect(await state((s) => s.playing)).toBe(false);
  // over the song from bar 3, no count-in: the clip lands at bar 3 on a free track
  await state((s) => { s.setMode('song'); s.setSongStart(2 * 384); });
  await rec.locator('select').nth(2).selectOption('song');
  await rec.locator('.rec-row.checks select').selectOption('0');
  const clipsBefore = await state((s) => s.project.playlist.clips.length);
  await rec.getByRole('button', { name: 'Record' }).click();
  await expect.poll(() => state((s) => s.playing)).toBe(true);
  await page.waitForTimeout(1500);
  await rec.getByRole('button', { name: 'Stop' }).click();
  await expect(rec.locator('.rec-take')).toHaveCount(2, { timeout: 15000 });
  await expect(rec.locator('.rec-take').first()).toContainText('track');
  expect(await state((s) => s.playing)).toBe(false);
  const clip = await state((s) => s.project.playlist.clips.at(-1));
  expect(await state((s) => s.project.playlist.clips.length)).toBe(clipsBefore + 1);
  expect(clip.kind).toBe('audio');
  expect(clip.start).toBe(2 * 384);
  const take2 = await state((s, id) => s.samples.find((x) => x.id === id), clip.refId);
  expect(take2.name).toMatch(/^Take 2 \(bar 3\)/);
  // "Tune" opens the take in the Pitch tab
  await rec.locator('.rec-take').first().getByRole('button', { name: 'Tune' }).click();
  await expect(page.locator('.we-tabs').getByRole('tab', { name: 'Pitch' })).toHaveAttribute('aria-selected', 'true');
  await page.locator('[data-window="waveEditor"] .wbtn.close').click();
  await page.locator('[data-window="recorder"] .wbtn.close').click();
});

test('Claude edits a sample with edit_sample: trim + normalise as new, pitch_correct, replace', async () => {
  const vox = await sampleByName('Vocal Take');
  const r = await claude.call('edit_sample', { sampleId: vox.id, ops: [{ op: 'trim', start: 0, end: 0.5 }, { op: 'normalize', peakDb: -3 }], name: 'Vocal Intro', folder: 'Drums' });
  expect(r).toMatch(/Saved "Vocal Intro" \[smp_\w+\] \(0\.5\d* s, mono\) — the original "Vocal Take" is unchanged/);
  const intro = await sampleByName('Vocal Intro');
  expect(intro.folderId).toBe(await state((s) => s.sampleFolders.find((f) => f.name === 'Drums').id));
  const tuned = await claude.call('edit_sample', { sampleId: vox.id, ops: [{ op: 'pitch_correct', key: 'C', scale: 'major', speed: 0, flatten: 1 }] });
  expect(tuned).toMatch(/pitch_correct: 3 notes tuned to C major \(largest move 0\.\d\d semitones\)/);
  await expect(claude.call('edit_sample', { sampleId: vox.id, ops: [{ op: 'pitch_correct', scale: 'bogus' }] })).rejects.toThrow(/Unknown scale/);
  await expect(claude.call('edit_sample', { sampleId: vox.id, ops: [{ op: 'trim', start: 9 }] })).rejects.toThrow(/past the end/);
  const rep = await claude.call('edit_sample', { sampleId: intro.id, ops: [{ op: 'reverse' }], saveAs: 'replace' });
  expect(rep).toMatch(/Replaced the audio of "Vocal Intro"/);
  await expect.poll(() => sampleByName('Vocal Intro').then((s) => s.rev)).toBe(2);
});

test('no uncaught errors in the browser', async () => {
  expect(errors.filter((e) => !/favicon|Failed to load resource/.test(e))).toEqual([]);
});
