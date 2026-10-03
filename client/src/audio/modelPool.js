// Physical-model notes for the audio engine: rendered ahead of time in background workers ("prewarming" every note a
// project uses), so neither the realtime scheduler nor an offline render waits ~100 ms for a low piano note. A note
// that still isn't ready when it plays is rendered on the spot (see noteBuffer).
import { getInstrumentDef, instrumentDefaults } from '@greanteadawy/core';
import { modelOf, noteCacheKey, cacheGet, cachePut, layerOf, renderModel, pinNotes, isCached, LAYERS } from './models.js';

const MAX_PREWARM = 400; // distinct notes per project — the cache holds ~24M samples anyway

let workers = null;
const callbacks = new Map();
const inflight = new Map(); // cache key -> Promise
let nextId = 1;

function pool() {
  if (workers) return workers;
  workers = [];
  if (typeof Worker === 'undefined') return workers;
  const n = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency || 2) - 1));
  try {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./modelWorker.js', import.meta.url), { type: 'module' });
      w.busy = 0;
      w.onmessage = (e) => {
        w.busy--;
        const cb = callbacks.get(e.data.id);
        callbacks.delete(e.data.id);
        cb?.fn(e.data);
      };
      // a worker that can't load (blocked, offline build) must not leave renders waiting: release its jobs (the
      // notes then render on the spot) and stop using it
      w.onerror = () => {
        workers = workers.filter((x) => x !== w);
        for (const [id, cb] of callbacks) if (cb.worker === w) { callbacks.delete(id); cb.fn({}); }
        try { w.terminate(); } catch { /* ignore */ }
      };
      workers.push(w);
    }
  } catch {
    workers = [];
  }
  return workers;
}

export function toAudioBuffer(sr, data) {
  const buf = new AudioBuffer({ length: data.length, sampleRate: sr, numberOfChannels: 1 });
  buf.copyToChannel(data, 0);
  return buf;
}

/** The AudioBuffer of one note, rendering it now if no worker has done it yet. */
export function noteBuffer(sr, spec, key, layer) {
  const k = noteCacheKey(spec, sr, key, layer);
  return cacheGet(k) || cachePut(k, toAudioBuffer(sr, renderModel(spec.model, sr, key, layer, spec.p)));
}

/**
 * A note for live playing (keyboard, MIDI, previews, realtime playback): never blocks the audio-scheduling thread
 * for a render when a nearby note is ready. Returns { buffer, key } — the exact note, or the closest rendered one
 * (same layer first, within a fifth) to be repitched while the exact note renders in a worker.
 */
export function liveNoteBuffer(sr, spec, key, layer) {
  const exact = cacheGet(noteCacheKey(spec, sr, key, layer));
  if (exact) return { buffer: exact, key };
  if (pool().length) {
    const layers = [layer, ...Array.from({ length: LAYERS }, (_, i) => i).filter((l) => l !== layer).sort((a, b) => Math.abs(a - layer) - Math.abs(b - layer))];
    for (const l of layers) {
      for (let d = 1; d <= 7; d++) {
        for (const k2 of [key - d, key + d]) {
          if (k2 < 0 || k2 > 127 || !isCached(noteCacheKey(spec, sr, k2, l))) continue;
          renderInBackground(sr, spec, key, layer);
          return { buffer: cacheGet(noteCacheKey(spec, sr, k2, l)), key: k2 };
        }
      }
    }
  }
  return { buffer: noteBuffer(sr, spec, key, layer), key };
}

/** Render a key range of one instrument in the background (e.g. when its channel is selected for playing). */
export function prewarmRange(sr, spec, from, to, layer) {
  for (let k = Math.max(0, from); k <= Math.min(127, to); k++) renderInBackground(sr, spec, k, layer);
}

function renderInBackground(sr, spec, key, layer) {
  const k = noteCacheKey(spec, sr, key, layer);
  if (cacheGet(k)) return null;
  if (inflight.has(k)) return inflight.get(k);
  const ws = pool();
  let promise;
  if (ws.length) {
    const w = ws.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = nextId++;
    promise = new Promise((resolve) => {
      callbacks.set(id, {
        worker: w,
        fn: ({ data }) => {
          if (data) cachePut(k, toAudioBuffer(sr, data));
          resolve();
        }
      });
    });
    w.busy++;
    w.postMessage({ id, model: spec.model, sr, key, layer, p: spec.p });
  } else {
    // no workers (old browser, tests): render between other work on this thread
    promise = new Promise((resolve) => setTimeout(() => { noteBuffer(sr, spec, key, layer); resolve(); }, 0));
  }
  promise = promise.finally(() => inflight.delete(k));
  inflight.set(k, promise);
  return promise;
}

/** Every (model, key, velocity layer) the project's patterns play. */
export function modelNotesOf(project) {
  const out = new Map();
  for (const c of project.channels) {
    let def;
    try { def = getInstrumentDef(c.instrument.kind); } catch { continue; }
    if (!def.melodic) continue;
    const params = { ...instrumentDefaults(c.instrument.kind), ...c.instrument.params };
    const spec = modelOf(c.instrument.kind, params);
    if (!spec) continue;
    for (const pat of project.patterns) {
      for (const note of pat.notes?.[c.id] || []) {
        const key = Math.max(0, Math.min(127, Math.round(note.key + (c.pitch || 0))));
        const layer = layerOf(note.velocity ?? 0.8);
        out.set(`${spec.model}|${key}|${layer}|${spec.id}`, { spec, key, layer });
        if (out.size >= MAX_PREWARM) return [...out.values()];
      }
    }
  }
  return [...out.values()];
}

/** Render (in the background) every model note of the project that isn't cached yet. Resolves when all are ready. */
export function prewarmModels(project, sr, { pin = false } = {}) {
  const jobs = [];
  const notes = modelNotesOf(project);
  // only the live engine pins (offline renders and analysis jobs must not take the open project's place)
  if (pin) pinNotes(notes.map(({ spec, key, layer }) => noteCacheKey(spec, sr, key, layer)));
  for (const { spec, key, layer } of notes) {
    const p = renderInBackground(sr, spec, key, layer);
    if (p) jobs.push(p);
  }
  return Promise.all(jobs);
}
