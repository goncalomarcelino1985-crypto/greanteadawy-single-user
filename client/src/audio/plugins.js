// User plugins in the audio engine. DSP plugins (instrument voices, effects) run in the AudioWorklet through the
// server-generated harness (/api/plugins/:id/worklet.js → processor pluginProcessorName(id, sha256)); sample instruments are played
// by the studio's own sample voice. The registry (the user's installed plugins) is set by the store.
import { pluginProcessorName, sanitizePluginValues } from '@greanteadawy/core';
import { setParam } from './dsp.js';

let registry = new Map(); // id → { id, name, type, enabled, sha256, manifest }
const modules = new WeakMap(); // AudioContext → Map(processor name → Promise<boolean>)
const ready = new WeakMap(); // AudioContext → Set(processor name)
const zones = new Map(); // `${id}|${sha}|${file}` → Promise<AudioBuffer|null>
const buffers = new Map(); // same key → decoded AudioBuffer
let onError = () => {};

export function setPluginRegistry(list, { onPluginError } = {}) {
  registry = new Map((list || []).filter((p) => p.enabled).map((p) => [p.id, p]));
  if (onPluginError) onError = onPluginError;
}
export const pluginEntry = (id) => registry.get(id) || null;
export const pluginParamDefs = (id) => registry.get(id)?.manifest.params || [];

const hasCode = (e) => !!e?.manifest.main && e.type !== 'generator';
// one processor per installed version (the name includes the package hash), so an update loads next to the old one
const procName = (e) => pluginProcessorName(e.id, e.sha256);
const isReady = (ctx, e) => !!ready.get(ctx)?.has(procName(e));

/** Load a DSP plugin's worklet module into a context (once). Resolves true when its processor can be created. */
export function loadPluginModule(ctx, id) {
  const e = registry.get(id);
  if (!hasCode(e) || !ctx.audioWorklet) return Promise.resolve(false);
  let m = modules.get(ctx);
  if (!m) modules.set(ctx, (m = new Map()));
  const name = procName(e);
  if (!m.has(name)) {
    m.set(name, ctx.audioWorklet.addModule(`/api/plugins/${encodeURIComponent(id)}/worklet.js?v=${e.sha256.slice(0, 16)}`)
      .then(() => {
        let r = ready.get(ctx);
        if (!r) ready.set(ctx, (r = new Set()));
        r.add(name);
        return true;
      })
      .catch((err) => {
        m.delete(name); // a later attempt (e.g. after re-enabling) may succeed
        onError(id, `could not load: ${err.message || err}`);
        return false;
      }));
  }
  return m.get(name);
}

/** Decode a sample instrument's zones (shared by every context). */
function loadZones(ctx, e) {
  return Promise.all(e.manifest.samples.map((z) => {
    const k = `${e.id}|${e.sha256}|${z.file}`;
    if (!zones.has(k)) {
      zones.set(k, fetch(`/api/plugins/${encodeURIComponent(e.id)}/samples/${z.file.split('/').map(encodeURIComponent).join('/')}`, { credentials: 'same-origin' })
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buf) => { buffers.set(k, buf); return buf; })
        .catch((err) => { onError(e.id, `sample ${z.file}: ${err.message || err}`); zones.delete(k); return null; }));
    }
    return zones.get(k);
  }));
}

/** Plugins a project uses (instrument channels and effects). */
export function pluginsUsed(project) {
  const ids = new Set();
  for (const c of project.channels) if (c.instrument.kind === 'plugin' && c.instrument.plugin) ids.add(c.instrument.plugin);
  for (const m of project.mixer) for (const fx of m.effects) if (fx.type === 'plugin' && fx.plugin) ids.add(fx.plugin);
  return [...ids];
}

/** Load everything a project's plugins need in this context (modules and samples). */
export function preparePlugins(ctx, project) {
  return Promise.all(pluginsUsed(project).map((id) => {
    const e = registry.get(id);
    if (!e) return null;
    return e.manifest.samples.length ? loadZones(ctx, e) : loadPluginModule(ctx, id);
  }));
}

// ------------------------------------------------------------------ instrument voices

const zoneBuffers = (e) => e.manifest.samples.map((z) => ({ z, buf: buffers.get(`${e.id}|${e.sha256}|${z.file}`) || null }));

/**
 * One note of a plugin instrument (called from playNote). Returns the natural end time, null while held, or t when
 * the plugin isn't available here (missing, disabled, still loading).
 */
