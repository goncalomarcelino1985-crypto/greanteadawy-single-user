// Per-user plugin library: inspect a zip (validate everything, show the user what it asks for), install it after the
// user confirms they trust it, enable/disable/remove, and serve its parts to the studio. The server never runs plugin
// code: DSP code is served inside a worklet-only harness (audio thread: no network, DOM, storage or timers), generator
// code as plain text for the sandboxed iframe (see sandbox.js), samples as audio files. docs/plugins.md, security.md.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateManifest, PLUGIN_ID_RE, pluginProcessorName } from '@greanteadawy/core';
import { readZip, ZipError } from './zip.js';
import { httpError } from './errors.js';
import { writeFileAtomic } from './fsutil.js';

const MAX_CODE_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const PENDING_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_PER_USER = 3; // uploads waiting for the trust confirmation are held in memory: keep a few at most
const MAX_PENDING_BYTES = 192 * 1024 * 1024; // …and a server-wide budget for them (oldest dropped first)
const ALLOWED_EXT = /\.(json|js|wav|mp3|ogg|flac|md|txt|png)$/i;
const AUDIO_MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac' };

/** Magic bytes of the audio formats plugins may ship (a "sample" that isn't audio is refused). */
function looksLikeAudio(name, data) {
  const ext = name.split('.').pop().toLowerCase();
  const head = data.subarray(0, 12).toString('latin1');
  if (ext === 'wav') return head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE';
  if (ext === 'ogg') return head.startsWith('OggS');
  if (ext === 'flac') return head.startsWith('fLaC');
  if (ext === 'mp3') return head.startsWith('ID3') || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);
  return false;
}

/**
 * Static checks of plugin code. The sandboxes already deny network, storage and DOM; these refuse the constructs that
 * could load other code: `import` (static or dynamic — the only way a worklet could fetch a module) and
 * `importScripts`. Keywords can't be written with escapes, so a plain token scan is enough.
 */
export function checkPluginCode(code) {
  const problems = [];
  if (/\bimport\b/.test(code)) problems.push('uses "import" (plugins must be a single file and may not load other code)');
  if (/\bimportScripts\b/.test(code)) problems.push('uses importScripts');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000\ufeff]/.test(code.slice(1))) problems.push('contains NUL/BOM characters');
  return problems;
}

