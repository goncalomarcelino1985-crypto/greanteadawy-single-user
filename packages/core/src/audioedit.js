// Sample editing on plain audio "clips": { sampleRate, channels: Float32Array[] }. Pure functions shared by the wave
// editor, Claude's edit_sample tool (run in the user's browser) and the tests. Every operation returns a NEW clip and
// never touches its input, so the editor can keep earlier clips for undo. Ranges are frames [start, end).
import { autotune, pitchShiftClip, timeStretch } from './autotune.js';
import { resampleChannels } from './resample.js';

const MAX_SECONDS = 20 * 60;

/** Number of frames in a clip. */
export const clipLength = (clip) => clip.channels[0]?.length || 0;

/** Seconds of audio in a clip. */
export const clipSeconds = (clip) => clipLength(clip) / clip.sampleRate;

/** A validated clip: 1–2 channels of the same length, finite sample rate. */
export function makeClip(channels, sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new Error('Invalid sample rate');
  if (!channels.length || channels.length > 2) throw new Error('A sample has 1 or 2 channels');
  const len = channels[0].length;
  if (channels.some((c) => c.length !== len)) throw new Error('Channels must have the same length');
  if (len / sampleRate > MAX_SECONDS) throw new Error(`Samples are limited to ${MAX_SECONDS / 60} minutes`);
  return { sampleRate, channels: channels.map((c) => (c instanceof Float32Array ? c : Float32Array.from(c))) };
}

/** Clamp a frame range to the clip (start ≤ end, integers). An empty/missing range means the whole clip. */
export function clampRange(clip, start, end) {
  const n = clipLength(clip);
  let s = Number.isFinite(start) ? Math.round(start) : 0;
  let e = Number.isFinite(end) ? Math.round(end) : n;
  s = Math.max(0, Math.min(n, s));
  e = Math.max(0, Math.min(n, e));
  if (e < s) [s, e] = [e, s];
  if (e === s && !(Number.isFinite(start) && Number.isFinite(end))) return [0, n];
  return [s, e];
}

const mapChannels = (clip, fn) => ({ sampleRate: clip.sampleRate, channels: clip.channels.map(fn) });

/** A copy of [start, end). */
export function sliceClip(clip, start, end) {
  const [s, e] = clampRange(clip, start, end);
  return mapChannels(clip, (c) => c.slice(s, e));
}

/** Keep only [start, end) (crop / trim to selection). */
export const cropClip = sliceClip;

// a few milliseconds of fade where audio is cut or joined, so edits don't click
const declickFrames = (sr) => Math.max(1, Math.round(sr * 0.002));

function declickAt(c, at, sr) {
  const n = declickFrames(sr);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    if (at - 1 - i >= 0) c[at - 1 - i] *= g;
    if (at + i < c.length) c[at + i] *= g;
  }
}

/** Remove [start, end) and close the gap (cut / delete), with a tiny fade at the join. */
export function deleteRange(clip, start, end) {
  const [s, e] = clampRange(clip, start, end);
  if (e <= s) return mapChannels(clip, (c) => c.slice());
  return mapChannels(clip, (c) => {
    const out = new Float32Array(c.length - (e - s));
    out.set(c.subarray(0, s), 0);
    out.set(c.subarray(e), s);
    if (s > 0 && s < out.length) declickAt(out, s, clip.sampleRate);
    return out;
  });
}

/** Match another clip's channel count and sample rate to `clip` (for paste). */
export function conformClip(other, clip) {
  let chans = other.channels;
  if (chans.length !== clip.channels.length) {
    if (clip.channels.length === 1) {
      const m = new Float32Array(chans[0].length);
      for (let i = 0; i < m.length; i++) m[i] = (chans[0][i] + chans[1][i]) / 2;
      chans = [m];
    } else {
      chans = [chans[0], chans[0].slice()];
    }
  }
  const conformed = { sampleRate: other.sampleRate, channels: chans };
  return other.sampleRate === clip.sampleRate ? conformed : resampleClip(conformed, clip.sampleRate / other.sampleRate, clip.sampleRate);
}

