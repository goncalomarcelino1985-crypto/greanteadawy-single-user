// Pitch tracking, note detection and pitch correction for monophonic audio (vocals, solo instruments), plus pitch
// shifting and time stretching. Pure JS — the wave editor runs it in a worker, Claude's edit_sample in the user's
// browser, the tests in Node.
//
//   trackPitch   YIN pitch per 5 ms frame (on a copy decimated to about 12–22 kHz: plenty for voice, less work)
//   findNotes    voiced frames → notes (split on gaps and on lasting pitch jumps; vibrato stays one note)
//   correctionCurve  per-frame shift in semitones: each note moves from its centre to its target (auto = nearest
//                note of the key/scale, or set by hand); `speed` glides into it, `flatten` irons out vibrato/drift
//   psola        TD-PSOLA resynthesis: one-period grains around pitch marks, re-spaced for the new pitch (formants
//                stay put, so a corrected voice still sounds like the singer)
//   timeStretch  WSOLA: length changes, pitch doesn't (for pitch shifting chords/drums: resample + stretch)
import { SCALES, parsePitchClass } from './music.js';
import { resampleChannels } from './resample.js';

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

const mixMono = (channels) => {
  if (channels.length === 1) return channels[0];
  const m = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < m.length; i++) m[i] += c[i] / channels.length;
  return m;
};

/** Low-pass (windowed sinc) and keep every D-th sample. */
function decimate(x, D) {
  const taps = 8 * D + 1;
  const mid = (taps - 1) / 2;
  const cut = 0.45 / D;
  const h = new Float32Array(taps);
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const t = k - mid;
    h[k] = (t === 0 ? 2 * cut : Math.sin(2 * Math.PI * cut * t) / (Math.PI * t)) * (0.54 - 0.46 * Math.cos((2 * Math.PI * k) / (taps - 1)));
    sum += h[k];
  }
  const n = Math.floor(x.length / D);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i * D;
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const j = c + k - mid;
      if (j >= 0 && j < x.length) acc += h[k] * x[j];
    }
    y[i] = acc / sum;
  }
  return y;
}

/**
 * Pitch per frame (YIN). Returns { hop (seconds between frames), hz (0 = unvoiced/silent), conf (0..1), rms, gate (the
 * rms below which a frame counts as silence) }.
 * opts: minHz (60), maxHz (1100), hopSec (0.005), threshold (0.15), gateDb (frames this far under the loudest are
 * treated as silence, default -45).
 */