/** The trusted wrapper around a DSP plugin, as one AudioWorklet module (its processor: pluginProcessorName). */
export function workletModule(manifest, code, sha256 = '') {
  const automatable = manifest.params.filter((p) => p.type === 'number' && p.automatable)
    .map((p) => ({ name: p.key, defaultValue: p.default, minValue: p.min, maxValue: p.max }));
  return `// GreanTeaDawy plugin harness (generated) — ${manifest.id} ${manifest.version}
if (typeof AudioWorkletGlobalScope === 'undefined' || typeof registerProcessor !== 'function') {
  throw new Error('GreanTeaDawy plugin code only runs inside the audio worklet');
}
// the plugin's code, outside the harness block (it can't see the harness internals) with the processor
// registration API hidden; it gets only \`gtd\` (registerInstrument / registerEffect)
const gtdPluginMain = function (gtd, registerProcessor, AudioWorkletProcessor, globalThis, self) {
  'use strict';
  // ---- plugin code ----
${code}
  // ---- end of plugin code ----
};
{
  const reg = registerProcessor;
  const Base = AudioWorkletProcessor;
  const NAME = ${JSON.stringify(pluginProcessorName(manifest.id, sha256))};
  const KIND = ${JSON.stringify(manifest.type)};
  const PARAMS = ${JSON.stringify(automatable)};
  const MAX_TAIL = 10; // seconds a voice may ring after its note-off
  let def = null;
  const api = Object.freeze({
    registerInstrument(d) { if (KIND !== 'instrument' || def) throw new Error('registerInstrument: not an instrument plugin, or called twice'); def = d; },
    registerEffect(d) { if (KIND !== 'effect' || def) throw new Error('registerEffect: not an effect plugin, or called twice'); def = d; }
  });
  // outputs are cleaned: NaN/Infinity become silence, runaway values are clamped to ±8
  const clean = (b) => { for (let i = 0; i < b.length; i++) { const x = b[i]; if (!(x > -8 && x < 8)) b[i] = x > 0 ? 8 : x < 0 ? -8 : 0; } };
  class Harness extends Base {
    static get parameterDescriptors() {
      return [
        { name: 'gtdGate', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' }, // note-off: < 0.5
        { name: 'gtdKill', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }, // hard stop: ≥ 0.5
        ...PARAMS.map((p) => ({ ...p, automationRate: 'k-rate' }))
      ];
    }
    constructor(options) {
      super();
      const o = (options && options.processorOptions) || {};
      this.kind = o.kind === 'voice' ? 'voice' : 'effect';
      this.startFrame = Math.round((Number(o.start) || 0) * sampleRate);
      this.values = Object.assign({}, o.params || {});
      this.dead = false;
      this.releasedFrame = -1;
      this.port.onmessage = (e) => {
        const m = e.data;
        if (!m || m.type !== 'params' || typeof m.values !== 'object' || this.dead) return;
        Object.assign(this.values, m.values);
        if (this.unit && typeof this.unit.update === 'function') { try { this.unit.update(Object.assign({}, this.values)); } catch (err) { this.fail(err); } }
      };
      try {
        if (!def) throw new Error('the plugin did not register itself');
        if (this.kind === 'voice') {
          const key = Number(o.key) || 60;
          this.unit = def.createVoice({ sampleRate, key, frequency: 440 * Math.pow(2, (key - 69) / 12), velocity: Number(o.velocity) || 0, params: Object.assign({}, this.values) });
        } else {
          this.unit = def.create({ sampleRate, params: Object.assign({}, this.values) });
        }
        if (!this.unit || typeof this.unit.process !== 'function') throw new Error('createVoice/create must return an object with process()');
      } catch (err) { this.fail(err); }
    }
    fail(err) {
      if (this.dead) return;
      this.dead = true;
      try { this.port.postMessage({ type: 'error', message: String((err && err.message) || err).slice(0, 300) }); } catch (e) { /* ignore */ }
    }
    end() {
      try { this.port.postMessage({ type: 'ended' }); } catch (e) { /* ignore */ }
      return false;
    }
    process(inputs, outputs, parameters) {
      const out = outputs[0];
      if (this.kind === 'effect') {
        const input = inputs[0] && inputs[0].length ? inputs[0] : null;
        const L = out[0];
        const R = out[1] || out[0];
        const inL = input ? input[0] : new Float32Array(L.length);
        const inR = input ? (input[1] || input[0]) : inL;
        if (this.dead) { L.set(inL); if (R !== L) R.set(inR); return true; } // a broken effect is bypassed, never silent
        const vals = Object.assign({}, this.values);
        for (const p of PARAMS) vals[p.name] = parameters[p.name][0];
        try { this.unit.process([inL, inR], [L, R], L.length, vals); } catch (err) { this.fail(err); L.set(inL); if (R !== L) R.set(inR); return true; }
        clean(L); if (R !== L) clean(R);
        return true;
      }
      if (this.dead || parameters.gtdKill[0] >= 0.5) return this.end();
      const frames = out[0].length;
      const offset = this.startFrame - currentFrame;
      if (offset >= frames) return true; // not started yet
      const from = Math.max(0, offset);
      const gate = parameters.gtdGate;
      if (this.releasedFrame < 0) {
        for (let i = from; i < frames; i++) {
          if ((gate.length > 1 ? gate[i] : gate[0]) < 0.5) {
            this.releasedFrame = currentFrame + i;
            try { if (typeof this.unit.release === 'function') this.unit.release(); } catch (err) { this.fail(err); return this.end(); }
            break;
          }
        }
      } else if (currentFrame - this.releasedFrame > MAX_TAIL * sampleRate) {
        return this.end();
      }
      const L = out[0].subarray(from);
      const R = (out[1] || out[0]).subarray(from);
      let alive;
      try { alive = this.unit.process([L, R], L.length); } catch (err) { this.fail(err); return this.end(); }
      clean(out[0]); if (out[1]) clean(out[1]);
      return alive === false ? this.end() : true;
    }
  }
  gtdPluginMain.call(undefined, api, undefined, undefined, undefined, undefined);
  reg(NAME, Harness);
}
`;
}

/**
 * Everything the studio checks in an uploaded plugin package (also used by `npm run plugin:pack`, so packing and
 * installing agree): the zip, the manifest, file types, the code rules and real audio samples.
 * Returns { manifest, files }; throws a 400 error with the reason.
 */
