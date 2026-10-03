// User plugins: instruments, effects and note generators packaged as a zip with a `plugin.json` manifest.
// The manifest is validated here (shared by the server, the studio and the tests); plugin *code* never runs on the
// server — DSP runs in the browser's AudioWorklet, generators in a sandboxed iframe worker (see docs/plugins.md).

export const PLUGIN_TYPES = ['instrument', 'effect', 'generator'];
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9.-]{1,62}[a-z0-9]$/;

/**
 * The AudioWorklet processor name of an installed DSP plugin. It includes the package hash because a worklet scope
 * can't re-register a name: an updated plugin gets a new processor, so open studios pick the update up without a reload.
 */
export const pluginProcessorName = (id, sha256) => `gtd-plugin-${id}-${String(sha256 || '').slice(0, 12)}`;
export const PLUGIN_API_VERSION = 1;

/**
 * Permissions a plugin can ask for. Anything else (network, storage, account, files…) is refused at install time —
 * the sandboxes don't offer it at all.
 */
export const PLUGIN_PERMISSIONS = {
  'audio-processing': 'Run its own audio code (DSP) in the browser\'s audio engine. It can make any sound, including very loud ones, and use CPU.',
  samples: 'Ship audio samples that the studio plays (no code).',
  generator: 'Generate notes for you and for Claude (runs in an isolated sandbox with a time limit).',
  'project-read': 'Read the notes of the pattern it generates into (and the project key, scale and tempo).'
};
export const FORBIDDEN_PERMISSIONS = ['network', 'internet', 'storage', 'files', 'account', 'cookies', 'clipboard', 'microphone', 'camera'];

const MAX_PARAMS = 48;
const MAX_ZONES = 128;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const FILE_RE = /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]{0,120}$/;
const AUDIO_FILE_RE = /\.(wav|mp3|ogg|flac)$/i;