export function trackPitch(x, sampleRate, { minHz = 60, maxHz = 1100, hopSec = 0.005, threshold = 0.15, gateDb = -45 } = {}) {
  const D = Math.max(1, Math.round(sampleRate / 16000));
  const y = D > 1 ? decimate(x, D) : x;
  const fs = sampleRate / D;
  const tauMin = Math.max(2, Math.floor(fs / maxHz));
  const tauMax = Math.ceil(fs / minHz);
  const W = Math.max(Math.round(fs * 0.025), tauMax + 1);
  const hop = Math.max(1, Math.round(fs * hopSec));
  const frames = Math.max(1, Math.ceil(y.length / hop));
  const hz = new Float32Array(frames);
  const conf = new Float32Array(frames);
  const rms = new Float32Array(frames);
  const d = new Float32Array(tauMax + 2);
  const dp = new Float32Array(tauMax + 2);
  const span = W + tauMax;
  let lead = 0;
  let tail = 0;
  for (let f = 0; f < frames; f++) {
    // the window around this frame's time, shifted inside the signal at the edges
    const s = Math.max(0, Math.min(y.length - span, f * hop - (span >> 1)));
    if (s < 0 || y.length < span) continue;
    // within half a window of the clip's edges the window can't be centred on the frame: several frames would read
    // the same window (a fake steady pitch): leave them unvoiced (`edges` counts them; see holdEdges)
    if (Math.abs(s + (span >> 1) - f * hop) > hop) {
      if (2 * f < frames) lead = f + 1;
      else if (!tail) tail = frames - f;
      continue;
    }
    let e = 0;
    for (let j = 0; j < W; j++) e += y[s + j] * y[s + j];
    rms[f] = Math.sqrt(e / W);
    if (rms[f] < 1e-5) continue;
    for (let tau = 1; tau <= tauMax; tau++) {
      let acc = 0;
      for (let j = 0; j < W; j++) { const v = y[s + j] - y[s + j + tau]; acc += v * v; }
      d[tau] = acc;
    }
    // cumulative mean normalised difference
    dp[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; dp[tau] = run > 0 ? (d[tau] * tau) / run : 1; }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (dp[t] < threshold) {
        while (t + 1 <= tauMax && dp[t + 1] < dp[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // no clear dip: accept the best one only when it is still fairly periodic
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (dp[t] < dp[best]) best = t;
      if (dp[best] < 0.35) tau = best;
    }
    if (tau < 0) continue;
    // parabolic interpolation around the dip for sub-sample (≈ cent) precision
    let ref = tau;
    if (tau > 1 && tau < tauMax) {
      const a = dp[tau - 1];
      const b = dp[tau];
      const c = dp[tau + 1];
      const den = a - 2 * b + c;
      if (den > 0) ref = tau + (0.5 * (a - c)) / den;
    }
    hz[f] = fs / ref;
    conf[f] = Math.max(0, 1 - dp[tau]);
  }
  // silence gate relative to the loudest frame
  let top = 0;
  for (let f = 0; f < frames; f++) top = Math.max(top, rms[f]);
  const gate = top * Math.pow(10, gateDb / 20);
  for (let f = 0; f < frames; f++) if (rms[f] < gate) { hz[f] = 0; conf[f] = 0; }
  fixOctaveJumps(hz);
  return { hop: hop / fs, hz, conf, rms, gate, sampleRate, edges: [lead, tail] };
}

/**
 * The track with the frames at the clip's edges (no window could be centred on them, so trackPitch left them unvoiced)
 * holding the pitch next to them — for shifting audio that starts or ends on a sung note. Note detection keeps them
 * unvoiced.
 */
export function holdEdges(track) {
  const [lead = 0, tail = 0] = track.edges || [];
  const n = track.hz.length;
  if ((!lead && !tail) || lead + tail >= n) return track;
  const hz = Float32Array.from(track.hz);
  if (hz[lead] > 0) hz.fill(hz[lead], 0, lead);
  if (tail && hz[n - tail - 1] > 0) hz.fill(hz[n - tail - 1], n - tail);
  return { ...track, hz };
}

/**
 * Octave slips (a typical YIN error) are folded back when the frames on BOTH sides agree on the other octave — judged
 * on the original values, so a real octave leap is never "corrected" frame by frame into the old octave.
 */
function fixOctaveJumps(hz) {
  const n = hz.length;
  const orig = Float32Array.from(hz);
  const side = (f, from, to) => {
    const v = [];
    for (let k = from; k <= to; k++) if (f + k >= 0 && f + k < n && orig[f + k]) v.push(orig[f + k]);
    return v.length ? v.sort((a, b) => a - b)[v.length >> 1] : 0;
  };
  for (let f = 0; f < n; f++) {
    if (!orig[f]) continue;
    const before = side(f, -3, -1);
    const after = side(f, 1, 3);
    if (!before && !after) { hz[f] = 0; continue; } // a lone blip
    if (!before || !after) continue;
    const cb = 1200 * Math.log2(orig[f] / before);
    const ca = 1200 * Math.log2(orig[f] / after);
    if (Math.abs(cb - 1200) < 80 && Math.abs(ca - 1200) < 80) hz[f] = orig[f] / 2;
    else if (Math.abs(cb + 1200) < 80 && Math.abs(ca + 1200) < 80) hz[f] = orig[f] * 2;
  }
}

const median = (arr) => {
  const s = Float64Array.from(arr).sort();
  return s.length ? s[s.length >> 1] : NaN;
};

/**
 * Notes from a pitch track, in two passes over each voiced run (runs split at gaps longer than `gapSec`):
 *  1. a cut wherever the pitch is steady (spread ≤ `steadySemis`) for `steadySec` on both sides of a jump of at least
 *     `jumpSemis` — precise boundaries, also in fast runs of short notes. Vibrato and scoops are never steady on both
 *     sides of a jump. A leap of `leapSemis` or more (wider than any vibrato) needs no steady stretch, only each side
 *     holding its level.
 *  2. away from those, the pitch smoothed over `smoothSec` (one cycle of a 4 Hz vibrato; faster vibrato averages out
 *     even more) is cut at the strongest points where it moved more than `splitSemis` across that window — legato
 *     steps and glides between notes with vibrato. Only where both averages cover a whole window, so a scoop into a
 *     note (or a fall at its end) stays part of it.
 * A cut between two stretches whose pitches differ by less than `mergeSemis`, or that sweep over the same pitch range,
 * is dropped again (the halves of a very wide vibrato), and so are the cuts between the swings of a vibrato
 * (joinVibrato) and the ones that cut a lone swing, a scoop or a fall off its note (joinEdges).
 * Tested on synthetic tracks and synthesised voices: regular vibrato 3.5–8 Hz of ±0.3–1.2 semitones, scoops and falls
 * of 1–3 semitones, legato with 20–60 ms slides, runs of 100–300 ms notes, glides. A semitone trill sung with slow
 * slides looks like a vibrato and stays one note; a short passing note right after a note with a wide vibrato can be
 * missed. Anything it gets wrong can be joined or split by hand in the pitch editor.
 * Notes shorter than `minSec` are left alone. Each note: { id, start, end (frames, end exclusive), startSec, endSec,
 * center (MIDI, the median without the slides at its ends), target (MIDI, = center until snapped or moved) }.
 */
export function findNotes(track, { minSec = 0.06, splitSemis = 0.4, gapSec = 0.03, smoothSec = 0.25, jumpSemis = 0.6, steadySec = 0.03, steadySemis = 0.15, mergeSemis = 0.35, calmFrames = 5, transitionSec = 0.08, persistSec = 0.12, holdGap = 1, holdRatio = 0.2, leapSemis = 3.5 } = {}) {
  const { hz, hop } = track;
  const n = hz.length;
  const midi = new Float32Array(n).fill(NaN);
  for (let f = 0; f < n; f++) if (hz[f] > 0) midi[f] = hzToMidi(hz[f]);
  const gapFrames = Math.max(1, Math.round(gapSec / hop));
  const minFrames = Math.max(1, Math.round(minSec / hop));
  const h = Math.max(1, Math.round(smoothSec / 2 / hop));
  // voiced runs (short unvoiced gaps inside a run are bridged)
  const runs = [];
  let start = -1;
  let last = -1;
  for (let f = 0; f < n; f++) {
    if (Number.isNaN(midi[f])) continue;
    if (start >= 0 && f - last - 1 > gapFrames) { runs.push([start, last + 1]); start = -1; }
    if (start < 0) start = f;
    last = f;
  }
  if (start >= 0) runs.push([start, last + 1]);
  const segments = [];
  const med = (s, e) => median(midi.subarray(s, e).filter((v) => v === v));
  // the 10th–90th percentile pitch range of frames [s, e), without 15 ms at each end (the tails of transitions)
  const trim = Math.round(0.015 / hop);
  const spread = (s, e) => {
    if (e - s > 4 * trim) { s += trim; e -= trim; }
    const v = Float64Array.from(midi.subarray(s, e).filter((x) => x === x)).sort();
    return v.length ? [v[Math.floor(v.length * 0.1)], v[Math.min(v.length - 1, Math.floor(v.length * 0.9))]] : [NaN, NaN];
  };
  // neighbours that sweep over the same pitch range are one note: the pieces of a very wide vibrato do, two notes
  // (even with vibrato) mostly don't
  const sweepSame = (a0, c, b1) => {
    const [l0, l1] = spread(a0, c);
    const [r0, r1] = spread(c, b1);
    const overlap = Math.min(l1, r1) - Math.max(l0, r0);
    return overlap > 0.7 * Math.max(0.2, Math.min(l1 - l0, r1 - r0));
  };
  // for judging "steady": a running median of `calmFrames` frames takes out frame-to-frame jitter of the tracker
  const calm = runningMedian(midi, calmFrames);
  for (const [a, b] of runs) {
    // precise cuts between steady stretches first; slow-pitch cuts only where none of those is near
    const jumps = jumpCuts(calm, a, b, minFrames, Math.max(2, Math.round(steadySec / hop)), jumpSemis, steadySemis, Math.max(2, Math.round(transitionSec / 2 / hop)), Math.round(persistSec / hop), holdGap, holdRatio, leapSemis);
    const steps = stepCuts(midi, a, b, h, minFrames, splitSemis).filter((c) => !jumps.some((j) => Math.abs(j - c) <= h));
    // a cut between two stretches sung at (nearly) the same pitch was a wide vibrato, not a note change; the sweep
    // test looks at the pieces as first cut (merged pieces would sweep over several notes)
    const first = [a, ...[...jumps, ...steps].sort((x, y) => x - y), b];
    let cuts = first.slice(1, -1).filter((c, k) => !sweepSame(first[k], c, first[k + 2]));
    cuts = joinEdges(joinVibrato(cuts, a, b, med, spread, hop, VIB), a, b, midi, med, spread, hop, VIB);
    for (let changed = true; changed;) {
      changed = false;
      const bounds = [a, ...cuts, b];
      for (let k = 1; k + 1 < bounds.length && !changed; k++) {
        if (Math.abs(med(bounds[k - 1], bounds[k]) - med(bounds[k], bounds[k + 1])) < mergeSemis) {
          cuts = cuts.filter((x) => x !== bounds[k]);
          changed = true;
        }
      }
    }
    let from = a;
    for (const c of cuts) {
      if (c - from < minFrames || b - c < minFrames) continue;
      segments.push([from, c, from > a, true]);
      from = c;
    }
    segments.push([from, b, from > a, false]);
  }
  const notes = [];
  for (const [s, e, slideIn, slideOut] of segments) {
    if (e - s < minFrames) continue;
    const center = noteCenter(track, s, e, { slideIn, slideOut });
    if (Number.isFinite(center)) notes.push({ start: s, end: e, center, target: center });
  }
  return notes.map((x, i) => ({ id: i + 1, ...x, startSec: x.start * hop, endSec: x.end * hop }));
}

/**
 * The pitch sung over frames [start, end) (MIDI, the median): without the slide into it from the note before or out of
 * it into the next one (`slideIn` / `slideOut`: up to 30 ms, at most a fifth of a short note). A note's free ends (a
 * scoop from nowhere, a fall into silence) count in full.
 */
export function noteCenter(track, start, end, { slideIn = false, slideOut = false } = {}) {
  const t = Math.min(Math.round(0.03 / track.hop), Math.floor((end - start) / 5));
  const v = [];
  for (let f = start + (slideIn ? t : 0); f < end - (slideOut ? t : 0); f++) if (track.hz[f] > 0) v.push(hzToMidi(track.hz[f]));
  return median(v);
}

// Telling a vibrato's swings from notes: half-cycles of 2–14 Hz, a turning point that moves less than a semitone
// (a sung trill moves a whole one), levels that repeat, pieces that are not flat.
const VIB = { minSec: 0.035, maxSec: 0.25, level: 0.3, maxStep: 0.95, flat: 0.15, minInner: 2, edge: 0.05, swingRange: 2.6, slowRange: 1, swingSpread: 0.1, glideSec: 0.12, glideSpread: 0.4 };

/**
 * A vibrato that the cuts took apart: pieces that are each a turning point (both neighbours on the same side, less
 * than `maxStep` away), a plausible half-cycle long and not flat, alternating between two levels (every other one
 * within `level`). With at least `minInner` of them in a row (a whole cycle), they and the pieces on either side (when
 * those lie between the levels) are one note. A trill sung with clean steps has flat pieces and stays apart.
 */
function joinVibrato(cuts, a, b, med, spread, hop, o) {
  const bounds = [a, ...cuts, b];
  const P = bounds.length - 1;
  if (P < o.minInner + 2) return cuts;
  const m = [];
  for (let k = 0; k < P; k++) m.push(med(bounds[k], bounds[k + 1]));
  const step = (k) => m[k + 1] - m[k];
  const turn = (q) => {
    if (q < 1 || q > P - 2) return false;
    const s0 = step(q - 1);
    const s1 = step(q);
    if (Math.sign(s0) !== -Math.sign(s1) || Math.abs(s0) > o.maxStep || Math.abs(s1) > o.maxStep) return false;
    const sec = (bounds[q + 1] - bounds[q]) * hop;
    if (sec < o.minSec || sec > o.maxSec) return false;
    const [lo, hi] = spread(bounds[q], bounds[q + 1]);
    return hi - lo >= (o.flat * (Math.abs(s0) + Math.abs(s1))) / 2;
  };
  const drop = new Set();
  for (let q = 1; q < P - 1;) {
    if (!turn(q)) { q++; continue; }
    let r = q;
    while (turn(r + 1) && (r - 1 < q || Math.abs(m[r + 1] - m[r - 1]) <= o.level)) r++;
    if (r - q + 1 >= o.minInner) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = q; t <= r; t++) { lo = Math.min(lo, m[t]); hi = Math.max(hi, m[t]); }
      const between = (t) => m[t] >= lo - o.level && m[t] <= hi + o.level;
      const from = between(q - 1) ? q - 1 : q;
      const to = between(r + 1) ? r + 1 : r;
      for (let t = from + 1; t <= to; t++) drop.add(bounds[t]);
    }
    q = r + 1;
  }
  return drop.size ? cuts.filter((c) => !drop.has(c)) : cuts;
}