export function validatePackage(buffer) {
  let files;
  try {
    files = readZip(buffer);
  } catch (e) {
    throw httpError(400, e instanceof ZipError ? e.message : 'Not a valid zip file');
  }
  const mf = files.get('plugin.json');
  if (!mf) throw httpError(400, 'The zip has no plugin.json at its root');
  if (mf.length > MAX_MANIFEST_BYTES) throw httpError(400, 'plugin.json is too large');
  let raw;
  try { raw = JSON.parse(mf.toString('utf8')); } catch { throw httpError(400, 'plugin.json is not valid JSON'); }
  let manifest;
  try { manifest = validateManifest(raw, new Set(files.keys())); } catch (e) { throw httpError(400, e.message); }
  const bad = [...files.keys()].filter((f) => !ALLOWED_EXT.test(f));
  if (bad.length) throw httpError(400, `Files of this type aren't allowed in a plugin: ${bad.slice(0, 5).join(', ')} (allowed: .json .js .wav .mp3 .ogg .flac .md .txt .png)`);
  const scripts = [...files.keys()].filter((f) => /\.js$/i.test(f));
  if (scripts.some((f) => f !== manifest.main)) throw httpError(400, `Only the main file may be code (found ${scripts.filter((f) => f !== manifest.main).join(', ')})`);
  if (manifest.main) {
    const code = files.get(manifest.main);
    if (code.length > MAX_CODE_BYTES) throw httpError(400, `${manifest.main} is too large (max 512 KB)`);
    const problems = checkPluginCode(code.toString('utf8'));
    if (problems.length) throw httpError(400, `${manifest.main} ${problems.join('; ')}`);
  }
  for (const z of manifest.samples) {
    if (!looksLikeAudio(z.file, files.get(z.file))) throw httpError(400, `${z.file} is not a valid audio file`);
  }
  return { manifest, files };
}

/** A plugin listed in the registry whose files are gone (e.g. installed by a pre-release build): ask to reinstall. */
function missingFiles(e) {
  if (e.code === 'ENOENT') throw httpError(409, "This plugin's files are missing — remove it and install it again");
  throw e;
}

