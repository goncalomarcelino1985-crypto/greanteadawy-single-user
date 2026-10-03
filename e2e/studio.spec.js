// Full user journey: first-run setup → studio → Claude (MCP) edits live → render in the browser →
// samples with metadata → versions → API token lifecycle → users & sign-out.
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { ADMIN, connectMcp, makeWav, menuItem } from './helpers.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../client/package.json', import.meta.url), 'utf8')).version;

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
const pageErrors = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
});

test.afterAll(async () => {
  await page?.close();
});

const settings = () => page.locator('[data-window="settings"]');
const openSettings = async (tab) => {
  await page.locator('.avatar').click();
  await menuItem(page, tab === 'api' ? 'API token & MCP' : tab === 'users' ? 'Manage users' : 'Account settings');
  await expect(settings()).toBeVisible();
};

test('first run: create the admin account and land in the welcome project', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /create the admin account/i })).toBeVisible();
  const inputs = page.locator('.auth-field input');
  await inputs.nth(0).fill(ADMIN.displayName);
  await inputs.nth(1).fill(ADMIN.username);
  await page.locator('input[type=password]').nth(0).fill(ADMIN.password);
  await page.locator('input[type=password]').nth(1).fill('mismatch-123');
  await page.getByRole('button', { name: /create admin/i }).click();
  await expect(page.getByRole('alert')).toHaveText(/do not match/i);

  await page.locator('input[type=password]').nth(1).fill(ADMIN.password);
  await page.getByRole('button', { name: /create admin/i }).click();
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page).toHaveTitle(/Welcome Trap Beat/);
  await expect(page.locator('.ch-row').first()).toBeVisible();
  await expect(page.locator('.conn.ok')).toBeVisible();
});

test('transport plays and stops', async () => {
  const time = page.locator('.time-main');
  const before = await time.textContent();
  await page.locator('.tbtn.play').click();
  await expect(time).not.toHaveText(before, { timeout: 5000 });
  await page.locator('.tbtn[title="Stop"]').click();
  await expect(page.locator('.tbtn.play.active')).toHaveCount(0);
});

test('Claude (MCP, no token on loopback) edits the open project live', async ({ baseURL }) => {
  const claude = await connectMcp(baseURL);
  try {
    expect(await claude.call('get_studio_status')).toMatch(/Welcome Trap Beat/);
    await claude.call('add_channel', { name: 'E2E Lead', instrument: 'synth' });
    await expect(page.locator('.ch-name', { hasText: 'E2E Lead' })).toBeVisible();
    await claude.call('create_pattern', { name: 'E2E Hook', bars: 1 });
    await claude.call('write_melody', { pattern: 'E2E Hook', channel: 'E2E Lead', melody: 'C5:2 Eb5:2 G5:4 -:2 Bb5:6' });
    const pat = await claude.call('get_pattern', { pattern: 'E2E Hook' });
    expect(pat).toMatch(/E2E Lead/);
    await expect(page.locator('.claude-indicator')).toBeVisible();
  } finally {
    await claude.close();
  }
});

