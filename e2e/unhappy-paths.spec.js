// Edge cases in the browser: dialogs, drag & drop, deleted projects, touch layout.
// Runs after studio.spec.js (alphabetical), so the admin account already exists.
import { test, expect } from '@playwright/test';
import { ADMIN, makeWav, menuItem } from './helpers.js';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
const errors = [];

async function signIn(p) {
  await p.goto('/');
  const status = await (await p.request.get('/api/auth/status')).json();
  if (status.setupRequired) {
    await p.request.post('/api/auth/setup', { data: ADMIN });
  } else if (!status.user) {
    await p.request.post('/api/auth/login', { data: { username: ADMIN.username, password: ADMIN.password } });
  }
  await p.goto('/');
  await expect(p.locator('.toolbar')).toBeVisible();
  await p.waitForFunction(() => window.greanteadawy?.store.getState().project);
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
});
test.afterAll(async () => page?.close());

test('Enter on a focused Cancel button cancels a destructive dialog', async () => {
  const before = await page.locator('.ch-row').count();
  const row = page.locator('.ch-row').first();
  await row.locator('.ch-name').click({ button: 'right' });
  await menuItem(page, 'Delete');
  const modal = page.locator('.modal');
  if (await modal.isVisible().catch(() => false)) {
    await modal.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Enter');
    await expect(modal).toBeHidden();
    await expect(page.locator('.ch-row')).toHaveCount(before);
  } else {
    // channel deletion is undoable and has no dialog: restore it and use a dialog that exists
    await page.keyboard.press('Control+z');
    await expect(page.locator('.ch-row')).toHaveCount(before);
  }
  // project delete always confirms
  await page.getByRole('tab', { name: 'Projects' }).click();
  await page.locator('.br-new .btn.primary').click();
  await page.locator('.modal input').fill('Throwaway');
  await page.locator('.modal input').press('Enter'); // Enter in the text field confirms
  await expect(page).toHaveTitle(/Throwaway/);
  const item = page.locator('.br-item.project', { hasText: 'Throwaway' });
  await item.click({ button: 'right' });
  await menuItem(page, 'Delete');
  await page.locator('.modal').getByRole('button', { name: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.modal')).toBeHidden();
  await expect(item).toBeVisible();
});

test('dragging an instrument from the browser onto the channel rack adds a channel', async () => {
  await page.getByRole('tab', { name: 'Sounds' }).click();
  const before = await page.locator('.ch-row').count();
  const source = page.locator('.br-item', { hasText: 'Cowbell' }).first();
  await source.dragTo(page.locator('.channel-rack'));
  await expect(page.locator('.ch-row')).toHaveCount(before + 1);
});

test('the open project deleted elsewhere: the studio moves to another project', async () => {
  const current = await page.evaluate(() => window.greanteadawy.store.getState().project.id);
  const res = await page.request.delete(`/api/projects/${current}`);
  expect(res.status()).toBe(200);
  await expect.poll(() => page.evaluate(() => window.greanteadawy.store.getState().project?.id)).not.toBe(current);
  // and after a reload it doesn't hang on "Loading project…"
  await page.reload();
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.locator('.splash')).toHaveCount(0);
});

test('phone layout: the toolbar never makes the page scroll sideways (narrow phones, fractional tempo)', async ({ browser }) => {
  for (const width of [360, 375, 393]) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
    const phone = await ctx.newPage();
    await signIn(phone);
    for (const bpm of [120, 128.5]) {
      await phone.evaluate((v) => window.greanteadawy.store.getState().dispatch([{ type: 'project/update', patch: { bpm: v } }]), bpm);
      await expect.poll(() => phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: `${width} px at ${bpm} BPM` }).toBeLessThanOrEqual(0);
    }
    await ctx.close();
  }
});

