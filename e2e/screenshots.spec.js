// Regenerates the README screenshots in docs/screenshots/. Skipped during normal test runs.
//   npm run screenshots
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { packPlugin } from '../scripts/pack-plugin.mjs';
import { ADMIN, connectMcp, makeWav, menuItem, voiceWav } from './helpers.js';

const OUT = 'docs/screenshots';
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 (npm run screenshots) to regenerate README images');
test.describe.configure({ mode: 'serial' });
test.use({
  viewport: { width: 1600, height: 940 },
  deviceScaleFactor: 1,
  // the recorder screenshot records from Chromium's fake microphone
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }
});

/** Lay out the studio windows (x, y, w, h) and close the rest. */
async function layout(page, wins, extra = {}) {
  await page.evaluate(({ wins, extra }) => {
    const s = window.greanteadawy.store;
    const st = s.getState();
    const windows = { ...st.windows };
    for (const k of Object.keys(windows)) windows[k] = { ...windows[k], open: false, max: false };
    let z = 1;
    for (const [k, [x, y, w, h]] of Object.entries(wins)) windows[k] = { ...windows[k], open: true, x, y, w, h, z: z++, max: false };
    s.setState({ windows, zTop: z, ...extra });
  }, { wins, extra });
  await page.waitForTimeout(350);
}