/**
 * Short pieces that belong to the note next to them: a lone half-cycle of vibrato (before a transition, or at the end)
 * whose pitch lies within the range the note's own vibrato covers, and a short glide at either end of a run (a scoop
 * into the note, a fall off it) that is never steady.
 */
function joinEdges(cuts, a, b, midi, med, spread, hop, o) {
  // how far a stretch's pitch moves once a vibrato cycle is averaged out (p10–p90 of a 250 ms running mean, where the
  // whole window fits): about 0 for one note with any vibrato, the interval for notes a missed cut left together
  const h = Math.round(0.125 / hop);
  const slowRange = (s, e) => {
    if (e - s < 4 * h) return null;
    const v = [];
    let sum = 0;
    let cnt = 0;
    for (let f = s; f < s + 2 * h; f++) if (midi[f] === midi[f]) { sum += midi[f]; cnt++; }
    for (let f = s + h; f < e - h; f++) {
      if (cnt) v.push(sum / cnt);
      const add = f + h;
      const out = f - h;
      if (add < e && midi[add] === midi[add]) { sum += midi[add]; cnt++; }
      if (out >= s && midi[out] === midi[out]) { sum -= midi[out]; cnt--; }
    }
    v.sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length * 0.9)] - v[Math.floor(v.length * 0.1)] : null;
  };
  for (let changed = true; changed;) {
    changed = false;
    const bounds = [a, ...cuts, b];
    const len = (q) => bounds[q + 1] - bounds[q];
    for (let k = 0; k + 2 < bounds.length && !changed; k++) {
      for (const [q, nb] of [[k, k + 1], [k + 1, k]]) {
        if (len(q) * hop > o.maxSec || len(nb) < 2 * len(q)) continue;
        const [lo, hi] = spread(bounds[nb], bounds[nb + 1]);
        const mq = med(bounds[q], bounds[q + 1]);
        const [qlo, qhi] = spread(bounds[q], bounds[q + 1]);
        // a swing: the neighbour looks like one note with a vibrato (not several notes a missed cut left together), and
        // the piece itself isn't steady (a steady piece is a note of its own)
        const slow = slowRange(bounds[nb], bounds[nb + 1]);
        const oneNote = slow === null ? hi - lo <= o.swingRange : slow <= o.slowRange;
        const swing = oneNote && qhi - qlo >= o.swingSpread * (hi - lo) && mq >= lo - o.edge && mq <= hi + o.edge;
        // a glide: judged on the middle half of its pitches (a steady note's few transition frames don't count)
        const v = Float64Array.from(midi.subarray(bounds[q], bounds[q + 1]).filter((x) => x === x)).sort();
        const iqr = v.length ? v[Math.floor(v.length * 0.75)] - v[Math.floor(v.length * 0.25)] : 0;
        const glide = (q === 0 || q === bounds.length - 2) && len(q) * hop <= o.glideSec && iqr >= o.glideSpread * Math.abs(mq - med(bounds[nb], bounds[nb + 1]));
        if (glide || swing) {
          cuts = cuts.filter((x) => x !== bounds[k + 1]);
          changed = true;
          break;
        }
      }
    }
  }
  return cuts;
}