/** Insert `other` at frame `at` (paste), or replace [start, end) with it when a range is given. */
export function insertClip(clip, at, other, end) {
  const add = conformClip(other, clip);
  const [s, e] = end === undefined ? clampRange(clip, at, at) : clampRange(clip, at, end);
  const m = clipLength(add);
  return {
    sampleRate: clip.sampleRate,
    channels: clip.channels.map((c, ch) => {
      const out = new Float32Array(c.length - (e - s) + m);
      out.set(c.subarray(0, s), 0);
      out.set(add.channels[ch], s);
      out.set(c.subarray(e), s + m);
      if (s > 0) declickAt(out, s, clip.sampleRate);
      if (s + m < out.length) declickAt(out, s + m, clip.sampleRate);
      return out;
    })
  };
}

/** Apply fn(value, frameIndexInRange, rangeLength) to every sample in [start, end). */
function processRange(clip, start, end, fn) {
  const [s, e] = clampRange(clip, start, end);
  return mapChannels(clip, (c) => {
    const out = c.slice();
    for (let i = s; i < e; i++) out[i] = fn(out[i], i - s, e - s);
    return out;
  });
}

/** Silence [start, end) (with short fades at its edges). */
export function silenceRange(clip, start, end) {
  const [s, e] = clampRange(clip, start, end);
  const out = processRange(clip, s, e, () => 0);
  for (const c of out.channels) {
    if (s > 0) declickAt(c, s, clip.sampleRate);
    if (e < c.length) declickAt(c, e, clip.sampleRate);
  }
  return out;
}

const CURVES = {
  linear: (x) => x,
  exp: (x) => x * x, // slow start: a natural-sounding fade for most material
  log: (x) => Math.sqrt(x),
  scurve: (x) => 0.5 - 0.5 * Math.cos(Math.PI * x)
};

/** Fade in or out over [start, end). curve: linear | exp | log | scurve. */
export function fadeRange(clip, start, end, direction = 'in', curve = 'linear') {
  const f = CURVES[curve] || CURVES.linear;
  return processRange(clip, start, end, (v, i, n) => {
    const x = n <= 1 ? 1 : i / (n - 1);
    return v * f(direction === 'in' ? x : 1 - x);
  });
}

/** Change the level of [start, end) by `db`. */
export function gainRange(clip, start, end, db) {
  const g = Math.pow(10, db / 20);
  return processRange(clip, start, end, (v) => v * g);
}