test('render_mix renders and analyses in this browser tab', async ({ baseURL }) => {
  const claude = await connectMcp(baseURL);
  try {
    const report = await claude.call('render_mix', { mode: 'pattern', loops: 1, stems: true, save: true });
    expect(report).toMatch(/LUFS/);
    expect(report).toMatch(/peak/i);
    expect(report).toMatch(/\/api\/exports\//);
  } finally {
    await claude.close();
  }
  // the saved render shows up under Projects → Exports
  await page.getByRole('tab', { name: 'Projects' }).click();
  await expect(page.locator('.br-item a[download]').first()).toBeVisible();
});

test('uploaded samples show technical metadata, and Claude can read it', async ({ baseURL }) => {
  await page.getByRole('tab', { name: 'Samples' }).click();
  await page.getByTestId('sample-file-input').setInputFiles({ name: 'e2e-tone.wav', mimeType: 'audio/wav', buffer: makeWav({ freq: 220 }) });
  const row = page.locator('.br-item.sample', { hasText: 'e2e-tone' });
  await expect(row).toBeVisible();
  await row.locator('.br-add.info').click();
  const details = page.locator('.sample-details');
  await expect(details).toContainText('44.1 kHz');
  await expect(details).toContainText('16-bit');
  await expect(details).toContainText('LUFS');

  const claude = await connectMcp(baseURL);
  try {
    const list = await claude.call('list_samples');
    const id = list.match(/\[(smp_[\w-]+)\]/)?.[1] || list.match(/(smp_[\w-]+)/)?.[1];
    expect(id, list).toBeTruthy();
    const info = await claude.call('get_sample_info', { sampleId: id });
    expect(info).toMatch(/44100|44\.1/);
    expect(info).toMatch(/16-bit|16 bit|bitsPerSample/i);
    expect(info).toMatch(/A3|220/);
  } finally {
    await claude.close();
  }
});

test('versions: save from the UI and restore', async () => {
  await page.locator('.tbtn.logo').click();
  await menuItem(page, 'Versions');
  const win = page.locator('[data-window="versions"]');
  await expect(win).toBeVisible();
  await win.getByRole('button', { name: /save version/i }).click();
  await page.locator('.modal input').fill('E2E checkpoint');
  await page.locator('.modal .btn.primary').click();
  await expect(win.locator('.version-row', { hasText: 'E2E checkpoint' })).toBeVisible();

  // change something, then restore the snapshot
  const lead = page.locator('.ch-row', { hasText: 'E2E Lead' });
  await expect(lead).toBeVisible();
  await lead.locator('.ch-name').click({ button: 'right' });
  await menuItem(page, 'Delete');
  if (await page.locator('.modal').isVisible()) await page.locator('.modal .btn.danger, .modal .btn.primary').last().click();
  await expect(page.locator('.ch-name', { hasText: 'E2E Lead' })).toHaveCount(0);

  await win.locator('.version-row', { hasText: 'E2E checkpoint' }).getByRole('button', { name: 'Restore' }).click();
  await page.locator('.modal .btn.primary').click();
  await expect(page.locator('.ch-name', { hasText: 'E2E Lead' })).toBeVisible();
  await win.locator('.wbtn.close').click();
});

test('API token: generate, use, regenerate, delete', async ({ baseURL, request }) => {
  await openSettings('api');
  const s = settings();
  await s.getByRole('button', { name: /generate token/i }).click();
  const tokenText = await s.locator('.fresh-token pre').textContent();
  const token = tokenText.trim();
  expect(token).toMatch(/^gtd_[\w-]+_[\w-]+$/);
  // snippets include the token
  await expect(s.locator('.copy-block').filter({ hasText: 'claude mcp add' })).toContainText(token);

  // the token works for the REST API and MCP
  expect((await request.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).status()).toBe(200);
  const claude = await connectMcp(baseURL, token);
  expect(await claude.call('get_studio_status')).toMatch(/Pat Producer|producer/);
  await claude.close();

  // regenerate: old token stops working
  await s.getByRole('button', { name: /regenerate/i }).click();
  await page.locator('.modal .btn.danger').click();
  await expect(s.locator('.fresh-token pre')).not.toHaveText(token);
  const token2 = (await s.locator('.fresh-token pre').textContent()).trim();
  expect((await request.get('/api/me', { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
  expect((await request.get('/api/me', { headers: { authorization: `Bearer ${token2}` } })).status()).toBe(200);

  // delete
  await s.getByRole('button', { name: /^delete$/i }).click();
  await page.locator('.modal .btn.danger').click();
  await expect(s.getByRole('button', { name: /generate token/i })).toBeVisible();
  expect((await request.get('/api/me', { headers: { authorization: `Bearer ${token2}` } })).status()).toBe(401);
});

test('admin: require tokens for MCP, then token-less MCP is refused', async ({ baseURL }) => {
  const s = settings();
  await s.getByRole('tab', { name: /server/i }).click();
  const toggle = s.locator('.pref', { hasText: /without a token/i }).locator('.toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(connectMcp(baseURL)).rejects.toThrow();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('admin: create a user, who signs in to an empty-but-private studio', async ({ browser }) => {
  const s = settings();
  await s.getByRole('tab', { name: /users/i }).click();
  await s.getByPlaceholder('Username').fill('beatmaker');
  await s.getByPlaceholder('Display name').fill('Bea Maker');
  await s.getByPlaceholder(/initial password/i).fill('another-pass-9');
  await s.getByRole('button', { name: /create user/i }).click();
  await expect(s.locator('.users-table')).toContainText('@beatmaker');

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.goto('/');
  await p2.locator('.auth-field input').nth(0).fill('beatmaker');
  await p2.locator('input[type=password]').fill('another-pass-9');
  await p2.getByRole('button', { name: /sign in/i }).click();
  await expect(p2.locator('.toolbar')).toBeVisible();
  // their own welcome project, not the admin's samples
  await p2.getByRole('tab', { name: 'Samples' }).click();
  await expect(p2.locator('.br-item.sample')).toHaveCount(0);
  await ctx.close();
});

test('About: the top-right button opens a dialog with the app name and version; Escape, Close and the menu work', async () => {
  const button = page.getByTestId('about-button');
  await expect(button).toBeVisible();
  // top right: after the window buttons, next to the account avatar
  const [b, avatar, vp] = [await button.boundingBox(), await page.locator('.avatar').boundingBox(), page.viewportSize()];
  expect(b.x).toBeGreaterThan(vp.width * 0.7);
  expect(b.y).toBeLessThan(40);
  expect(Math.abs(avatar.x - (b.x + b.width))).toBeLessThan(16);
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'About GreanTeaDawy' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('about-version')).toHaveText(`Version ${VERSION}`);
  await expect(dialog.getByTestId('about-server')).toHaveText(`GreanTeaDawy ${VERSION}`); // the server's own version
  await expect(dialog).toContainText(/\d+ instruments in \d+ collections/);
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  // studio shortcuts don't fire while it is open (focus off the buttons, so Space can't just press Close)
  await dialog.locator('.about-tagline').click();
  await page.keyboard.press('Space');
  await page.keyboard.press('F9');
  expect(await page.evaluate(() => window.greanteadawy.store.getState().playing)).toBe(false);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused(); // focus goes back to the ⓘ button
  // from the main menu, closed with the Close button
  await page.locator('.tbtn.logo').click();
  await menuItem(page, 'About GreanTeaDawy');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  // "Shortcuts & help" closes it and opens the help window
  await button.click();
  await dialog.getByRole('button', { name: /Shortcuts & help/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('[data-window="help"]')).toBeVisible();
  await page.evaluate(() => window.greanteadawy.store.getState().closeWindow('help'));
  // one dialog at a time: opening About over a confirm answers the confirm with "cancel" instead of leaving it hanging
  expect(await page.evaluate(async () => {
    const st = window.greanteadawy.store.getState();
    const pending = st.confirm({ title: 'Delete everything?' });
    st.showAbout();
    return pending;
  })).toBe(false);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('sign out returns to the login screen; wrong password is rejected; sign in again', async () => {
  await page.locator('.avatar').click();
  await menuItem(page, 'Sign out');
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  await page.locator('.auth-field input').nth(0).fill(ADMIN.username);
  await page.locator('input[type=password]').fill('wrong-password');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.locator('input[type=password]').fill(ADMIN.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.locator('.ch-name', { hasText: 'E2E Lead' })).toBeVisible();
});

test('no uncaught errors in the browser', async () => {
  // 401s while signed out are expected network noise; anything else is a bug
  const real = pageErrors.filter((e) => !/401|Unauthorized|status of 4\d\d/.test(e));
  expect(real).toEqual([]);
});