/** Running median over `k` frames (odd; NaN frames are skipped, a NaN centre stays NaN). */
function runningMedian(x, k) {
  if (k <= 1) return x;
  const h = k >> 1;
  const out = new Float32Array(x.length);
  const buf = [];
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== x[i]) { out[i] = NaN; continue; }
    buf.length = 0;
    for (let j = i - h; j <= i + h; j++) if (j >= 0 && j < x.length && x[j] === x[j]) buf.push(x[j]);
    buf.sort((p, q) => p - q);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

/** Pass 2 of findNotes: cuts (absolute frames) where the slow pitch steps by more than `thr` across ±h frames. */
function stepCuts(midi, a, b, h, minFrames, thr) {
  const len = b - a;
  const sum = new Float64Array(len + 1);
  const cnt = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) {
    const v = midi[a + i];
    const ok = v === v;
    sum[i + 1] = sum[i] + (ok ? v : 0);
    cnt[i + 1] = cnt[i] + (ok ? 1 : 0);
  }
  const slow = (i) => {
    const lo = Math.max(0, Math.min(len - 1, i) - h);
    const hi = Math.min(len, Math.max(0, i) + h + 1);
    const c = cnt[hi] - cnt[lo];
    return c ? (sum[hi] - sum[lo]) / c : NaN;
  };
  // only where both averages see a whole window: a part-window at a run's edge doesn't average vibrato out
  const step = new Float32Array(len);
  for (let i = 2 * h; i <= len - 2 * h - 1; i++) {
    const d = slow(i + h) - slow(i - h);
    step[i] = d === d ? Math.abs(d) : 0;
  }
  const cuts = [];
  // a peak needs computed neighbours (the first and last computed frames can't be one)
  for (let i = 2 * h + 1; i < len - 2 * h - 1; i++) {
    if (step[i] < thr) continue;
    let peak = true;
    for (let k = 1; k <= h && peak; k++) if (step[i - k] > step[i] || (i + k < len && step[i + k] >= step[i])) peak = false;
    if (peak && (!cuts.length || a + i - cuts[cuts.length - 1] >= minFrames)) cuts.push(a + i);
  }
  return cuts;
}