test('phone layout: one-finger drag scrolls the piano roll instead of drawing', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  await signIn(phone);
  // nothing makes the page scroll sideways (the toolbar fits a 390 px screen)
  await expect(phone.locator('.toolbar')).toBeVisible();
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await phone.locator('.tabbar button', { hasText: 'Piano' }).click();
  const grid = phone.locator('.pr-grid');
  await expect(grid).toBeVisible();
  const count = () => phone.evaluate(() => {
    const s = window.greanteadawy.store.getState();
    const pt = s.project.patterns.find((p) => p.id === s.selectedPatternId);
    return Object.values(pt.notes).reduce((n, l) => n + l.length, 0);
  });
  const notesBefore = await count();
  const box = await grid.boundingBox();
  const scroller = phone.locator('.pr-scroll');
  const top0 = await scroller.evaluate((el) => el.scrollTop);
  // synthesize a touch drag with pointer events
  await grid.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: box.x + 60, clientY: box.y + 200, button: 0, isPrimary: true });
  for (let i = 1; i <= 6; i++) await grid.dispatchEvent('pointermove', { pointerId: 7, pointerType: 'touch', clientX: box.x + 60, clientY: box.y + 200 - i * 30, isPrimary: true });
  await grid.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', clientX: box.x + 60, clientY: box.y + 20, isPrimary: true });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(top0);
  expect(await count()).toBe(notesBefore);
  // a tap draws
  await grid.dispatchEvent('pointerdown', { pointerId: 8, pointerType: 'touch', clientX: box.x + 80, clientY: box.y + 150, button: 0, isPrimary: true });
  await grid.dispatchEvent('pointerup', { pointerId: 8, pointerType: 'touch', clientX: box.x + 80, clientY: box.y + 150, isPrimary: true });
  await expect.poll(count).toBe(notesBefore + 1);
  await ctx.close();
});

test('knobs are keyboard accessible sliders', async () => {
  await page.keyboard.press('F9');
  const knob = page.locator('[data-window="mixer"] [role="slider"]').first();
  await expect(knob).toBeVisible();
  await knob.focus();
  const v0 = Number(await knob.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => Number(await knob.getAttribute('aria-valuenow'))).not.toBe(v0);
});

test('nested submenus work: add a channel preset from + Channel', async () => {
  await page.keyboard.press('F6');
  const rack = page.locator('[data-window="channelRack"]');
  await expect(rack).toBeVisible();
  const before = await page.locator('.ch-row').count();
  await rack.locator('.add-channel').click();
  // collection → instrument → preset
  await page.locator('.context-menu .cm-item', { hasText: 'Drums' }).first().hover();
  const sub = page.locator('.cm-sub').first();
  await expect(sub).toBeVisible();
  await sub.locator('.cm-item', { hasText: 'Kick' }).first().hover(); // moving into the submenu keeps it open
  const presets = sub.locator('.cm-sub').first();
  await expect(presets).toBeVisible();
  await presets.locator('.cm-item').nth(1).hover();
  await presets.locator('.cm-item').nth(1).click();
  await expect(page.locator('.ch-row')).toHaveCount(before + 1);
});

test('submenus stay on screen near the edges; Space in a menu activates the item, not playback', async () => {
  const vp = page.viewportSize();
  const long = Array.from({ length: 40 }, (_, i) => ({ label: `Item ${i + 1}` }));
  await page.evaluate(({ x, y, long }) => {
    window.__picked = null;
    const items = [
      { label: 'Plain', onClick: () => { window.__picked = 'plain'; } },
      { label: 'Long submenu', submenu: long }
    ];
    window.greanteadawy.store.getState().showContextMenu({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} }, items);
  }, { x: vp.width - 10, y: vp.height - 10, long });
  await page.locator('.context-menu .cm-item', { hasText: 'Long submenu' }).hover();
  const sub = page.locator('.cm-sub');
  await expect(sub).toBeVisible();
  const box = await sub.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  await page.keyboard.press('Escape');
  await expect(page.locator('.context-menu')).toHaveCount(0);

  await page.evaluate(() => {
    window.greanteadawy.store.getState().showContextMenu({ clientX: 200, clientY: 200, preventDefault() {}, stopPropagation() {} },
      [{ label: 'Plain', onClick: () => { window.__picked = 'plain'; } }]);
  });
  await expect(page.locator('.context-menu .cm-item').first()).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('.context-menu')).toHaveCount(0);
  expect(await page.evaluate(() => window.__picked)).toBe('plain');
  expect(await page.evaluate(() => window.greanteadawy.store.getState().playing)).toBe(false);
});

