// Shared plumbing for editing samples in the browser (the wave editor, the recorder and Claude's edit_sample jobs):
// decode a sample at its own sample rate, run slow edits in a worker, encode WAV and save as a new sample or over the
// original.
import { applyEdit, analyzeMelody, autotune, encodeWav, makeClip, clipLength } from '@greanteadawy/core';
import { api } from '../state/api.js';
import { useStore } from '../state/store.js';
import { sampleFileUrl, noteSampleRevs } from '../audio/engine.js';
import { analyzeSampleInBrowser } from './jobs.js';

// ------------------------------------------------------------------ worker

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker !== null) return worker;
  if (typeof Worker === 'undefined') return (worker = false);
  try {
    worker = new Worker(new URL('../audio/editWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (!p) return;
      if (e.data.ok) p.resolve(e.data.res);
      else p.reject(new Error(e.data.error));
    };
    // a worker that can't start (blocked script, old browser): finish the waiting jobs on the main thread instead
    worker.onerror = (e) => {
      e.preventDefault?.();
      const w = worker;
      worker = false;
      try { w.terminate(); } catch { /* ignore */ }
      for (const [id, p] of pending) { pending.delete(id); p.fallback(); }
    };
  } catch {
    worker = false;
  }
  return worker;
}

const INLINE = {
  edit: (clip, args) => { const r = applyEdit(clip, args); return { clip: r.clip, note: r.note || null }; },
  analyze: (clip, args) => analyzeMelody(clip, args),
  autotune: (clip, args) => autotune(clip, args)
};

/** Run an edit job ('edit' | 'analyze' | 'autotune') off the main thread when possible. */
export function runAudioJob(kind, clip, args = {}) {
  const w = getWorker();
  const inline = () => Promise.resolve().then(() => INLINE[kind](clip, args));
  if (!w) return inline();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, fallback: () => inline().then(resolve, reject) });
    w.postMessage({ id, kind, clip, args }); // cloned: the caller's clip stays untouched (undo history)
  });
}

/** Edits that are quick enough to run right away (linear in the length, no analysis). */
export const FAST_EDITS = new Set(['trim', 'delete', 'silence', 'fade_in', 'fade_out', 'gain', 'normalize', 'reverse', 'invert', 'mono', 'stereo', 'remove_dc', 'trim_silence']);

/** Apply one named edit ({ op, start, end (seconds), … }): inline when fast, in the worker otherwise. */
export function editClip(clip, op) {
  if (FAST_EDITS.has(op.op)) {
    const r = applyEdit(clip, op);
    return Promise.resolve({ clip: r.clip, note: r.note || null });
  }
  return runAudioJob('edit', clip, op);
}

// ------------------------------------------------------------------ decode / encode