/** Pass 1 of findNotes: cuts in [a, b) at jumps of ≥ `jump` semitones between two steady stretches of `w` frames. */
function jumpCuts(midi, a, b, minFrames, w, jump, spread, maxGap, persist, minGap = 3, holdRatio = 0.3, big = 0) {
  if (b - a < 2 * minFrames) return [];
  const steady = (s, e) => {
    if (s < a || e > b) return null;
    const v = [];
    for (let i = s; i < e; i++) if (midi[i] === midi[i]) v.push(midi[i]);
    if (v.length < 0.7 * (e - s)) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
    return hi - lo <= spread ? median(v) : null;
  };
  // a jump at i: steady stretches of `w` frames before and after a transition zone of up to 2 × maxGap frames (a sung
  // glide, or the frames the tracker loses or smears while the pitch moves). The narrowest zone that works counts.
  const med = (s, e) => {
    const v = [];
    for (let i = Math.max(a, s); i < Math.min(b, e); i++) if (midi[i] === midi[i]) v.push(midi[i]);
    return v.length ? median(v) : NaN;
  };
  const score = new Float32Array(b - a);
  const leapAt = new Uint8Array(b - a); // candidates found by the leap rule
  for (let i = a + minFrames; i <= b - minFrames; i++) {
    for (let g = 2; g <= maxGap; g++) {
      const L = steady(i - g - w, i - g);
      if (L === null) continue;
      const R = steady(i + g, i + g + w);
      if (R === null) continue;
      if (Math.abs(R - L) < jump) break;
      // the new pitch must hold on (a vibrato's peak and trough are steady for a moment, but the pitch comes back):
      // over `persist` frames on each side, the median stays near that side's level
      if (g > minGap) {
        const d = Math.abs(R - L);
        // at least 1.5 × the spacing of the two stretches: if they were a vibrato's peak and trough, that spacing is
        // half its cycle, and the pitch is seen coming back
        const p = Math.max(persist, Math.round(1.5 * (2 * g + w)));
        if (!(Math.abs(med(i + g, i + g + p) - R) < holdRatio * d && Math.abs(med(i - g - p, i - g) - L) < holdRatio * d)) break;
      }
      score[i - a] = Math.abs(R - L);
      break;
    }
    // a leap wider than any vibrato needs no steady stretch on either side (vibrato on both notes, short notes): the
    // median of each side's `w` frames, each side holding its level for `persist` frames
    for (let g = 2; big && !score[i - a] && g <= maxGap; g++) {
      if (i - g - persist < a || i + g + persist > b) break;
      const L = med(i - g - w, i - g);
      const R = med(i + g, i + g + w);
      const d = Math.abs(R - L);
      if (!(d >= big)) continue;
      // … and the levels held differ by the leap too — unless the pitch doesn't come back to the other level within
      // the next stretch (a very wide vibrato's halves keep swapping; a smaller step whose sides only look a leap apart
      // because of vibrato or a scoop stays where it went)
      const PR = med(i + g, i + g + persist);
      const PL = med(i - g - persist, i - g);
      const back = (x, y) => Number.isFinite(x) && Math.abs(x - y) < 0.25 * d;
      const comesBack = back(med(i + g + persist, i + g + 2 * persist), PL) || back(med(i - g - 2 * persist, i - g - persist), PR);
      if (Math.abs(PR - R) < 0.25 * d && Math.abs(PL - L) < 0.25 * d && (Math.abs(PR - PL) >= big || !comesBack)) { score[i - a] = d; leapAt[i - a] = 1; }
      break;
    }
  }
  // each run of candidates is one transition: cut in its middle. The leap rule's candidates can come in pieces (its
  // windows move through vibrato): a gap of up to `bridge` frames next to one of them doesn't split the run (a wider
  // one would join the transitions of fast runs).
  const cuts = [];
  let prev = a;
  const bridge = 2;
  for (let i = a; i < b; i++) {
    if (!score[i - a]) continue;
    let j = i;
    for (;;) {
      if (j + 1 < b && score[j + 1 - a]) { j++; continue; }
      let t = j + 2;
      while (t <= j + bridge + 1 && t < b && !score[t - a]) t++;
      if (t <= j + bridge + 1 && t < b && (leapAt[j - a] || leapAt[t - a])) { j = t; continue; }
      break;
    }
    const c = Math.round((i + j) / 2);
    if (c - prev >= minFrames && b - c >= minFrames) { cuts.push(c); prev = c; }
    i = j;
  }
  return cuts;
}

/** A function snapping a MIDI pitch to the nearest note of key/scale (scale "chromatic" or missing = semitones). */
export function scaleSnapper(key = 'C', scale = 'chromatic') {
  if (!scale || scale === 'chromatic') return (m) => Math.round(m);
  const steps = Object.hasOwn(SCALES, scale) ? SCALES[scale] : null;
  if (!steps) throw new Error(`Unknown scale "${scale}". Known: chromatic, ${Object.keys(SCALES).join(', ')}`);
  const root = parsePitchClass(key);
  if (root === null || root === undefined) throw new Error(`Invalid key "${key}"`);
  const pcs = steps.map((s) => (root + s) % 12);
  return (m) => {
    let best = Math.round(m);
    let bd = Infinity;
    for (const pc of pcs) {
      const c = pc + 12 * Math.round((m - pc) / 12);
      const dd = Math.abs(c - m);
      if (dd < bd - 1e-9) { bd = dd; best = c; }
    }
    return best;
  };
}

/** Set every note's target to the nearest note of key/scale (keeps `locked` notes the user placed by hand). */
export function snapNotes(notes, key, scale) {
  const snap = scaleSnapper(key, scale);
  return notes.map((n) => (n.locked ? n : { ...n, target: snap(n.center) }));
}

/**
 * Shift (semitones) per frame that moves each note from its centre to its target.
 *   amount   0..1 — how far notes move (0.5 = halfway)
 *   speedMs  how long a note takes to reach its target after it starts (0 = instantly: the robotic effect); the
 *            start of a note after a pause begins at the sung pitch, legato notes glide from the previous one
 *   flatten  0..1 — how much of the vibrato and drift inside a note is ironed out (1 = dead straight)
 */