export class PluginStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'plugins');
    this.pending = new Map(); // token → { userId, manifest, files, sha256, bytes, expires }
    this.locks = new Map();
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    return this;
  }

  userDir(userId) {
    if (!/^[\w-]+$/.test(String(userId))) throw httpError(400, 'Invalid user');
    return path.join(this.root, userId);
  }

  // <user>/registry.json + <user>/installed/<id>/: plugin ids live in their own folder, so no id (e.g.
  // "registry.json") can collide with the registry or the temporary install folders (<user>/.tmp-*)
  pluginDir(userId, id) {
    if (!PLUGIN_ID_RE.test(String(id))) throw httpError(400, 'Invalid plugin id');
    return path.join(this.userDir(userId), 'installed', id);
  }

  /** Run fn with the user's plugin registry locked (installs/removals never interleave). */
  async locked(userId, fn) {
    const prev = this.locks.get(userId) || Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(userId, run.catch(() => {}));
    return run;
  }

  async registry(userId) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.userDir(userId), 'registry.json'), 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  async saveRegistry(userId, list) {
    await fs.mkdir(this.userDir(userId), { recursive: true });
    await writeFileAtomic(path.join(this.userDir(userId), 'registry.json'), JSON.stringify(list, null, 1));
  }

  /** The user's plugins (manifest + install info). */
  async list(userId) {
    return this.registry(userId);
  }

  async get(userId, id) {
    return (await this.registry(userId)).find((p) => p.id === id) || null;
  }

  /** Validate an uploaded zip and hold it until the user confirms. Returns what the install dialog shows. */
  async inspect(userId, buffer) {
    for (const [t, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(t);
    const { manifest, files } = validatePackage(buffer);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const existing = await this.get(userId, manifest.id);
    const token = crypto.randomBytes(16).toString('hex');
    const bytes = [...files.values()].reduce((a, d) => a + d.length, 0);
    const mine = [...this.pending].filter(([, x]) => x.userId === userId);
    for (const [t] of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_USER + 1))) this.pending.delete(t); // oldest first
    let held = [...this.pending.values()].reduce((a, x) => a + x.bytes, 0);
    for (const [t, x] of this.pending) {
      if (held + bytes <= MAX_PENDING_BYTES) break;
      this.pending.delete(t);
      held -= x.bytes;
    }
    this.pending.set(token, { userId, manifest, files, sha256, bytes, expires: Date.now() + PENDING_TTL_MS });
    return {
      token, sha256, manifest,
      files: [...files.entries()].map(([p, d]) => ({ path: p, bytes: d.length })),
      totalBytes: bytes,
      update: existing ? { from: existing.version } : null
    };
  }

  /** Install an inspected package (the user confirmed they trust it). */
  async install(userId, token) {
    const p = this.pending.get(token);
    if (!p || p.userId !== userId || p.expires < Date.now()) throw httpError(400, 'This upload expired — choose the plugin file again');
    this.pending.delete(token);
    return this.locked(userId, async () => {
      const { manifest, files, sha256 } = p;
      const dir = this.pluginDir(userId, manifest.id);
      const tmp = path.join(this.userDir(userId), `.tmp-${crypto.randomBytes(6).toString('hex')}`);
      await fs.mkdir(tmp, { recursive: true });
      await fs.mkdir(path.dirname(dir), { recursive: true });
      try {
        for (const [rel, data] of files) {
          const dest = path.join(tmp, rel);
          if (!dest.startsWith(tmp + path.sep)) throw httpError(400, 'Unsafe path'); // belt and braces (readZip already checked)
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, data, { flag: 'wx' });
        }
        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(tmp, dir);
      } catch (e) {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      const list = (await this.registry(userId)).filter((x) => x.id !== manifest.id);
      const entry = {
        id: manifest.id, version: manifest.version, name: manifest.name, type: manifest.type, enabled: true,
        installedAt: new Date().toISOString(), sha256, bytes: [...files.values()].reduce((a, d) => a + d.length, 0), manifest
      };
      list.push(entry);
      list.sort((a, b) => a.name.localeCompare(b.name));
      await this.saveRegistry(userId, list);
      return entry;
    });
  }

  async setEnabled(userId, id, enabled) {
    return this.locked(userId, async () => {
      const list = await this.registry(userId);
      const entry = list.find((x) => x.id === id);
      if (!entry) throw httpError(404, 'Plugin not found');
      entry.enabled = !!enabled;
      await this.saveRegistry(userId, list);
      return entry;
    });
  }

  async remove(userId, id) {
    return this.locked(userId, async () => {
      const list = await this.registry(userId);
      if (!list.some((x) => x.id === id)) throw httpError(404, 'Plugin not found');
      await fs.rm(this.pluginDir(userId, id), { recursive: true, force: true });
      // pre-release layout (<user>/<id>/) — never the names this layout itself uses
      if (!['installed', 'registry.json'].includes(id)) await fs.rm(path.join(this.userDir(userId), id), { recursive: true, force: true });
      await this.saveRegistry(userId, list.filter((x) => x.id !== id));
    });
  }

  async removeUser(userId) {
    await fs.rm(this.userDir(userId), { recursive: true, force: true });
  }

  /** An enabled plugin of this user (404 otherwise — also for other users' plugins). */
  async requireEnabled(userId, id) {
    const entry = PLUGIN_ID_RE.test(String(id)) ? await this.get(userId, id) : null;
    if (!entry) throw httpError(404, 'Plugin not found');
    if (!entry.enabled) throw httpError(409, `Plugin "${entry.name}" is disabled`);
    return entry;
  }

  async code(userId, entry) {
    if (!entry.manifest.main) throw httpError(404, 'This plugin has no code');
    const code = await fs.readFile(path.join(this.pluginDir(userId, entry.id), entry.manifest.main), 'utf8').catch(missingFiles);
    if (checkPluginCode(code).length) throw httpError(409, 'Plugin code failed its safety check'); // re-checked on every load
    return code;
  }

  /** A sample file listed in the manifest (only those). Returns { data, mime }. */
  async sample(userId, entry, rel) {
    const zone = entry.manifest.samples.find((z) => z.file === rel);
    if (!zone) throw httpError(404, 'Not a sample of this plugin');
    const data = await fs.readFile(path.join(this.pluginDir(userId, entry.id), zone.file)).catch(missingFiles);
    return { data, mime: AUDIO_MIME[zone.file.split('.').pop().toLowerCase()] || 'application/octet-stream' };
  }
}