test('each click is its own undo step', async () => {
  await page.keyboard.press('F7');
  const grid = page.locator('[data-window="pianoRoll"] .pr-grid');
  await expect(grid).toBeVisible();
  const count = () => page.evaluate(() => {
    const s = window.greanteadawy.store.getState();
    const pt = s.project.patterns.find((p) => p.id === s.selectedPatternId);
    return (pt.notes[s.pianoRollChannelId] || []).length;
  });
  const n0 = await count();
  // the grid is scrolled inside its window: click within the visible part
  const view = await page.locator('[data-window="pianoRoll"] .pr-scroll').boundingBox();
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(view.x + 120 + i * 60, view.y + 60);
    await page.waitForTimeout(120);
  }
  await expect.poll(count).toBe(n0 + 3);
  await page.keyboard.press('Control+z');
  await expect.poll(count).toBe(n0 + 2);
});

test('prompts start with their text selected; Escape cancels from anywhere', async () => {
  await page.locator('.tbtn.logo').click();
  await page.locator('.context-menu .cm-item', { hasText: 'Rename project' }).click();
  const input = page.locator('.modal input');
  await expect(input).toBeFocused();
  const sel = await input.evaluate((el) => [el.selectionStart, el.selectionEnd, el.value.length]);
  expect(sel[0]).toBe(0);
  expect(sel[1]).toBe(sel[2]);
  await page.locator('.modal h3').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal')).toHaveCount(0);
});

test('a sampler channel made from a one-shot uses its detected pitch', async () => {
  await page.getByRole('tab', { name: 'Samples' }).click();
  await page.getByTestId('sample-file-input').setInputFiles({ name: 'tone-a3.wav', mimeType: 'audio/wav', buffer: makeWav({ freq: 220, seconds: 0.5 }) });
  const row = page.locator('.br-item.sample', { hasText: 'tone-a3' });
  await expect(row).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.greanteadawy.store.getState().samples.find((s) => s.name === 'tone-a3')?.analysis?.pitch?.midi)).toBe(57);
  await row.locator('.br-add[title="Add as sampler channel"]').click();
  await expect.poll(() => page.evaluate(() => window.greanteadawy.store.getState().project.channels.find((c) => c.name === 'tone-a3')?.instrument.params.rootKey)).toBe(57);
});

/** Bounding box of a locator, rounded (layout comparisons). */
async function box(loc) {
  const b = await loc.boundingBox();
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
}