/** A sample's audio as a clip, decoded at its own sample rate (no resampling to the studio's rate). */
export async function decodeSample(sample) {
  const res = await fetch(sampleFileUrl(sample.id), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not load "${sample.name}" (${res.status})`);
  const bytes = await res.arrayBuffer();
  const rate = sample.metadata?.sampleRate;
  const sr = Number.isFinite(rate) && rate >= 8000 && rate <= 192000 ? rate : 48000;
  const buf = await new OfflineAudioContext(1, 1, sr).decodeAudioData(bytes);
  // more than two channels: the editor works on the first two (a stereo fold-down would change the sound)
  const n = Math.min(2, buf.numberOfChannels);
  return makeClip(Array.from({ length: n }, (_, i) => buf.getChannelData(i).slice()), buf.sampleRate);
}

/** An AudioBuffer of a clip for playback in `ctx`. */
export function clipToBuffer(ctx, clip) {
  const buf = ctx.createBuffer(clip.channels.length, Math.max(1, clipLength(clip)), clip.sampleRate);
  clip.channels.forEach((c, i) => buf.copyToChannel(c, i));
  return buf;
}

let limitMb = null;
/** The server's upload limit (MAX_UPLOAD_MB) in bytes. */
export async function uploadLimitBytes() {
  if (limitMb === null) {
    try { limitMb = (await api.status()).maxUploadMb || 50; } catch { return 50 * 1024 * 1024; } // ask again next time
  }
  return limitMb * 1024 * 1024;
}

/** Seconds of audio that fit the upload limit at a given format. */
export function secondsThatFit(bytes, { channels = 1, sampleRate = 48000, bitDepth = 24 } = {}) {
  return Math.floor((bytes - 1024) / (channels * sampleRate * (bitDepth / 8)));
}

/** WAV bytes of a clip: 24-bit, or 16-bit (dithered) when 24-bit would not fit the server's upload limit. */
export async function clipToWav(clip) {
  const limit = await uploadLimitBytes();
  const frames = clipLength(clip);
  for (const bitDepth of [24, 16]) {
    if (44 + frames * clip.channels.length * (bitDepth / 8) <= limit) {
      return { blob: new Blob([encodeWav(clip.channels, clip.sampleRate, { bitDepth })], { type: 'audio/wav' }), bitDepth };
    }
  }
  throw new Error(`This audio is too long to save: the server takes files up to ${Math.round(limit / 1048576)} MB (MAX_UPLOAD_MB). Trim it, make it mono, or ask the admin to raise the limit.`);
}

// eslint-disable-next-line no-control-regex
const fileName = (name) => `${(name || 'sample').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 70) || 'sample'}.wav`;

/** Save a clip as a new sample (in `folderId`); analyses it like an upload. Resolves the new sample. */
export async function saveClipAsSample(clip, { name, folderId = null } = {}) {
  const { blob } = await clipToWav(clip);
  const item = await api.uploadSample(blob, { name: fileName(name), title: name, folderId });
  noteSampleRevs([item]);
  if (!item.analysis) await analyzeSampleInBrowser(item.id).catch(() => {});
  await useStore.getState().refreshSamples();
  return item;
}

/** Replace a sample's audio (same id: every project that uses it plays the new audio). Resolves the sample. */
export async function replaceSampleAudio(sample, clip) {
  const { blob } = await clipToWav(clip);
  const item = await api.replaceSampleFile(sample.id, blob, fileName(sample.name));
  noteSampleRevs([item]); // before anything fetches the new audio (it is cached per revision)
  if (!item.analysis) await analyzeSampleInBrowser(item.id).catch(() => {});
  await useStore.getState().refreshSamples();
  return item;
}

/**
 * Claude's edit_sample (browser job): run the operations in order (in the worker), then save as a new sample or over
 * the original. Resolves { sampleId, notes, duration }.
 */
export async function runSampleEditJob(job) {
  const st = useStore.getState();
  // the library as it is now (its revisions decide which audio is fetched): Claude may have just replaced it
  await st.refreshSamples();
  const sample = useStore.getState().samples.find((x) => x.id === job.sampleId);
  if (!sample) throw new Error(`Sample ${job.sampleId} not found`);
  if (!Array.isArray(job.ops) || !job.ops.length) throw new Error('No operations');
  let clip = await decodeSample(sample);
  const notes = [];
  for (const op of job.ops) {
    const r = await runAudioJob('edit', clip, op);
    clip = r.clip;
    if (r.note) notes.push(`${op.op}: ${r.note}`);
  }
  const item = job.saveAs === 'replace'
    ? await replaceSampleAudio(sample, clip)
    : await saveClipAsSample(clip, { name: job.name || `${sample.name} edit`, folderId: job.folderId === undefined ? sample.folderId ?? null : job.folderId });
  st.toast(job.saveAs === 'replace' ? `Claude edited "${sample.name}"` : `Claude saved "${item.name}"`, 'claude', 2000);
  return { sampleId: item.id, notes, duration: Math.round((clipLength(clip) / clip.sampleRate) * 1000) / 1000 };
}