const fail = (msg) => { throw new Error(`plugin.json: ${msg}`); };
const str = (v, max, what, required = false) => {
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${what} is required`);
    return '';
  }
  if (typeof v !== 'string') fail(`${what} must be a string`);
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
};
const finite = (v, what) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6) fail(`${what} must be a number`);
  return v;
};

/** One parameter definition, in the same shape as the built-in instruments/effects (drives knobs and validation). */
function paramDef(p, i) {
  if (!p || typeof p !== 'object') fail(`params[${i}] must be an object`);
  const key = p.key;
  if (typeof key !== 'string' || !KEY_RE.test(key)) fail(`params[${i}].key must be a short identifier (letters, digits, _)`);
  if (/^gtd/i.test(key)) fail(`params[${i}].key: names starting with "gtd" are reserved`);
  const label = str(p.label, 32, `params[${i}].label`) || key;
  const type = p.type || 'number';
  if (type === 'number') {
    const min = finite(p.min ?? 0, `params[${i}].min`);
    const max = finite(p.max ?? 1, `params[${i}].max`);
    if (!(max > min)) fail(`params[${i}]: max must be greater than min`);
    const def = finite(p.default ?? min, `params[${i}].default`);
    if (def < min || def > max) fail(`params[${i}].default must be between min and max`);
    if (p.curve === 'log' && !(min > 0)) fail(`params[${i}]: a log curve needs min > 0`);
    return {
      key, label, type, min, max, default: def,
      ...(p.curve === 'log' ? { curve: 'log' } : {}),
      ...(p.step !== undefined ? { step: finite(p.step, `params[${i}].step`) } : {}),
      ...(p.unit ? { unit: str(p.unit, 8, `params[${i}].unit`) } : {}),
      ...(p.automatable ? { automatable: true } : {}),
      ...(p.group ? { group: str(p.group, 24, `params[${i}].group`) } : {})
    };
  }
  if (type === 'select') {
    if (!Array.isArray(p.options) || !p.options.length || p.options.length > 24) fail(`params[${i}].options must list 1–24 choices`);
    const options = p.options.map((o, k) => str(o, 24, `params[${i}].options[${k}]`, true));
    const def = p.default ?? options[0];
    if (!options.includes(def)) fail(`params[${i}].default must be one of the options`);
    return { key, label, type, options, default: def, ...(p.group ? { group: str(p.group, 24, 'group') } : {}) };
  }
  if (type === 'bool') return { key, label, type, default: !!p.default, ...(p.group ? { group: str(p.group, 24, 'group') } : {}) };
  return fail(`params[${i}].type must be number, select or bool`);
}

/**
 * Validate and normalize a plugin.json object. `files` (optional) is the set of paths in the package, to check that
 * referenced files exist. Returns the normalized manifest; throws Error('plugin.json: …') on the first problem.
 */
export function validateManifest(raw, files = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('must be a JSON object');
  const id = raw.id;
  if (typeof id !== 'string' || !PLUGIN_ID_RE.test(id)) fail('id must be 3–64 lowercase letters, digits, dots or dashes, e.g. "acme.tape-echo"');
  const version = str(raw.version, 32, 'version', true);
  if (!/^\d+\.\d+\.\d+([-+][\w.]+)?$/.test(version)) fail('version must look like 1.0.0');
  const type = raw.type;
  if (!PLUGIN_TYPES.includes(type)) fail(`type must be one of ${PLUGIN_TYPES.join(', ')}`);
  const api = raw.apiVersion ?? PLUGIN_API_VERSION;
  if (api !== PLUGIN_API_VERSION) fail(`apiVersion ${api} is not supported (this studio supports ${PLUGIN_API_VERSION})`);

  const perms = raw.permissions ?? [];
  if (!Array.isArray(perms)) fail('permissions must be a list');
  for (const p of perms) {
    if (typeof p !== 'string') fail('permissions must be strings');
    if (FORBIDDEN_PERMISSIONS.includes(p.toLowerCase())) fail(`the "${p}" permission is never granted: plugins can't reach the network, your account or your files`);
    if (!PLUGIN_PERMISSIONS[p]) fail(`unknown permission "${p}" (known: ${Object.keys(PLUGIN_PERMISSIONS).join(', ')})`);
  }
  const permissions = [...new Set(perms)];
  const has = (p) => permissions.includes(p);

  const main = raw.main === undefined || raw.main === null ? null : str(raw.main, 120, 'main');
  if (main && (!FILE_RE.test(main) || !/\.js$/.test(main))) fail('main must be a .js file inside the package');
  if (main && files && !files.has(main)) fail(`main "${main}" is not in the package`);

  const params = raw.params ?? [];
  if (!Array.isArray(params) || params.length > MAX_PARAMS) fail(`params must be a list of at most ${MAX_PARAMS}`);
  const defs = params.map(paramDef);
  if (new Set(defs.map((d) => d.key)).size !== defs.length) fail('param keys must be unique');

  let samples = [];
  if (raw.samples !== undefined) {
    if (!Array.isArray(raw.samples) || raw.samples.length > MAX_ZONES) fail(`samples must be a list of at most ${MAX_ZONES} zones`);
    samples = raw.samples.map((z, i) => {
      const file = str(z?.file, 120, `samples[${i}].file`, true);
      if (!FILE_RE.test(file) || !AUDIO_FILE_RE.test(file)) fail(`samples[${i}].file must be a .wav, .mp3, .ogg or .flac file in the package`);
      if (files && !files.has(file)) fail(`samples[${i}].file "${file}" is not in the package`);
      const int = (v, d, lo, hi, what) => { const x = v === undefined ? d : Math.round(finite(v, what)); if (x < lo || x > hi) fail(`${what} must be ${lo}..${hi}`); return x; };
      const lo = int(z.lo, 0, 0, 127, `samples[${i}].lo`);
      const hi = int(z.hi, 127, 0, 127, `samples[${i}].hi`);
      if (hi < lo) fail(`samples[${i}]: hi must be ≥ lo`);
      const velLo = z.velLo === undefined ? 0 : finite(z.velLo, `samples[${i}].velLo`);
      const velHi = z.velHi === undefined ? 1 : finite(z.velHi, `samples[${i}].velHi`);
      if (velLo < 0 || velHi > 1 || velHi < velLo) fail(`samples[${i}]: velocities are 0..1 with velLo ≤ velHi`);
      return { file, root: int(z.root, 60, 0, 127, `samples[${i}].root`), lo, hi, velLo, velHi, ...(z.loop ? { loop: true } : {}) };
    });
  }

  // what each type needs, and the permissions that go with it
  if (type === 'generator') {
    if (!main) fail('a generator needs main (its .js file)');
    if (!has('generator')) fail('a generator must ask for the "generator" permission');
    if (samples.length || has('samples')) fail('generators can\'t ship samples');
    if (has('audio-processing')) fail('generators don\'t process audio');
  } else {
    if (has('generator') || has('project-read')) fail(`an ${type} can't ask for generator or project-read`);
    if (main && !has('audio-processing')) fail('plugins with code (main) must ask for the "audio-processing" permission');
    if (!main && has('audio-processing')) fail('"audio-processing" needs main (the DSP code)');
    if (type === 'effect' && !main) fail('an effect needs main (its DSP code)');
    if (type === 'effect' && samples.length) fail('effects can\'t ship samples');
    if (type === 'instrument' && !main && !samples.length) fail('an instrument needs main (DSP code) or samples');
    if (samples.length && !has('samples')) fail('plugins with samples must ask for the "samples" permission');
    if (!samples.length && has('samples')) fail('"samples" permission without samples');
    if (main && samples.length) fail('an instrument is either DSP code (main) or samples, not both');
  }

  const presets = {};
  if (raw.presets !== undefined) {
    if (!raw.presets || typeof raw.presets !== 'object' || Array.isArray(raw.presets) || Object.keys(raw.presets).length > 64) fail('presets must be an object of at most 64 presets');
    for (const [name, values] of Object.entries(raw.presets)) {
      const pn = str(name, 32, 'preset name', true);
      presets[pn] = sanitizePluginValues(defs, values, { strict: true, what: `preset "${pn}"` });
    }
  }
  if (!Object.keys(presets).length) presets.Default = {};

  const color = typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color : '#7c8a99';
  const polyphony = raw.polyphony === undefined ? 16 : Math.round(finite(raw.polyphony, 'polyphony'));
  if (polyphony < 1 || polyphony > 64) fail('polyphony must be 1..64');
  return {
    id, version, type, apiVersion: PLUGIN_API_VERSION,
    name: str(raw.name, 48, 'name', true),
    author: str(raw.author, 64, 'author'),
    description: str(raw.description, 600, 'description'),
    license: str(raw.license, 40, 'license'),
    homepage: /^https:\/\/[^\s"<>]{3,200}$/.test(raw.homepage || '') ? raw.homepage : '',
    permissions, main, params: defs, presets, samples,
    melodic: raw.melodic !== false,
    defaultKey: raw.defaultKey === undefined ? 60 : Math.max(0, Math.min(127, Math.round(finite(raw.defaultKey, 'defaultKey')))),
    polyphony, color
  };
}