/** Peak level (dBFS) of [start, end); -Infinity for silence. */
export function peakDb(clip, start, end) {
  const [s, e] = clampRange(clip, start, end);
  let peak = 0;
  for (const c of clip.channels) for (let i = s; i < e; i++) peak = Math.max(peak, Math.abs(c[i]));
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Scale [start, end) so its peak is `targetDb` dBFS (default -1). Silence stays silent. */
export function normalizeRange(clip, start, end, targetDb = -1) {
  const p = peakDb(clip, start, end);
  if (!Number.isFinite(p)) return mapChannels(clip, (c) => c.slice());
  return gainRange(clip, start, end, targetDb - p);
}

/** Play [start, end) backwards. */
export function reverseRange(clip, start, end) {
  const [s, e] = clampRange(clip, start, end);
  return mapChannels(clip, (c) => {
    const out = c.slice();
    for (let i = s, j = e - 1; i < j; i++, j--) { const t = out[i]; out[i] = out[j]; out[j] = t; }
    return out;
  });
}

/** Flip the polarity of [start, end). */
export const invertRange = (clip, start, end) => processRange(clip, start, end, (v) => -v);

/** Mix to one channel. */
export function toMono(clip) {
  if (clip.channels.length === 1) return mapChannels(clip, (c) => c.slice());
  const [l, r] = clip.channels;
  const m = new Float32Array(l.length);
  for (let i = 0; i < m.length; i++) m[i] = (l[i] + r[i]) / 2;
  return { sampleRate: clip.sampleRate, channels: [m] };
}

/** Two identical channels from a mono clip (a stereo clip is copied). */
export function toStereo(clip) {
  if (clip.channels.length === 2) return mapChannels(clip, (c) => c.slice());
  return { sampleRate: clip.sampleRate, channels: [clip.channels[0].slice(), clip.channels[0].slice()] };
}

/** Remove DC offset / sub-sonic rumble (one-pole high-pass at 10 Hz). */
export function removeDC(clip) {
  const R = Math.exp((-2 * Math.PI * 10) / clip.sampleRate);
  return mapChannels(clip, (c) => {
    const out = new Float32Array(c.length);
    // start settled on the first sample: an offset is removed from the start instead of decaying away (a thump)
    let x1 = c[0] || 0;
    let y1 = 0;
    for (let i = 0; i < c.length; i++) {
      const y = c[i] - x1 + R * y1;
      x1 = c[i]; y1 = y;
      out[i] = y;
    }
    return out;
  });
}

/**
 * The part of the clip above `thresholdDb` (relative to its peak), with `padMs` kept before and after.
 * Returns { start, end } frames (the whole clip when it is all silence).
 */
export function findContent(clip, thresholdDb = -50, padMs = 10) {
  const n = clipLength(clip);
  const peak = Math.pow(10, peakDb(clip) / 20);
  if (!(peak > 0)) return { start: 0, end: n };
  const th = peak * Math.pow(10, thresholdDb / 20);
  const loud = (i) => clip.channels.some((c) => Math.abs(c[i]) > th);
  let s = 0;
  while (s < n && !loud(s)) s++;
  let e = n;
  while (e > s && !loud(e - 1)) e--;
  const pad = Math.round((padMs / 1000) * clip.sampleRate);
  return { start: Math.max(0, s - pad), end: Math.min(n, e + pad) };
}

/** Trim leading and trailing silence (below thresholdDb relative to the peak), with a short fade-out at the end. */
export function trimSilence(clip, thresholdDb = -50, padMs = 10) {
  const { start, end } = findContent(clip, thresholdDb, padMs);
  const out = sliceClip(clip, start, end);
  const n = clipLength(out);
  const f = Math.min(n, Math.round(clip.sampleRate * 0.005));
  for (const c of out.channels) for (let i = 0; i < f; i++) c[n - 1 - i] *= i / f;
  return out;
}

/**
 * Resample by `ratio` (output length = input length × ratio). Used for sample-rate conversion and for "speed"
 * changes (ratio < 1 = faster and higher, like a turntable). Shrinking low-passes first so it doesn't alias.
 */
export function resampleClip(clip, ratio, sampleRate = clip.sampleRate) {
  if (!(ratio > 0)) throw new Error('ratio must be positive');
  return { sampleRate, channels: resampleChannels(clip.channels, Math.max(1, Math.round(clipLength(clip) * ratio))) };
}

/** Change the speed of [start, end) by `rate` (2 = twice as fast and an octave up), like a turntable. */
export function speedRange(clip, start, end, rate) {
  if (!(rate >= 0.25 && rate <= 4)) throw new Error('rate must be between 0.25 and 4');
  const [s, e] = clampRange(clip, start, end);
  if (e <= s) return mapChannels(clip, (c) => c.slice());
  const part = resampleClip(sliceClip(clip, s, e), 1 / rate);
  return insertClip(clip, s, part, e);
}

/** Change the length of [start, end) by `rate` (2 = half as long) keeping its pitch (WSOLA). */
export function stretchRange(clip, start, end, rate) {
  if (!(rate >= 0.25 && rate <= 4)) throw new Error('rate must be between 0.25 and 4');
  const [s, e] = clampRange(clip, start, end);
  if (e <= s) return mapChannels(clip, (c) => c.slice());
  const part = sliceClip(clip, s, e);
  return insertClip(clip, s, { sampleRate: clip.sampleRate, channels: timeStretch(part.channels, clip.sampleRate, rate) }, e);
}

/** Nearest zero crossing to `frame` (within ±maxFrames) on the first channel — edits there don't click. */
export function nearestZeroCrossing(clip, frame, maxFrames = 2000) {
  const c = clip.channels[0];
  const f = Math.max(0, Math.min(c.length - 1, Math.round(frame)));
  for (let d = 0; d <= maxFrames; d++) {
    for (const i of [f - d, f + d]) {
      if (i > 0 && i < c.length && (c[i - 1] <= 0) !== (c[i] <= 0)) return i;
    }
  }
  return f;
}

/** Min/max per column for drawing a waveform: `columns` pairs over [start, end) of channel `ch`. */
export function waveformPeaks(clip, start, end, columns, ch = 0) {
  const c = clip.channels[Math.min(ch, clip.channels.length - 1)];
  const [s, e] = clampRange(clip, start, end);
  const out = new Float32Array(Math.max(0, columns) * 2);
  const per = (e - s) / Math.max(1, columns);
  for (let x = 0; x < columns; x++) {
    const a = Math.floor(s + x * per);
    const b = Math.max(a + 1, Math.floor(s + (x + 1) * per));
    let lo = 1;
    let hi = -1;
    // long columns are sampled (every few frames) — plenty for a drawing, and fast for hour-long zoomed-out views
    const step = Math.max(1, Math.floor((b - a) / 512));
    for (let i = a; i < b && i < c.length; i += step) { const v = c[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi < lo) { lo = 0; hi = 0; }
    out[2 * x] = lo;
    out[2 * x + 1] = hi;
  }
  return out;
}

// ------------------------------------------------------------------ operations by name (edit_sample, the editor)

/** The operations edit_sample accepts, with their parameters (times in seconds; omit start/end = whole sample). */
export const EDIT_OPS = {
  trim: 'keep only start..end',
  delete: 'remove start..end and close the gap',
  silence: 'silence start..end',
  fade_in: 'fade in from start to end (end alone sets the length from the beginning; without end: 10 ms); curve linear|exp|log|scurve',
  fade_out: 'fade out from start to end (start alone fades out to the end; without start: the last 10 ms); curve',
  gain: 'change the level of start..end by db',
  normalize: 'scale start..end so its peak is peakDb (default -1 dBFS)',
  reverse: 'play start..end backwards',
  invert: 'flip polarity',
  mono: 'mix to mono',
  stereo: 'make a mono sample two-channel',
  remove_dc: 'remove DC offset / rumble below 10 Hz',
  trim_silence: 'cut silence (below thresholdDb, default -50) from both ends',
  speed: 'change speed and pitch together by rate 0.25-4 (turntable style)',
  stretch: 'change the length by rate 0.25-4 keeping the pitch (2 = twice as fast)',
  pitch_shift: 'shift pitch by semitones keeping the length (best on voice and solo instruments)',
  pitch_correct: 'auto-tune: snap the melody to key/scale (amount 0-1, speed in ms, flatten 0-1); with start..end, the notes that touch that range'
};

/**
 * Apply one named operation (as Claude's edit_sample sends it) to a clip. Times are seconds; returns
 * { clip, note } where note describes what happened (e.g. how many notes were corrected). Throws when the result would
 * be empty or longer than the 20-minute limit.
 */
export function applyEdit(clip, op) {
  // speed and stretch can make a sample much longer: refuse before doing the work
  if ((op.op === 'speed' || op.op === 'stretch') && op.rate > 0) {
    const sr = clip.sampleRate;
    const len = clipLength(clip);
    const [s, e] = clampRange(clip, Number.isFinite(op.start) ? op.start * sr : undefined, Number.isFinite(op.end) ? op.end * sr : undefined);
    const est = (len - (e - s) + (e - s) / op.rate) / sr;
    if (est > MAX_SECONDS) throw new Error(`${op.op}: the result would be ${(est / 60).toFixed(1)} minutes long; samples are limited to ${MAX_SECONDS / 60} minutes`);
  }
  const r = runEdit(clip, op);
  const n = clipLength(r.clip);
  if (!n) throw new Error(`${op.op}: that would leave the sample empty — choose a range that keeps some audio`);
  if (n / r.clip.sampleRate > MAX_SECONDS) throw new Error(`${op.op}: the result would be ${(n / r.clip.sampleRate / 60).toFixed(1)} minutes long; samples are limited to ${MAX_SECONDS / 60} minutes`);
  return r;
}

function runEdit(clip, op) {
  const sr = clip.sampleRate;
  const len = clipLength(clip);
  const fr = (sec, dflt) => (Number.isFinite(sec) ? Math.round(sec * sr) : dflt);
  const s = fr(op.start, 0);
  const e = fr(op.end, len);
  if (s > len || (Number.isFinite(op.start) && Number.isFinite(op.end) && e <= s)) throw new Error(`${op.op}: start..end is outside the sample (it is ${(len / sr).toFixed(2)} s long)`);
  switch (op.op) {
    case 'trim': return { clip: cropClip(clip, s, e) };
    case 'delete': return { clip: deleteRange(clip, s, e) };
    case 'silence': return { clip: silenceRange(clip, s, e) };
    case 'fade_in': return { clip: fadeRange(clip, s, Number.isFinite(op.end) ? e : Math.min(len, s + Math.round(sr * 0.01)), 'in', op.curve) };
    case 'fade_out': return { clip: fadeRange(clip, Number.isFinite(op.start) ? s : Math.max(0, e - Math.round(sr * 0.01)), e, 'out', op.curve) };
    case 'gain': {
      if (!Number.isFinite(op.db) || Math.abs(op.db) > 48) throw new Error('gain needs db between -48 and 48');
      return { clip: gainRange(clip, s, e, op.db) };
    }
    case 'normalize': return { clip: normalizeRange(clip, s, e, Number.isFinite(op.peakDb) ? Math.min(0, op.peakDb) : -1) };
    case 'reverse': return { clip: reverseRange(clip, s, e) };
    case 'invert': return { clip: invertRange(clip, s, e) };
    case 'mono': return { clip: toMono(clip) };
    case 'stereo': return { clip: toStereo(clip) };
    case 'remove_dc': return { clip: removeDC(clip) };
    case 'trim_silence': {
      const out = trimSilence(clip, Number.isFinite(op.thresholdDb) ? op.thresholdDb : -50);
      return { clip: out, note: `trimmed to ${(clipLength(out) / sr).toFixed(2)} s` };
    }
    case 'speed': return { clip: speedRange(clip, s, e, op.rate) };
    case 'stretch': return { clip: stretchRange(clip, s, e, op.rate) };
    case 'pitch_shift': {
      if (!Number.isFinite(op.semitones) || Math.abs(op.semitones) > 24) throw new Error('pitch_shift needs semitones between -24 and 24');
      return { clip: pitchShiftClip(clip, s, e, op.semitones) };
    }
    case 'pitch_correct': {
      const r = autotune(clip, { key: op.key, scale: op.scale, amount: op.amount, speedMs: op.speed, flatten: op.flatten, start: s, end: e });
      const n = r.notes.length;
      return { clip: r.clip, note: n ? `${n} note${n === 1 ? '' : 's'} tuned to ${r.scaleLabel} (largest move ${r.maxMove.toFixed(2)} semitones)` : 'no melody found (pitch correction needs a solo voice or instrument)' };
    }
    default: throw new Error(`Unknown edit "${op.op}". Use: ${Object.keys(EDIT_OPS).join(', ')}`);
  }
}