export function correctionCurve(track, notes, { amount = 1, speedMs = 50, flatten = 0 } = {}) {
  const { hz, hop } = track;
  const out = new Float32Array(hz.length);
  const alpha = speedMs > 0 ? 1 - Math.exp(-(hop * 1000) / speedMs) : 1;
  const amt = Math.max(0, Math.min(1, amount));
  const flat = Math.max(0, Math.min(1, flatten));
  let step = 0;
  let prevEnd = -Infinity;
  for (const note of [...notes].sort((x, y) => x.start - y.start)) {
    if (note.bypass || !Number.isFinite(note.target) || !Number.isFinite(note.center)) {
      // a note left alone ends any glide: the next one starts from its own pitch
      step = 0;
      prevEnd = note.end;
      continue;
    }
    // after a pause the note starts at the sung pitch; legato notes (gap ≤ 60 ms) glide on from the last offset
    if ((note.start - prevEnd) * hop > 0.06) step = 0;
    const want = note.target - note.center;
    for (let f = note.start; f < note.end && f < out.length; f++) {
      step += (want - step) * alpha;
      let s = step;
      if (hz[f] > 0 && flat > 0) s -= flat * (hzToMidi(hz[f]) - note.center);
      out[f] = amt * s;
    }
    prevEnd = note.end;
  }
  return out;
}

/** The corrected pitch per frame (MIDI, NaN where unvoiced) — what the editor draws over the detected curve. */
export function correctedPitch(track, shifts) {
  const out = new Float32Array(track.hz.length);
  for (let f = 0; f < out.length; f++) out[f] = track.hz[f] > 0 ? hzToMidi(track.hz[f]) + shifts[f] : NaN;
  return out;
}

/**
 * TD-PSOLA: shift the pitch of channels by `shifts` (semitones per track frame) keeping length and formants.
 * Pitch marks are placed one period apart on the waveform's peaks in voiced frames (5 ms grains elsewhere); each
 * output mark takes the grain of the nearest input mark, two periods long and Hann-windowed, and output marks are
 * spaced by the new period. Where grains overlap more than once the sum is normalised, so density changes don't pump.
 */
export function psola(channels, sampleRate, track, shifts) {
  const len = channels[0].length;
  let any = false;
  for (let f = 0; f < shifts.length; f++) if (Math.abs(shifts[f]) > 1e-4) { any = true; break; }
  if (!any) return channels.map((c) => c.slice());
  const mono = mixMono(channels);
  const hopS = track.hop * sampleRate;
  const frameAt = (t) => Math.max(0, Math.min(track.hz.length - 1, Math.round(t / hopS)));
  const U = Math.max(16, Math.round(sampleRate * 0.005));
  // analysis pitch marks
  const marks = [];
  let t = 0;
  let prevVoiced = false;
  while (t < len) {
    const f = frameAt(t);
    const h = track.hz[f];
    if (h > 0) {
      const P = sampleRate / h;
      const w = Math.max(1, Math.round(P * (prevVoiced ? 0.2 : 0.5)));
      let best = Math.round(t);
      let bv = -Infinity;
      for (let i = Math.max(0, Math.round(t) - w); i <= Math.min(len - 1, Math.round(t) + w); i++) if (mono[i] > bv) { bv = mono[i]; best = i; }
      if (marks.length && best <= marks[marks.length - 1].pos) best = marks[marks.length - 1].pos + 1;
      marks.push({ pos: best, P });
      t = best + P;
      prevVoiced = true;
    } else {
      marks.push({ pos: Math.round(t), P: 0 });
      t = Math.round(t) + U;
      prevVoiced = false;
    }
  }
  const out = channels.map(() => new Float32Array(len));
  const wsum = new Float32Array(len);
  let mi = 0;
  let tOut = marks.length ? marks[0].pos : 0;
  while (tOut < len) {
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1].pos - tOut) <= Math.abs(marks[mi].pos - tOut)) mi++;
    const m = marks[mi];
    const f = frameAt(tOut);
    const voiced = m.P > 0 && track.hz[f] > 0;
    const sh = Number.isFinite(shifts[f]) ? shifts[f] : 0;
    // the period at this mark as the waveform shows it (marks sit on its peaks), which follows a note change more
    // closely than the 5 ms pitch frames do; the tracked period where the next mark isn't a voiced one
    const next = marks[mi + 1];
    const Pm = voiced && next && next.P > 0 && next.pos - m.pos > 0.7 * m.P && next.pos - m.pos < 1.4 * m.P ? next.pos - m.pos : m.P;
    const step = voiced ? Pm / Math.pow(2, sh / 12) : U;
    // going up, grains are as wide as the new period (they then sum to ~1 instead of cancelling each other); going
    // down they keep their two periods and leave gaps — that is what makes the lower pitch — with their level made up
    const half = voiced ? Math.max(2, Math.round(Math.min(Pm, step))) : U;
    const gain = voiced ? Math.sqrt(Math.max(1, step / Pm)) : 1;
    const c0 = Math.round(tOut);
    for (let k = -half; k <= half; k++) {
      const i = m.pos + k;
      const o = c0 + k;
      if (i < 0 || i >= len || o < 0 || o >= len) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * k) / half);
      for (let ch = 0; ch < channels.length; ch++) out[ch][o] += channels[ch][i] * w * gain;
      wsum[o] += w;
    }
    tOut += Math.max(1, step);
  }
  // only where grains pile up: dividing the gaps of a downward shift by their small window sum would rebuild the
  // original waveform (and its pitch)
  for (let i = 0; i < len; i++) {
    const w = wsum[i];
    if (w > 1) for (const o of out) o[i] /= w;
  }
  // the level make-up of downward shifts must not clip: peaks may grow, but not past −0.2 dBFS (nor past the input's
  // own peak when that was already higher)
  let pin = 0;
  let pout = 0;
  for (const c of channels) for (let i = 0; i < len; i++) pin = Math.max(pin, Math.abs(c[i]));
  for (const o of out) for (let i = 0; i < len; i++) pout = Math.max(pout, Math.abs(o[i]));
  const ceiling = Math.max(pin, 0.977);
  if (pout > ceiling) {
    const g = ceiling / pout;
    for (const o of out) for (let i = 0; i < len; i++) o[i] *= g;
  }
  return out;
}