export function pluginVoice(v, ctx, instrument, { t, velRaw, key }) {
  const e = registry.get(instrument.plugin);
  if (!e || e.type !== 'instrument') return t;
  // projects store plugin values loosely (the plugin may change or be missing): the plugin only ever sees valid ones
  const p = { ...Object.fromEntries(e.manifest.params.map((d) => [d.key, d.default])), ...sanitizePluginValues(e.manifest.params, instrument.params) };
  v.freq = 440 * Math.pow(2, (key - 69) / 12);
  if (e.manifest.samples.length) return sampleVoice(v, ctx, e, p, { t, velRaw, key });
  if (!isReady(ctx, e)) { loadPluginModule(ctx, e.id); return t; }
  let node;
  try {
    node = new AudioWorkletNode(ctx, procName(e), {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { kind: 'voice', key, velocity: velRaw, start: t, params: p }
    });
  } catch (err) {
    onError(e.id, err.message);
    return t;
  }
  const gate = node.parameters.get('gtdGate');
  const kill = node.parameters.get('gtdKill');
  // a source-like handle for Voice: stop() = hard stop, onended when the processor says it finished
  const src = {
    onended: null,
    stop(time) { try { kill.setValueAtTime(1, Math.max(time, ctx.currentTime)); } catch { /* ignore */ } }
  };
  node.port.onmessage = (ev) => {
    const m = ev.data;
    if (m?.type === 'ended') { node.port.onmessage = null; src.onended?.(); try { node.disconnect(); } catch { /* ignore */ } }
    else if (m?.type === 'error') onError(e.id, String(m.message).slice(0, 200));
  };
  v.add(src);
  node.connect(v.out);
  v.releaseFn = (time) => {
    gate.setValueAtTime(0, Math.max(time, t));
    return Math.max(time, t) + 10; // the harness ends a voice at most 10 s after note-off
  };
  return null;
}

/** Sample instruments: the closest zone for key + velocity, repitched; params gain / attack / release if declared. */
function sampleVoice(v, ctx, e, p, { t, velRaw, key }) {
  const cands = zoneBuffers(e).filter(({ z }) => key >= z.lo && key <= z.hi && velRaw >= z.velLo && velRaw <= z.velHi);
  const pick = (cands.length ? cands : zoneBuffers(e)).filter((c) => c.buf)
    .sort((a, b) => Math.abs(a.z.root - key) - Math.abs(b.z.root - key))[0];
  if (!pick) { loadZones(ctx, e); return t; }
  const src = v.add(ctx.createBufferSource());
  src.buffer = pick.buf;
  const rate = Math.pow(2, (key - pick.z.root) / 12);
  src.playbackRate.value = rate;
  if (pick.z.loop) src.loop = true;
  const amp = ctx.createGain();
  const level = velRaw * velRaw * (p.gain ?? 1);
  const attack = Math.max(0.001, p.attack ?? 0.002);
  const release = Math.max(0.01, p.release ?? 0.3);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(level, t + attack);
  src.connect(amp).connect(v.out);
  src.start(t);
  const natural = pick.z.loop ? null : t + pick.buf.duration / rate;
  if (natural) src.stop(natural + 0.01);
  v.releaseFn = (time) => {
    if (natural && time >= natural) return natural;
    const rt = Math.max(time, t + attack);
    amp.gain.cancelScheduledValues(rt);
    amp.gain.setValueAtTime(level, rt);
    amp.gain.setTargetAtTime(0, rt, release / 5);
    return natural ? Math.min(natural, rt + release * 1.5) : rt + release * 1.5;
  };
  return natural;
}

// ------------------------------------------------------------------ effects

/**
 * A plugin effect slot. Passes audio through until the plugin's module is loaded in this context, then runs the
 * plugin between input and output. Automatable number params are AudioParams; the rest arrive as messages.
 */
export function pluginEffectNode(ctx, engine, fx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output);
  const e = registry.get(fx.plugin);
  let node = null;
  let current = null;
  const automation = {};
  const self = {
    input, output, automation, pluginId: fx.plugin,
    defs: e?.manifest.params || [],
    update(raw) {
      const params = sanitizePluginValues(self.defs, raw); // in range, rounded to steps, known keys only
      current = params;
      if (!node) return;
      const msg = {};
      for (const d of self.defs) {
        const v = params[d.key] ?? d.default;
        if (d.type === 'number' && d.automatable) setParam(node.parameters.get(d.key), v, ctx);
        else msg[d.key] = v;
      }
      node.port.postMessage({ type: 'params', values: msg });
    },
    dispose() { try { node?.disconnect(); } catch { /* ignore */ } }
  };
  const attach = () => {
    if (!e || e.type !== 'effect' || node) return;
    try {
      const p = { ...Object.fromEntries(self.defs.map((d) => [d.key, d.default])), ...(current || sanitizePluginValues(self.defs, fx.params)) };
      node = new AudioWorkletNode(ctx, procName(e), {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
        processorOptions: { kind: 'effect', params: p }
      });
    } catch (err) {
      onError(e.id, err.message);
      return;
    }
    node.port.onmessage = (ev) => { if (ev.data?.type === 'error') onError(e.id, String(ev.data.message).slice(0, 200)); };
    for (const d of self.defs) if (d.type === 'number' && d.automatable) automation[d.key] = node.parameters.get(d.key);
    input.disconnect();
    input.connect(node).connect(output);
    if (current) self.update(current);
  };
  if (e && isReady(ctx, e)) attach();
  else if (e) loadPluginModule(ctx, e.id).then((ok) => { if (ok) attach(); });
  return self;
}