test('README screenshots', async ({ browser, baseURL }) => {
  fs.mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage();

  // 1. first-run setup screen
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /create the admin account/i })).toBeVisible();
  const inputs = page.locator('.auth-field input');
  await inputs.nth(0).fill(ADMIN.displayName);
  await inputs.nth(1).fill(ADMIN.username);
  await page.screenshot({ path: `${OUT}/setup.png` });
  await page.locator('input[type=password]').nth(0).fill(ADMIN.password);
  await page.locator('input[type=password]').nth(1).fill(ADMIN.password);
  await page.getByRole('button', { name: /create admin/i }).click();
  await expect(page.locator('.toolbar')).toBeVisible();
  await page.waitForFunction(() => window.greanteadawy?.store.getState().project);

  // Claude adds a sample-based layer and a melody, so the activity log has content
  await page.getByRole('tab', { name: 'Samples' }).click();
  await page.getByTestId('sample-file-input').setInputFiles([
    { name: 'Vinyl Pluck C4.wav', mimeType: 'audio/wav', buffer: makeWav({ freq: 261.63, seconds: 0.9 }) },
    { name: 'Sub Hit A1.wav', mimeType: 'audio/wav', buffer: makeWav({ freq: 55, seconds: 1.1, channels: 1 }) }
  ]);
  await expect(page.locator('.br-item.sample')).toHaveCount(2);
  const claude = await connectMcp(baseURL);
  await claude.call('get_studio_status');
  await claude.call('list_samples');
  await claude.call('set_mixer', { insert: 1, volumeDb: -1.5 });
  await claude.call('save_version', { name: 'Before mixdown' });
  await claude.call('render_mix', { stems: true });
  await claude.close();

  // 2. hero: playlist + channel rack + piano roll, playing in song mode
  const ids = await page.evaluate(() => {
    const p = window.greanteadawy.store.getState().project;
    return { hat: p.channels.find((c) => c.name === 'Hat')?.id, drums: p.patterns.find((x) => x.name === 'Drums')?.id };
  });
  await layout(page, {
    playlist: [8, 8, 1310, 370],
    channelRack: [8, 388, 800, 300],
    pianoRoll: [818, 388, 500, 470]
  }, { pianoRollChannelId: ids.hat, selectedChannelId: ids.hat, selectedPatternId: ids.drums });
  await page.mouse.click(1590, 930);
  await page.evaluate(() => window.greanteadawy.store.getState().play({ mode: 'song', position: 384 * 6 }));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/studio.png` });

  // 3. mixer
  await layout(page, { playlist: [8, 8, 1310, 300], mixer: [8, 318, 1310, 440] }, { selectedInsert: 2 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/mixer.png` });
  await page.evaluate(() => window.greanteadawy.store.getState().stop());

  // 3b. spatial: Claude places a few objects, the Spatial window next to the mixer
  const claude3d = await connectMcp(baseURL);
  const chNames = await page.evaluate(() => window.greanteadawy.store.getState().project.channels.map((c) => c.name));
  const spots = [['Hat', 'rear-left'], ['Open Hat', 'rear-right'], ['Pad', 'overhead'], ['Bell', 'top-front-right'], ['Clap', 'wide-left']];
  await claude3d.call('set_spatial', { enabled: true, monitor: 'binaural' });
  for (const [name, position] of spots) if (chNames.includes(name)) await claude3d.call('place_object', { insert: name, position });
  await claude3d.close();
  await layout(page, { mixer: [8, 8, 700, 600], spatial: [716, 8, 650, 600] }, { selectedInsert: 6 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/spatial.png` });

  // 4. piano roll on the melody
  const lead = await page.evaluate(() => {
    const p = window.greanteadawy.store.getState().project;
    const pat = p.patterns.find((x) => x.name === 'Melody') || p.patterns.at(-1);
    const chId = Object.keys(pat.notes).find((k) => pat.notes[k].length) || p.channels.at(-1).id;
    return { pat: pat.id, ch: chId };
  });
  await layout(page, { pianoRoll: [8, 8, 1310, 640] }, { pianoRollChannelId: lead.ch, selectedChannelId: lead.ch, selectedPatternId: lead.pat });
  await page.screenshot({ path: `${OUT}/piano-roll.png` });

  // 5. the sample library in folders, sample details (metadata + analysis) and Claude activity
  const folder = async (name) => (await (await page.request.post('/api/samples/folders', { data: { name } })).json()).id;
  const lib = async (name, buffer, folderId) => {
    const r = await page.request.post('/api/samples', { multipart: { file: { name: `${name}.wav`, mimeType: 'audio/wav', buffer }, ...(folderId ? { folderId } : {}) } });
    return (await r.json()).id;
  };
  const [drumsF, keysF, vocalsF] = [await folder('Drums'), await folder('Keys'), await folder('Vocals')];
  await folder('Loops');
  await lib('Kick Dusty', makeWav({ freq: 52, seconds: 0.5, channels: 1 }), drumsF);
  await lib('Snare Vinyl', makeWav({ freq: 190, seconds: 0.3, channels: 1 }), drumsF);
  await lib('Hat Closed', makeWav({ freq: 2800, seconds: 0.12, channels: 1 }), drumsF);
  const vinyl = await page.evaluate(() => window.greanteadawy.store.getState().samples.find((x) => x.name === 'Vinyl Pluck C4').id);
  await page.request.post('/api/samples/move', { data: { ids: [vinyl], folderId: keysF } });
  // a sung phrase, a little out of tune (A minor), for the editor and pitch correction
  const sung = (hz, cents) => hz * Math.pow(2, cents / 1200);
  const hook = await lib('Hook Take 3', voiceWav([
    { hz: 0, dur: 0.15 }, { hz: sung(440, 28), dur: 0.42, vib: 0.25 }, { hz: 0, dur: 0.06 }, { hz: sung(523.25, -15), dur: 0.38, vib: 0.2 },
    { hz: sung(493.88, 18), dur: 0.36 }, { hz: 0, dur: 0.08 }, { hz: sung(440, -22), dur: 0.7, vib: 0.35 }, { hz: 0, dur: 0.1 },
    { hz: sung(392, 40), dur: 0.32 }, { hz: sung(440, 12), dur: 0.9, vib: 0.4 }, { hz: 0, dur: 0.2 }
  ]), vocalsF);
  await expect.poll(() => page.evaluate(() => window.greanteadawy.store.getState().samples.length)).toBe(6);
  await layout(page, { playlist: [8, 8, 1310, 420], channelRack: [8, 438, 800, 300] });
  await page.getByRole('tab', { name: 'Samples' }).click();
  await page.locator('.br-item.sample', { hasText: 'Vinyl Pluck' }).locator('.br-add.info').click();
  await expect(page.locator('.sample-details')).toContainText('LUFS');
  await page.screenshot({ path: `${OUT}/samples.png` });
  await page.locator('.br-item.sample', { hasText: 'Vinyl Pluck' }).locator('.br-add.info').click();

  // 5a. the wave editor on the vocal take, a phrase selected; then its Pitch tab (auto-tune to A minor)
  await page.evaluate((id) => window.greanteadawy.store.setState({ editSampleId: id, editTab: 'wave' }), hook);
  await layout(page, { playlist: [8, 8, 1310, 300], waveEditor: [60, 120, 1180, 560] }, { editSampleId: hook, editTab: 'wave' });
  await expect(page.getByTestId('wave-info')).toContainText('3.670 s');
  const wave = await page.getByTestId('wave-canvas').boundingBox();
  await page.mouse.move(wave.x + wave.width * 0.27, wave.y + 120);
  await page.mouse.down();
  await page.mouse.move(wave.x + wave.width * 0.49, wave.y + 120, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/wave-editor.png` });
  await page.locator('.we-tabs').getByRole('tab', { name: 'Pitch' }).click();
  await expect(page.getByTestId('pitch-status')).toContainText(/\d+ notes/);
  await page.locator('.pv-controls select').first().selectOption('A');
  await page.locator('.pv-controls select').nth(1).selectOption('minor');
  await page.locator('.pv-presets').getByRole('button', { name: 'Tight' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/pitch-correction.png` });
  await page.locator('[data-window="waveEditor"] .wbtn.close').click();

  // 5b. the recorder: a take from the (fake) microphone over the song, placed on the playlist
  await page.evaluate(() => { const s = window.greanteadawy.store.getState(); s.setMode('song'); s.setSongStart(384 * 4); });
  await layout(page, { playlist: [8, 8, 880, 560], recorder: [896, 8, 450, 520] });
  const rec = page.getByTestId('recorder');
  await rec.getByRole('button', { name: 'Enable microphone' }).click();
  await expect(rec.getByRole('meter')).toBeVisible();
  await rec.locator('.rec-row.checks select').selectOption('0');
  await rec.getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(2600);
  await rec.getByRole('button', { name: 'Stop' }).click();
  await expect(rec.locator('.rec-take')).toHaveCount(1, { timeout: 15000 });
  await rec.getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/recorder.png` });
  await rec.getByRole('button', { name: 'Stop' }).click();
  await expect(rec.locator('.rec-take')).toHaveCount(2, { timeout: 15000 });
  await page.locator('[data-window="recorder"] .wbtn.close').click();
  await page.evaluate(() => window.greanteadawy.store.getState().setMode('pattern'));

  await layout(page, { playlist: [8, 8, 1310, 420], channelRack: [8, 438, 800, 300] });
  await page.getByRole('tab', { name: 'Claude' }).click();
  await page.screenshot({ path: `${OUT}/claude-activity.png` });

  // 5b. the world collections: the Indian Fusion template, the Browser on its new sections, the sitar's settings
  const claudeWorld = await connectMcp(baseURL);
  await claudeWorld.call('create_project', { name: 'Raga Sketch', template: 'indian' });
  await claudeWorld.close();
  await expect(page).toHaveTitle(/Raga Sketch/);
  const world = await page.evaluate(() => {
    const p = window.greanteadawy.store.getState().project;
    return { sitar: p.channels.find((c) => c.name === 'Sitar').id, theka: p.patterns.find((x) => x.name === 'Theka').id };
  });
  await layout(page, { playlist: [8, 8, 1310, 330], channelRack: [8, 346, 700, 470], channelSettings: [716, 346, 602, 470] }, { selectedChannelId: world.sitar, selectedPatternId: world.theka });
  await page.getByRole('tab', { name: 'Sounds' }).click();
  await page.locator('.br-cat', { hasText: 'East Asian' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/world.png` });

  // 6. settings → API token & MCP
  await page.locator('.avatar').click();
  await menuItem(page, 'API token & MCP');
  const s = page.locator('[data-window="settings"]');
  await s.getByRole('button', { name: /generate token/i }).click();
  await expect(s.locator('.fresh-token pre')).toBeVisible();
  await page.evaluate(() => {
    const st = window.greanteadawy.store.getState();
    window.greanteadawy.store.setState({ windows: { ...st.windows, settings: { ...st.windows.settings, x: 300, y: 40, w: 760, h: 760, z: 99 } }, zTop: 99 });
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/settings-api.png` });

  // 6b. settings → audio export (ffmpeg status) and → plugins (the install review with the trust warning)
  await s.getByRole('tab', { name: 'Audio export' }).click();
  await expect(page.getByTestId('ffmpeg-status')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/settings-export.png` });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtd-shots-'));
  for (const name of ['chiptune', 'kalimba', 'euclid']) {
    const zip = packPlugin(path.resolve('plugins/examples', name), tmp).out;
    const r = await page.request.post('/api/plugins/inspect', { multipart: { file: { name: path.basename(zip), mimeType: 'application/zip', buffer: fs.readFileSync(zip) } } });
    await page.request.post('/api/plugins/install', { data: { token: (await r.json()).token, trust: true } });
  }
  await s.getByRole('tab', { name: 'Plugins' }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('plugin-install').click()]);
  await chooser.setFiles(packPlugin(path.resolve('plugins/examples/tape-wobble'), tmp).out);
  await expect(page.getByTestId('plugin-review')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/settings-plugins.png` });
  await page.getByTestId('plugin-review').getByRole('button', { name: 'Cancel' }).click();
  fs.rmSync(tmp, { recursive: true, force: true });

  // 6c. the About dialog (top right)
  await page.getByTestId('about-button').click();
  await expect(page.getByRole('dialog', { name: 'About GreanTeaDawy' })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/about.png` });
  await page.keyboard.press('Escape');

  // 7. sign-in screen
  await page.locator('.avatar').click();
  await menuItem(page, 'Sign out');
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  await page.screenshot({ path: `${OUT}/login.png` });
  await page.close();

  // 8. phone
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  await phone.goto('/');
  await phone.locator('.auth-field input').nth(0).fill(ADMIN.username);
  await phone.locator('input[type=password]').fill(ADMIN.password);
  await phone.getByRole('button', { name: /sign in/i }).click();
  await expect(phone.locator('.toolbar')).toBeVisible();
  await phone.waitForTimeout(600);
  await phone.screenshot({ path: `${OUT}/mobile.png` });
  await ctx.close();
});