/**
 * WSOLA time stretch: output length = input length / rate (rate 2 = twice as fast), pitch unchanged. Each 40 ms
 * Hann frame is taken near its nominal input position where it best continues the previous one (waveform-similarity
 * search), then overlap-added.
 */
export function timeStretch(channels, sampleRate, rate) {
  if (!(rate >= 0.25 && rate <= 4)) throw new Error('rate must be between 0.25 and 4');
  const len = channels[0].length;
  const N = 2 * Math.round(sampleRate * 0.02);
  const Hs = N / 2;
  const tol = Math.round(sampleRate * 0.008);
  // the similarity search looks at about 11 kHz worth of samples whatever the rate (its cost would grow with rate²)
  const ds = Math.max(1, Math.round(sampleRate / 11025));
  const cstep = 2 * ds;
  const jstep = 4 * ds;
  const outLen = Math.max(1, Math.round(len / rate));
  const mono = mixMono(channels);
  const out = channels.map(() => new Float32Array(outLen + N));
  const wsum = new Float32Array(outLen + N);
  const win = new Float32Array(N);
  for (let k = 0; k < N; k++) win[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N);
  let prev = 0;
  // k = -1 is a frame centred on the first sample, so the output starts at full level (no fade-in from the window)
  for (let k = -1; k * Hs < outLen; k++) {
    const nominal = Math.round(k * Hs * rate);
    // the first frame copies the input around sample 0 as it is (half of it before the start: skipped)
    let pos = k < 0 ? -Hs : Math.min(Math.max(0, nominal), Math.max(0, len - N));
    if (k > -1) {
      // the natural continuation of the previous frame, and the candidate around the nominal position most like it
      const nat = prev + Hs;
      let best = pos;
      let bc = -Infinity;
      const corr = (p) => {
        let acc = 0;
        for (let j = 0; j < N; j += jstep) acc += mono[nat + j] * mono[p + j];
        return acc;
      };
      for (let dlt = -tol; dlt <= tol; dlt += cstep) {
        const p = nominal + dlt;
        if (p < 0 || p + N > len || nat + N > len) continue;
        const acc = corr(p);
        if (acc > bc) { bc = acc; best = p; }
      }
      // then sample-exact around the best coarse candidate
      if (cstep > 1 && bc > -Infinity) {
        const c0 = best;
        for (let p = c0 - cstep + 1; p < c0 + cstep; p++) {
          if (p === c0 || p < 0 || p + N > len) continue;
          const acc = corr(p);
          if (acc > bc) { bc = acc; best = p; }
        }
      }
      pos = best;
    }
    const o0 = k * Hs;
    for (let j = 0; j < N; j++) {
      const i = pos + j;
      const o = o0 + j;
      if (i >= len) break;
      if (o < 0 || i < 0) continue;
      for (let ch = 0; ch < channels.length; ch++) out[ch][o] += channels[ch][i] * win[j];
      wsum[o] += win[j];
    }
    prev = pos;
  }
  return out.map((o) => {
    const r = o.subarray(0, outLen).slice();
    for (let i = 0; i < outLen; i++) if (wsum[i] > 1e-3) r[i] /= wsum[i];
    return r;
  });
}

/**
 * Put `part` (channels of [at, at + part length)) into a copy of `channels`, crossfading over `fadeSec` at each edge
 * that is inside the clip — a processed stretch never clicks against the untouched audio around it.
 */
function splice(channels, at, part, sampleRate, fadeSec = 0.008) {
  const len = channels[0].length;
  const n = part[0].length;
  const fade = Math.max(1, Math.round(fadeSec * sampleRate));
  return channels.map((c, ch) => {
    const o = c.slice();
    const p = part[Math.min(ch, part.length - 1)];
    for (let i = 0; i < n && at + i < len; i++) {
      const fi = at > 0 ? Math.min(1, (i + 0.5) / fade) : 1;
      const fo = at + n < len ? Math.min(1, (n - i - 0.5) / fade) : 1;
      const w = Math.min(fi, fo);
      o[at + i] = c[at + i] * (1 - w) + p[i] * w;
    }
    return o;
  });
}

/**
 * Shift the pitch of [start, end) by `semitones`, keeping its length. Monophonic material (mostly voiced frames:
 * a voice, a solo instrument) goes through PSOLA so formants stay put; anything else (chords, drums, full mixes) is
 * resampled (band-limited) and time-stretched back to length. The edges of the range are crossfaded.
 */