test('selecting a playlist clip or a long note keeps its size (the select tool, then double-click to edit)', async () => {
  await page.getByRole('tab', { name: 'Projects' }).click();
  await page.locator('.br-new .btn.primary').click();
  await page.locator('.modal input').fill('Selection Sizes');
  await page.locator('.modal input').press('Enter');
  await expect(page).toHaveTitle(/Selection Sizes/);
  const ids = await page.evaluate(() => {
    const s = window.greanteadawy.store.getState();
    const p = s.project;
    const pat = p.patterns[0];
    const ch = p.channels.find((c) => c.kind !== 'sampler') || p.channels[0];
    s.dispatch([
      { type: 'clip/remove', ids: p.playlist.clips.map((c) => c.id) },
      { type: 'clip/add', clips: [{ id: 'clip_size_test', kind: 'pattern', refId: pat.id, track: 0, start: 0, length: 1536, offset: 0, mute: false }] },
      { type: 'notes/set', patternId: pat.id, channelId: ch.id, notes: [{ id: 'note_size_test', key: 60, start: 0, length: 384, velocity: 0.8 }] }
    ]);
    // a known layout: the playlist alone, wide enough for a 4-bar clip
    const windows = { ...s.windows };
    for (const k of Object.keys(windows)) windows[k] = { ...windows[k], open: false, max: false };
    windows.playlist = { ...windows.playlist, open: true, x: 10, y: 10, w: 900, h: 360, z: 50 };
    window.greanteadawy.store.setState({ windows, zTop: 50 });
    return { pat: pat.id, ch: ch.id };
  });
  const pl = page.locator('[data-window="playlist"]');
  await pl.getByRole('button', { name: /^Select \(box\)/ }).click();
  const clip = pl.locator('.clip').first();
  const before = await box(clip);
  expect(before.w).toBeGreaterThan(250); // 4 bars at the default zoom
  await page.mouse.click(before.x + before.w / 2, before.y + before.h / 2);
  await expect(clip).toHaveClass(/\bsel\b/);
  expect(await box(clip)).toEqual(before); // was capped at 180 px by the dropdown's .sel style
  // double-click: the pattern opens in the channel rack, the clip stays as it was
  await page.mouse.dblclick(before.x + before.w / 2, before.y + before.h / 2);
  await expect(page.locator('[data-window="channelRack"]')).toBeVisible();
  expect(await page.evaluate(() => window.greanteadawy.store.getState().selectedPatternId)).toBe(ids.pat);
  expect(await box(clip)).toEqual(before);
  expect(await page.evaluate(() => window.greanteadawy.store.getState().project.playlist.clips.map((c) => c.length))).toEqual([1536]);

  // a one-bar note in the piano roll (384 px wide at the default zoom) keeps its width when selected
  await page.evaluate(({ ch }) => window.greanteadawy.store.getState().openPianoRoll(ch), ids);
  const note = page.locator('[data-window="pianoRoll"] .pr-note').first();
  await expect(note).toBeVisible();
  const nb = await box(note);
  expect(nb.w).toBeGreaterThan(300);
  await page.mouse.click(nb.x + 30, nb.y + nb.h / 2);
  await expect(note).toHaveClass(/\bsel\b/);
  expect(await box(note)).toEqual(nb);
  // nothing marked as selected picks up control sizing
  const leaks = await page.evaluate(() => [...document.querySelectorAll('.sel')].filter((el) => getComputedStyle(el).maxWidth !== 'none').map((el) => el.className));
  expect(leaks).toEqual([]);
});

test('windows move by the empty middle of their title bar; title-bar controls keep working', async () => {
  await page.evaluate(() => {
    const s = window.greanteadawy.store;
    const st = s.getState();
    s.setState({ windows: { ...st.windows, channelRack: { ...st.windows.channelRack, open: true, max: false, x: 60, y: 60, w: 900, h: 340, z: 60 } }, zTop: 60 });
  });
  const rack = page.locator('[data-window="channelRack"]');
  const tb = rack.locator('.window-toolbar');
  const tbBox = await box(tb);
  const lastRight = await tb.evaluate((el) => Math.max(...[...el.children].map((c) => c.getBoundingClientRect().right)));
  expect(tbBox.x + tbBox.w - lastRight).toBeGreaterThan(60); // there is empty space to grab
  const grabX = Math.round((lastRight + tbBox.x + tbBox.w) / 2);
  const grabY = tbBox.y + tbBox.h / 2;
  const before = await box(rack);
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 50, grabY + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => { const b = await box(rack); return [b.x - before.x, b.y - before.y]; }).toEqual([50, 40]);

  // dragging the Steps number changes the steps and leaves the window where it is
  const moved = await box(rack);
  const steps = rack.locator('.steps-num');
  const s0 = Number(await steps.innerText());
  const sb = await box(steps);
  await page.mouse.move(sb.x + sb.w / 2, sb.y + sb.h / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.w / 2, sb.y + sb.h / 2 - 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await steps.innerText())).toBeGreaterThan(s0);
  expect(await box(rack)).toEqual(moved);
  // and the keyboard works on it too
  const s1 = Number(await steps.innerText());
  await steps.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => Number(await steps.innerText())).toBe(s1 - 1);
  // a toolbar button still clicks without moving the window (the playlist's tools)
  await page.evaluate(() => window.greanteadawy.store.getState().openWindow('playlist'));
  const pl = page.locator('[data-window="playlist"]');
  const plBefore = await box(pl);
  await pl.getByRole('button', { name: /^Erase/ }).click();
  await expect(pl.getByRole('button', { name: /^Erase/ })).toHaveClass(/active/);
  expect(await box(pl)).toEqual(plBefore);
  await pl.getByRole('button', { name: /^Draw/ }).click();
});

test('no uncaught page errors', async () => {
  expect(errors).toEqual([]);
});