/** Values for a plugin's params: known keys only, clamped (strict: throw instead). */
export function sanitizePluginValues(defs, values = {}, { strict = false, what = 'params' } = {}) {
  const out = {};
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    if (strict) throw new Error(`${what} must be an object`);
    return out;
  }
  for (const [k, v] of Object.entries(values)) {
    const d = defs.find((x) => x.key === k);
    if (!d) {
      if (strict) throw new Error(`${what}: unknown parameter "${k}". Valid: ${defs.map((x) => x.key).join(', ') || 'none'}`);
      continue;
    }
    if (d.type === 'number') {
      const x = typeof v === 'number' ? v : parseFloat(v);
      if (!Number.isFinite(x) || (strict && (x < d.min || x > d.max))) {
        if (strict) throw new Error(`${what}: "${k}" must be between ${d.min} and ${d.max}`);
        continue;
      }
      let y = Math.min(d.max, Math.max(d.min, x));
      if (d.step > 0) y = Math.min(d.max, d.min + Math.round((y - d.min) / d.step) * d.step); // integer/stepped params
      out[k] = Math.round(y * 1e9) / 1e9;
    } else if (d.type === 'select') {
      if (!d.options.includes(v)) {
        if (strict) throw new Error(`${what}: "${k}" must be one of ${d.options.join(', ')}`);
        continue;
      }
      out[k] = v;
    } else {
      out[k] = v === true || v === 'true' || v === 1;
    }
  }
  return out;
}

/** Loose cleaning of plugin param values stored in projects (the plugin may not be installed for this user). */
export function sanitizeStoredPluginParams(params) {
  const out = {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return out;
  for (const [k, v] of Object.entries(params).slice(0, 64)) {
    if (!KEY_RE.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(-1e6, Math.min(1e6, v));
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 64);
  }
  return out;
}

export const validPluginId = (id) => (typeof id === 'string' && PLUGIN_ID_RE.test(id) ? id : null);

/** Default values of a manifest's params merged with a preset and overrides. */
export function pluginParamValues(manifest, preset, overrides = {}) {
  const base = Object.fromEntries(manifest.params.map((d) => [d.key, d.default]));
  return { ...base, ...(Object.hasOwn(manifest.presets, preset) ? manifest.presets[preset] : {}), ...sanitizePluginValues(manifest.params, overrides) };
}

// ------------------------------------------------------------------ generator output

export const GENERATOR_MAX_NOTES = 4096;

/**
 * Notes returned by a generator (untrusted): [{ step, length, key, velocity }] in 16th-note steps relative to the
 * generation start. Invalid entries are dropped, values clamped, at most GENERATOR_MAX_NOTES kept, steps inside
 * [0, maxSteps).
 */
export function cleanGeneratedNotes(raw, maxSteps) {
  if (!Array.isArray(raw)) throw new Error('The generator must return a list of notes');
  const out = [];
  for (const n of raw.slice(0, GENERATOR_MAX_NOTES * 2)) {
    if (!n || typeof n !== 'object') continue;
    const step = Number(n.step);
    const key = Number(n.key);
    if (!Number.isFinite(step) || !Number.isFinite(key) || step < 0 || step >= maxSteps) continue;
    const length = Number.isFinite(Number(n.length)) ? Math.min(Math.max(0.25, Number(n.length)), maxSteps - step) : 1;
    const velocity = Number.isFinite(Number(n.velocity)) ? Math.min(1, Math.max(0.01, Number(n.velocity))) : 0.8;
    out.push({ step: Math.round(step * 4) / 4, length: Math.max(0.25, Math.round(length * 4) / 4), key: Math.max(0, Math.min(127, Math.round(key))), velocity: Math.round(velocity * 1000) / 1000 });
    if (out.length >= GENERATOR_MAX_NOTES) break;
  }
  return out;
}