export function pitchShiftClip(clip, start, end, semitones) {
  const len = clip.channels[0].length;
  const s = Math.max(0, Math.min(len, Math.round(start ?? 0)));
  const e = Math.max(s, Math.min(len, Math.round(end ?? len)));
  if (e <= s || !semitones) return { sampleRate: clip.sampleRate, channels: clip.channels.map((c) => c.slice()) };
  // shifted with 40 ms of context on each side (grains and windows near the range's edges stay whole), then only
  // [start, end) goes back in
  const margin = Math.round(0.04 * clip.sampleRate);
  const s0 = Math.max(0, s - margin);
  const e0 = Math.min(len, e + margin);
  const part = clip.channels.map((c) => c.slice(s0, e0));
  // up to 2.5 kHz: a flute, whistle or high lead is read at its own pitch (not an octave low) before it is shifted
  const tracked = trackPitch(mixMono(part), clip.sampleRate, { maxHz: 2500 });
  const track = holdEdges(tracked);
  let voiced = 0;
  let loud = 0;
  // frames above the silence gate: a noise floor between phrases doesn't count against a voice (counted before the
  // edges are held: those frames were never measured)
  for (let f = 0; f < tracked.hz.length; f++) { if (tracked.rms[f] > 0 && tracked.rms[f] >= tracked.gate) loud++; if (tracked.hz[f] > 0) voiced++; }
  let shifted;
  // PSOLA for a voice or a solo instrument up to ~1 kHz; higher, a period is too few samples for clean grains (and
  // keeping formants matters little for a whistle or a piccolo)
  const pitched = [];
  for (let f = 0; f < tracked.hz.length; f++) if (tracked.hz[f] > 0) pitched.push(tracked.hz[f]);
  const n = e0 - s0;
  if (loud && voiced / loud > 0.6 && median(pitched) < 1000) {
    shifted = psola(part, clip.sampleRate, track, new Float32Array(track.hz.length).fill(semitones));
  } else {
    const ratio = Math.pow(2, semitones / 12);
    const resampled = resampleChannels(part, Math.max(1, Math.round(n / ratio)));
    // (rounding the resampled length can put the rate a hair outside 0.25…4 at ±24 semitones)
    shifted = timeStretch(resampled, clip.sampleRate, Math.min(4, Math.max(0.25, resampled[0].length / n)));
    shifted = shifted.map((c) => { const o = new Float32Array(n); o.set(c.subarray(0, n)); return o; });
  }
  return { sampleRate: clip.sampleRate, channels: splice(clip.channels, s, shifted.map((c) => c.subarray(s - s0, e - s0)), clip.sampleRate) };
}

const SCALE_LABEL = (key, scale) => (!scale || scale === 'chromatic' ? 'the chromatic scale' : `${key} ${scale}`);

/**
 * Analyse a clip for the pitch editor: { track, notes } with auto targets for key/scale. Restrict to [start, end)
 * frames when given (notes outside are dropped).
 */
export function analyzeMelody(clip, { key = 'C', scale = 'chromatic', start, end } = {}) {
  const track = trackPitch(mixMono(clip.channels), clip.sampleRate);
  const sr = clip.sampleRate;
  let notes = findNotes(track);
  if (Number.isFinite(start) || Number.isFinite(end)) {
    const a = (start ?? 0) / sr;
    const b = (end ?? Infinity) / sr;
    notes = notes.filter((nn) => nn.endSec > a && nn.startSec < b);
  }
  return { track, notes: snapNotes(notes, key, scale) };
}

/**
 * Auto-tune a clip: detect the melody, move every note to the nearest note of key/scale (or to the targets of
 * `notes` the user placed by hand) and resynthesise. With start/end (frames) only the notes there are tuned (they are
 * found in that range plus 2 s around it). Only the stretch that actually moves is replaced (crossfaded in), so the
 * rest of the audio stays exactly as it was. Returns { clip, track, notes, shifts, maxMove, scaleLabel } — with a
 * range, track/notes/shifts are those of the analysed region (frames from its start, start − 2 s).
 */
export function autotune(clip, { key = 'C', scale = 'chromatic', amount = 1, speedMs = 50, flatten = 0, start, end, notes: given, track: givenTrack } = {}) {
  const sr = clip.sampleRate;
  const len = clip.channels[0].length;
  const ranged = !(given && givenTrack) && (Number.isFinite(start) || Number.isFinite(end));
  const a = ranged ? Math.max(0, Math.round((start ?? 0) - 2 * sr)) : 0;
  const b = ranged ? Math.min(len, Math.round((end ?? len) + 2 * sr)) : len;
  const region = a === 0 && b === len ? clip.channels : clip.channels.map((c) => c.subarray(a, b));
  const melody = given && givenTrack
    ? { track: givenTrack, notes: given }
    : analyzeMelody({ sampleRate: sr, channels: region }, { key, scale, start: Number.isFinite(start) ? start - a : undefined, end: Number.isFinite(end) ? end - a : undefined });
  // a note that starts (or ends) where the analysed audio does is corrected right to that edge
  const track = holdEdges(melody.track);
  const [lead = 0, tail = 0] = melody.track.edges || [];
  const nF = track.hz.length;
  const notes = melody.notes.map((x) => (x.start <= lead || x.end >= nF - tail ? { ...x, start: x.start <= lead ? 0 : x.start, end: x.end >= nF - tail ? nF : x.end } : x));
  const shifts = correctionCurve(track, notes, { amount: amount ?? 1, speedMs: speedMs ?? 50, flatten: flatten ?? 0 });
  let f0 = -1;
  let f1 = -1;
  for (let f = 0; f < shifts.length; f++) if (Math.abs(shifts[f]) > 1e-4) { if (f0 < 0) f0 = f; f1 = f; }
  let channels;
  if (f0 < 0) {
    channels = clip.channels.map((c) => c.slice());
  } else {
    const hopS = track.hop * sr;
    const pad = Math.round(0.04 * sr);
    const p0 = Math.max(0, Math.round(f0 * hopS) - pad);
    const p1 = Math.min(region[0].length, Math.round((f1 + 1) * hopS) + pad);
    const processed = psola(region, sr, track, shifts);
    channels = splice(clip.channels, a + p0, processed.map((c) => c.subarray(p0, p1)), sr);
  }
  const maxMove = melody.notes.reduce((m, nn) => (nn.bypass ? m : Math.max(m, Math.abs(nn.target - nn.center))), 0);
  return { clip: { sampleRate: sr, channels }, track: melody.track, notes: melody.notes, shifts, maxMove, scaleLabel: SCALE_LABEL(key, scale) };
}
