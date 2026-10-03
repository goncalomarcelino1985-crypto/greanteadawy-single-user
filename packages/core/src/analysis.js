// Audio analysis in pure JS (Node + browser): loudness (EBU R128 / ITU-R BS.1770 LUFS), peak, RMS,
// spectral balance, stereo image, onsets, tempo, pitch, key and a rough "what is this sound" guess.
// Used for uploaded samples (so Claude can pick and tune them) and for mixdowns (render_mix).
import { noteName } from './music.js';

const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
/** Spectral bands used for "spectral balance" percentages (Hz). */
const BANDS = [['sub', 20, 60], ['low', 60, 250], ['lowMid', 250, 500], ['mid', 500, 2000], ['highMid', 2000, 6000], ['high', 6000, 20000]];
const toDb = (x) => (x > 1e-10 ? 20 * Math.log10(x) : -200);

// ------------------------------------------------------------------ FFT

const fftCache = new Map();
function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const hann = new Float32Array(n);
  for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  t = { rev, cos, sin, hann };
  fftCache.set(n, t);
  return t;
}

/** In-place radix-2 FFT. re/im are Float64Array of length n (power of 2). */
export function fft(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const a = i + j;
        const b = a + half;
        const tr = re[b] * cos[k] - im[b] * sin[k];
        const ti = re[b] * sin[k] + im[b] * cos[k];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** Power spectrum (|X|^2, bins 0..n/2) of `n` samples of `x` starting at `start` (Hann window, zero padded). */
function powerSpectrum(x, start, n, re, im) {
  const { hann } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const s = start + i;
    re[i] = s < x.length && s >= 0 ? x[s] * hann[i] : 0;
    im[i] = 0;
  }
  fft(re, im);
  const half = n / 2;
  const p = new Float64Array(half + 1);
  for (let i = 0; i <= half; i++) p[i] = re[i] * re[i] + im[i] * im[i];
  return p;
}

// ------------------------------------------------------------------ loudness (BS.1770-4)

function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** BS.1770 K-weighting as two biquads: [b0, b1, b2, a1, a2] for the high shelf and the RLB high-pass. */
function kWeightCoeffs(fs) {
  // Stage 1: high shelf (+4 dB above ~1.7 kHz)
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  // Stage 2: RLB high-pass (~38 Hz)
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, hp];
}

function kWeight(x, fs) {
  const [shelf, hp] = kWeightCoeffs(fs);
  return biquad(biquad(x, ...shelf), ...hp);
}

/** 100 ms sub-block energies (sum over channels of mean square of K-weighted signal). */
function subBlockEnergies(channels, fs) {
  const hop = Math.max(1, Math.round(fs * 0.1));
  const n = channels[0].length;
  const count = Math.max(1, Math.ceil(n / hop));
  const e = new Float64Array(count);
  for (const ch of channels.slice(0, 2)) {
    const y = kWeight(ch, fs);
    for (let b = 0; b < count; b++) {
      let s = 0;
      const end = Math.min(n, (b + 1) * hop);
      for (let i = b * hop; i < end; i++) s += y[i] * y[i];
      e[b] += s / Math.max(1, end - b * hop); // the last block may be partial
    }
  }
  return { e, hop };
}

const lufsOf = (z) => (z > 0 ? -0.691 + 10 * Math.log10(z) : -200);

function integratedLoudness(e) {
  // momentary blocks: 400 ms (4 sub-blocks) with 75% overlap
  const blocks = [];
  if (e.length < 4) {
    let s = 0;
    for (const v of e) s += v;
    blocks.push(s / Math.max(1, e.length));
  } else {
    for (let i = 0; i + 4 <= e.length; i++) blocks.push((e[i] + e[i + 1] + e[i + 2] + e[i + 3]) / 4);
  }
  let maxBlock = 0;
  for (const z of blocks) if (z > maxBlock) maxBlock = z; // (no spread: long files have >100k blocks)
  const abs = blocks.filter((z) => lufsOf(z) > -70);
  if (!abs.length) return { integrated: -200, momentaryMax: lufsOf(maxBlock) };
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = lufsOf(meanAbs) - 10;
  const gated = abs.filter((z) => lufsOf(z) > rel);
  const meanGated = gated.reduce((a, b) => a + b, 0) / Math.max(1, gated.length);
  return { integrated: lufsOf(meanGated), momentaryMax: lufsOf(maxBlock) };
}

function shortTermMax(e) {
  if (e.length < 30) return null;
  let s = 0;
  for (let i = 0; i < 30; i++) s += e[i];
  let max = s;
  for (let i = 30; i < e.length; i++) {
    s += e[i] - e[i - 30];
    if (s > max) max = s;
  }
  return lufsOf(max / 30);
}

/** EBU R128 loudness range (LU): spread (10th–95th percentile) of gated 3 s short-term loudness. */
function loudnessRange(e) {
  if (e.length < 30) return null;
  const st = [];
  let s = 0;
  for (let i = 0; i < e.length; i++) {
    s += e[i];
    if (i >= 30) s -= e[i - 30];
    if (i >= 29) st.push(s / 30);
  }
  const abs = st.filter((z) => lufsOf(z) > -70);
  if (abs.length < 2) return null;
  const rel = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 20;
  const gated = abs.map(lufsOf).filter((l) => l > rel).sort((a, b) => a - b);
  if (gated.length < 2) return 0;
  const at = (q) => gated[Math.min(gated.length - 1, Math.max(0, Math.round(q * (gated.length - 1))))];
  return at(0.95) - at(0.1);
}

// 4× oversampling interpolator for true-peak metering: windowed sinc, 16 taps, phases 1/4, 2/4, 3/4
const TP_TAPS = 8;
const TP_PHASES = [0.25, 0.5, 0.75].map((f) => {
  const w = new Float64Array(2 * TP_TAPS);
  for (let k = -TP_TAPS + 1; k <= TP_TAPS; k++) {
    const t = k - f;
    const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
    w[k + TP_TAPS - 1] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * t) / TP_TAPS));
  }
  return w;
});

/**
 * Streaming true-peak (inter-sample peak) meter in the spirit of ITU-R BS.1770: interpolates 4× around samples
 * within 6 dB of the running peak — the only places an "over" can hide. push(channels) per chunk, peak() at the end.
 */
export function createTruePeakMeter() {
  const hist = [];
  let peak = 0;
  const run = (x, c, flush) => {
    // history holds the last 2·TAPS samples of the previous chunk, so interpolation spans chunk borders
    const h = hist[c] || new Float64Array(TP_TAPS - 1); // leading zeros: the first samples get full context
    const buf = new Float64Array(h.length + x.length + (flush ? TP_TAPS : 0));
    buf.set(h);
    for (let i = 0; i < x.length; i++) buf[h.length + i] = Number.isFinite(x[i]) ? x[i] : 0;
    const last = buf.length - TP_TAPS; // pairs (n, n+1) need TAPS samples of look-ahead
    for (let n = Math.max(TP_TAPS - 1, h.length - TP_TAPS); n < last; n++) {
      const a = Math.abs(buf[n]);
      if (a > peak) peak = a;
      if (Math.max(a, Math.abs(buf[n + 1])) < peak * 0.5) continue;
      for (const w of TP_PHASES) {
        let v = 0;
        for (let k = 0; k < w.length; k++) v += w[k] * buf[n - TP_TAPS + 1 + k];
        if (v < 0) v = -v;
        if (v > peak) peak = v;
      }
    }
    hist[c] = buf.slice(Math.max(0, buf.length - 2 * TP_TAPS));
  };
  return {
    push(channels) { channels.forEach((x, c) => run(x, c, false)); },
    peak() {
      // flush: evaluate the last samples with zero padding after them
      hist.forEach((_, c) => run(new Float64Array(0), c, true));
      return peak;
    }
  };
}

/** 2nd-order Butterworth low-pass coefficients [b0, b1, b2, a1, a2] (RBJ cookbook). */
function lowpassCoeffs(fs, f0) {
  const w = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return [((1 - cos) / 2) / a0, (1 - cos) / a0, ((1 - cos) / 2) / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

/** Strongest frequency between 25 and 300 Hz in a power spectrum (parabolic peak interpolation) — the "note" of
 *  the low end: kick and 808 fundamentals live here. */
function lowPeakHz(total, binHz) {
  let best = -1;
  for (let k = Math.max(1, Math.ceil(25 / binHz)); k <= Math.min(total.length - 2, Math.floor(300 / binHz)); k++) {
    if (best < 0 || total[k] > total[best]) best = k;
  }
  if (best < 1 || !(total[best] > 0)) return null;
  const a = Math.log(total[best - 1] + 1e-30); const b = Math.log(total[best] + 1e-30); const c = Math.log(total[best + 1] + 1e-30);
  const den = a - 2 * b + c;
  const shift = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return Math.round((best + shift) * binHz * 10) / 10;
}

/**
 * "A1 +30c" for a frequency. Offsets under 20 cents are left out: an FFT peak is only accurate to about ±0.5 Hz, which
 * at 30–60 Hz is already 15–30 cents (use analyze_sound's pitch for exact tuning of one note).
 */
function hzToNote(hz) {
  if (!(hz > 0)) return null;
  const m = 69 + 12 * Math.log2(hz / 440);
  const r = Math.round(m);
  const cents = Math.round(((m - r) * 100) / 5) * 5;
  return `${PC[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}${Math.abs(cents) >= 20 ? ` ${cents > 0 ? '+' : ''}${cents}c` : ''}`;
}

// ------------------------------------------------------------------ pitch (YIN)

function detectPitch(x, fs, start) {
  const W = Math.min(4096, Math.max(1024, Math.round(fs * 0.06)));
  if (start + W * 2 > x.length) start = Math.max(0, x.length - W * 2);
  if (x.length < W + 64) return null;
  const tauMin = Math.max(2, Math.floor(fs / 2000));
  const tauMax = Math.min(W - 1, Math.floor(fs / 30));
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const a = x[start + i] - (x[start + i + tau] || 0);
      s += a * a;
    }
    d[tau] = s;
  }
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < 0.15) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
      best = tau;
      break;
    }
  }
  if (best < 0) {
    let min = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) if (cmnd[tau] < min) { min = cmnd[tau]; best = tau; }
    if (min > 0.35) return null;
  }
  let tau = best;
  if (best > 1 && best < tauMax) {
    const a = cmnd[best - 1]; const b = cmnd[best]; const c = cmnd[best + 1];
    const den = a - 2 * b + c;
    if (den !== 0) tau = best + (0.5 * (a - c)) / den;
  }
  const hz = fs / tau;
  const midiF = 69 + 12 * Math.log2(hz / 440);
  const midi = Math.round(midiF);
  if (midi < 0 || midi > 127) return null;
  return { hz: r1(hz), midi, note: noteName(midi), cents: Math.round((midiF - midi) * 100), confidence: r2(1 - cmnd[best]) };
}

// ------------------------------------------------------------------ key (Krumhansl-Kessler)

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function detectKey(chroma) {
  const results = [];
  for (let k = 0; k < 12; k++) {
    const rot = (p) => p.map((_, i) => p[(i - k + 12) % 12]);
    results.push({ key: PC[k], scale: 'major', r: correlate(chroma, rot(MAJOR)) });
    results.push({ key: PC[k], scale: 'minor', r: correlate(chroma, rot(MINOR)) });
  }
  results.sort((a, b) => b.r - a.r);
  return { key: results[0].key, scale: results[0].scale, confidence: r2(results[0].r), runnerUp: `${results[1].key} ${results[1].scale}` };
}

// ------------------------------------------------------------------ main

/**
 * Analyze audio.
 * @param {{ channels: Float32Array[], sampleRate: number }} audio
 * @param {{ segmentSeconds?: number, segmentLabel?: string, maxTempoSeconds?: number, lite?: boolean }} opts
 *   segmentSeconds: also report loudness per segment (e.g. 4 bars) — used for mixdowns
 *   lite: levels + spectrum + stereo only (skips onsets, tempo, pitch and key) — used for stems
 */
/** Replace NaN/±Infinity samples with 0 (copying only channels that need it). Returns { channels, invalid }. */
function finiteChannels(channels) {
  let invalid = 0;
  const out = channels.map((ch) => {
    let bad = 0;
    for (let i = 0; i < ch.length; i++) if (!Number.isFinite(ch[i])) bad++;
    if (!bad) return ch;
    invalid += bad;
    const copy = Float32Array.from(ch);
    for (let i = 0; i < copy.length; i++) if (!Number.isFinite(copy[i])) copy[i] = 0;
    return copy;
  });
  return { channels: out, invalid };
}

export function analyzeAudio({ channels: input, sampleRate: fs }, opts = {}) {
  if (!input?.length || !input[0]?.length) throw new Error('No audio data');
  const { channels, invalid } = finiteChannels(input);
  const n = channels[0].length;
  const nch = channels.length;
  const duration = n / fs;

  // --- levels
  let peak = 0;
  let sumSq = 0;
  let clipped = 0;
  const mono = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      if (a >= 0.999) clipped++;
      sumSq += v * v;
      mono[i] += v / nch;
    }
  }
  const rms = Math.sqrt(sumSq / (n * nch));
  let dc = 0;
  for (let i = 0; i < n; i++) dc += mono[i];
  dc /= n;

  // --- silence at head/tail (-60 dBFS)
  const thr = 0.001;
  let first = 0;
  while (first < n && Math.abs(mono[first]) < thr) first++;
  let last = n - 1;
  while (last > first && Math.abs(mono[last]) < thr) last--;
  const silent = first >= n;

  // --- loudness
  const { e } = subBlockEnergies(channels, fs);
  const { integrated, momentaryMax } = integratedLoudness(e);
  const stMax = shortTermMax(e);
  const lra = loudnessRange(e);
  let truePeak = null;
  if (!opts.lite) {
    const tp = createTruePeakMeter();
    tp.push(channels.slice(0, 2));
    truePeak = Math.max(peak, tp.peak());
  }

  // --- stereo
  let stereo = null;
  if (nch >= 2) {
    const L = channels[0]; const R = channels[1];
    let lr = 0; let ll = 0; let rr = 0; let mid = 0; let side = 0;
    for (let i = 0; i < n; i++) {
      lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i];
      const m = (L[i] + R[i]) / 2; const s = (L[i] - R[i]) / 2;
      mid += m * m; side += s * s;
    }
    // low end (< 150 Hz) on its own: bass and kick should be (nearly) mono for clubs, phones and vinyl
    const [b0, b1, b2, a1, a2] = lowpassCoeffs(fs, 150);
    let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0; let u1 = 0; let u2 = 0; let v1 = 0; let v2 = 0;
    let lowMid = 0; let lowSide = 0;
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) / 2; const sd = (L[i] - R[i]) / 2;
      const ym = b0 * m + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = m; y2 = y1; y1 = ym;
      const ys = b0 * sd + b1 * u1 + b2 * u2 - a1 * v1 - a2 * v2;
      u2 = u1; u1 = sd; v2 = v1; v1 = ys;
      lowMid += ym * ym; lowSide += ys * ys;
    }
    stereo = {
      // one silent side: there is nothing to correlate (and no phase problem)
      correlation: ll && rr ? r2(lr / Math.sqrt(ll * rr)) : ll || rr ? 0 : 1,
      width: mid ? r2(Math.sqrt(side / mid)) : 0,
      lowWidth: lowMid > 1e-9 ? r2(Math.sqrt(lowSide / lowMid)) : 0,
      // + = louder left; capped at ±60 dB (a hard-panned signal)
      balanceDb: ll || rr ? r1(Math.max(-60, Math.min(60, 10 * Math.log10((ll + 1e-12) / (rr + 1e-12))))) : 0
    };
  }

  // --- spectrum, flatness, chroma
  const N = 4096;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const binHz = fs / N;
  const total = new Float64Array(N / 2 + 1);
  const chroma = new Array(12).fill(0);
  let flatSum = 0;
  let flatFrames = 0;
  const regionStart = silent ? 0 : first;
  const regionLen = silent ? n : Math.max(1, last - first + 1);
  const frames = Math.max(1, Math.min(300, Math.ceil(regionLen / N)));
  const stride = frames > 1 ? (regionLen - N) / (frames - 1) : 0;
  const fLo = Math.max(1, Math.floor(100 / binHz));
  const fHi = Math.min(N / 2, Math.floor(10000 / binHz));
  for (let f = 0; f < frames; f++) {
    const start = Math.round(regionStart + Math.max(0, stride) * f);
    const p = powerSpectrum(mono, start, N, re, im);
    let logSum = 0; let linSum = 0; let cnt = 0;
    for (let k = 1; k < p.length; k++) {
      total[k] += p[k];
      if (k >= fLo && k <= fHi) {
        logSum += Math.log(p[k] + 1e-20);
        linSum += p[k];
        cnt++;
      }
      const hz = k * binHz;
      if (hz >= 55 && hz <= 5000) {
        const pc = ((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12;
        chroma[pc] += Math.sqrt(p[k]);
      }
    }
    if (cnt && linSum > 1e-12) {
      flatSum += Math.exp(logSum / cnt) / (linSum / cnt);
      flatFrames++;
    }
  }
  const bandE = {};
  let all = 0;
  let centroidNum = 0;
  for (let k = 1; k < total.length; k++) {
    const hz = k * binHz;
    if (hz < 20 || hz > 20000) continue;
    all += total[k];
    centroidNum += hz * total[k];
    for (const [name, lo, hi] of BANDS) if (hz >= lo && hz < hi) bandE[name] = (bandE[name] || 0) + total[k];
  }
  const bands = {};
  for (const [name] of BANDS) bands[name] = all > 0 ? Math.round(((bandE[name] || 0) / all) * 1000) / 10 : 0;
  const centroid = all > 0 ? centroidNum / all : 0;
  const flatness = flatFrames ? flatSum / flatFrames : 1;
  const lowHz = lowPeakHz(total, binHz);

  // --- onsets (spectral flux) and tempo
  const H = 512;
  const NF = 1024;
  const maxT = opts.lite ? 0 : Math.min(n, Math.round(fs * (opts.maxTempoSeconds || 120)));
  const re2 = new Float64Array(NF);
  const im2 = new Float64Array(NF);
  const env = [];
  let prev = null;
  for (let s = 0; s + NF <= maxT; s += H) {
    const p = powerSpectrum(mono, s, NF, re2, im2);
    const mag = new Float64Array(p.length);
    for (let k = 0; k < p.length; k++) mag[k] = Math.log1p(1000 * Math.sqrt(p[k]));
    let flux = 0;
    if (prev) for (let k = 1; k < mag.length; k++) { const d = mag[k] - prev[k]; if (d > 0) flux += d; }
    env.push(flux);
    prev = mag;
  }
  const fps = fs / H;
  const onsetTimes = [];
  let strongOnsets = 0;
  if (env.length > 3) {
    const max = Math.max(...env) || 1;
    const norm = env.map((v) => v / max);
    const minGap = Math.round(fps * 0.05);
    let lastOnset = -Infinity;
    for (let i = 1; i < norm.length - 1; i++) {
      if (norm[i] < norm[i - 1] || norm[i] < norm[i + 1]) continue;
      let local = 0; let c = 0;
      for (let j = Math.max(0, i - 16); j < Math.min(norm.length, i + 16); j++) { local += norm[j]; c++; }
      if (norm[i] > local / c + 0.08 && norm[i] > 0.12 && i - lastOnset >= minGap) {
        onsetTimes.push(i / fps);
        if (norm[i] > 0.3) strongOnsets++;
        lastOnset = i;
      }
    }
  }
  let tempo = null;
  // tempo needs real re-attacks (sustained tones can produce weak, periodic "beating" flux)
  if (duration >= 3 && strongOnsets >= 4 && env.length > fps * 2) {
    const m = env.reduce((a, b) => a + b, 0) / env.length;
    const x = env.map((v) => Math.max(0, v - m));
    const lagMin = Math.floor((60 * fps) / 200);
    const lagMax = Math.min(x.length - 1, Math.ceil((60 * fps) / 60));
    let r0 = 0;
    for (let i = 0; i < x.length; i++) r0 += x[i] * x[i];
    const acf = new Float64Array(lagMax + 2);
    for (let L = lagMin; L <= lagMax + 1 && L < x.length; L++) {
      let s = 0;
      for (let i = 0; i + L < x.length; i++) s += x[i] * x[i + L];
      acf[L] = s / (x.length - L);
    }
    let best = -1; let bestScore = -Infinity;
    for (let L = lagMin; L <= lagMax; L++) {
      const bpm = (60 * fps) / L;
      const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      const score = acf[L] * w;
      if (score > bestScore) { bestScore = score; best = L; }
    }
    if (best > lagMin && best < lagMax && r0 > 0) {
      let lag = best;
      const a = acf[best - 1]; const b = acf[best]; const c = acf[best + 1];
      const den = a - 2 * b + c;
      if (den !== 0) lag = best + (0.5 * (a - c)) / den;
      // confidence: how much the winning periodicity stands out from the average lag
      let mean = 0;
      for (let L = lagMin; L <= lagMax; L++) mean += acf[L];
      mean /= lagMax - lagMin + 1;
      const conf = mean > 0 ? Math.max(0, Math.min(1, (acf[best] / mean - 1) / 3)) : 0;
      tempo = { bpm: r1((60 * fps) / lag), confidence: r2(conf) };
    }
  }

  // --- classification
  const kind = silent ? 'silence' : duration < 1.2 || (duration < 2 && onsetTimes.length <= 2) ? 'one-shot' : duration <= 30 ? 'loop' : 'long';
  // pitch only makes sense for monophonic material (one-shots, short tonal loops)
  const rawPitch = !opts.lite && !silent && flatness < 0.35 && (kind === 'one-shot' || duration <= 8) ? detectPitch(mono, fs, Math.min(n - 1, first + Math.round(fs * 0.03))) : null;
  const pitch = rawPitch && rawPitch.confidence >= 0.75 ? rawPitch : null;
  const chromaSum = chroma.reduce((a, b) => a + b, 0);
  const key = !opts.lite && !silent && duration >= 2 && chromaSum > 0 && flatness < 0.5 ? detectKey(chroma) : null;
  const lowPct = bands.sub + bands.low;
  const highPct = bands.highMid + bands.high;
  let character;
  if (silent) character = 'silence';
  else if (kind === 'one-shot') {
    if (lowPct > 60 && centroid < 400) character = duration > 0.6 && pitch && pitch.confidence > 0.7 ? '808 / bass hit' : 'kick';
    else if (centroid > 5500 || highPct > 55) character = duration > 0.5 ? 'cymbal / open hat' : 'hi-hat / shaker';
    else if (flatness > 0.2) character = 'snare / clap / noisy percussion';
    else if (pitch && pitch.confidence > 0.7) character = `tonal one-shot (${pitch.note})`;
    else character = 'percussion';
  } else if (kind === 'loop') {
    if (key && key.confidence > 0.55 && flatness < 0.25) character = lowPct > 55 ? 'bass loop' : 'melodic loop';
    else if (onsetTimes.length / duration >= 2) character = 'drum loop';
    else character = 'texture / fx';
  } else {
    character = lowPct > 15 && highPct > 5 ? 'full mix / song' : 'long recording';
  }
  let loop = null;
  if (tempo && tempo.confidence >= 0.35 && kind !== 'one-shot') {
    const beats = (duration * tempo.bpm) / 60;
    const bars = beats / 4;
    loop = { beats: r2(beats), bars: r2(bars), fitsWholeBars: Math.abs(bars - Math.round(bars)) < 0.06 };
  }

  // --- loudness per segment (mixdowns)
  let segments = null;
  if (opts.segmentSeconds > 0) {
    const per = Math.max(1, Math.round(opts.segmentSeconds / 0.1));
    segments = [];
    for (let s = 0; s < e.length; s += per) {
      let z = 0; let c = 0;
      for (let i = s; i < Math.min(e.length, s + per); i++) { z += e[i]; c++; }
      segments.push(r1(lufsOf(z / c)));
    }
  }

  const result = {
    duration: r3(duration),
    sampleRate: fs,
    channels: nch,
    peakDb: r1(toDb(peak)),
    truePeakDb: truePeak === null ? null : r1(toDb(truePeak)),
    rmsDb: r1(toDb(rms)),
    lufs: r1(integrated),
    shortTermMaxLufs: r1(stMax),
    loudnessRangeLu: lra === null ? null : r1(lra),
    momentaryMaxLufs: r1(momentaryMax),
    crestDb: r1(toDb(peak) - toDb(rms)),
    dcOffset: r3(dc),
    invalidSamples: invalid, // NaN/Infinity in the input (treated as silence) — a broken render or effect
    clipping: { samples: clipped, percent: r3((clipped / (n * nch)) * 100) },
    silence: { headMs: silent ? null : Math.round((first / fs) * 1000), tailMs: silent ? null : Math.round(((n - 1 - last) / fs) * 1000) },
    stereo,
    spectrum: {
      centroidHz: Math.round(centroid),
      lowPeakHz: lowHz,
      lowPeakNote: hzToNote(lowHz),
      brightness: centroid < 800 ? 'dark' : centroid < 2500 ? 'warm' : centroid < 5000 ? 'balanced' : 'bright',
      flatness: r2(flatness),
      tonality: flatness < 0.1 ? 'tonal' : flatness < 0.3 ? 'mixed' : 'noisy',
      bandsPercent: bands
    },
    onsets: { count: onsetTimes.length, perSecond: r2(onsetTimes.length / Math.max(0.001, Math.min(duration, maxT / fs))), firstTimes: onsetTimes.slice(0, 16).map(r3) },
    tempo,
    pitch,
    key,
    kind,
    character,
    loop
  };
  if (segments) result.loudnessPerSegment = { segmentSeconds: r2(opts.segmentSeconds), label: opts.segmentLabel || '', lufs: segments };
  result.summary = describeAnalysis(result);
  return result;
}

/**
 * Streaming level meter for long signals that arrive in chunks (e.g. per-stem taps while a song renders).
 * push([left, right?]) any number of times, then result(). Feed chunks longer than the 4096-sample
 * spectrum frame (~0.1 s) so the spectral balance has data.
 * result(): { duration, lufs, loudnessRangeLu, peakDb, truePeakDb (with { truePeak: true }), rmsDb, crestDb, centroidHz,
 *   bandsPercent, stereoWidth, lowWidth (side/mid below 150 Hz), lowPeakHz/lowPeakNote (strongest 25–300 Hz frequency) }
 */
export function createLevelMeter(fs, { spectrumHopSeconds = 0.5, truePeak = false } = {}) {
  const coeffs = kWeightCoeffs(fs);
  const tp = truePeak ? createTruePeakMeter() : null;
  const [lb0, lb1, lb2, la1, la2] = lowpassCoeffs(fs, 150);
  const low = new Float64Array(8); // low-pass states for mid and side
  let lowMid = 0;
  let lowSide = 0;
  const N = 4096;
  const specHop = Math.max(N, Math.round(fs * spectrumHopSeconds));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const total = new Float64Array(N / 2 + 1);
  const hop = Math.max(1, Math.round(fs * 0.1));
  const filters = []; // per channel: K-weighting biquad states
  const energies = [];
  let blockSum = 0;
  let blockFill = 0;
  let samples = 0;
  let nch = 1;
  let peak = 0;
  let sumSq = 0;
  let mid = 0;
  let side = 0;
  let nextSpec = 0;
  let invalid = 0;

  let scratch = new Float64Array(0);
  const [[s0, s1, s2, sa1, sa2], [h0, h1, h2, ha1, ha2]] = coeffs;

  return {
    push(channels) {
      const clean = finiteChannels(channels.filter(Boolean).slice(0, 2));
      const chans = clean.channels;
      invalid += clean.invalid;
      if (!chans.length || !chans[0].length) return;
      const n = chans[0].length;
      nch = chans.length;
      if (scratch.length < n) scratch = new Float64Array(n);
      else scratch.fill(0, 0, n);
      // levels + K-weighted energy per sample (summed over channels); filter state carries across chunks
      for (let c = 0; c < nch; c++) {
        const x = chans[c];
        const f = (filters[c] ||= new Float64Array(8));
        let sx1 = f[0]; let sx2 = f[1]; let sy1 = f[2]; let sy2 = f[3];
        let hx1 = f[4]; let hx2 = f[5]; let hy1 = f[6]; let hy2 = f[7];
        for (let i = 0; i < n; i++) {
          const v = x[i];
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
          sumSq += v * v;
          const u = s0 * v + s1 * sx1 + s2 * sx2 - sa1 * sy1 - sa2 * sy2;
          sx2 = sx1; sx1 = v; sy2 = sy1; sy1 = u;
          const y = h0 * u + h1 * hx1 + h2 * hx2 - ha1 * hy1 - ha2 * hy2;
          hx2 = hx1; hx1 = u; hy2 = hy1; hy1 = y;
          scratch[i] += y * y;
        }
        f[0] = sx1; f[1] = sx2; f[2] = sy1; f[3] = sy2; f[4] = hx1; f[5] = hx2; f[6] = hy1; f[7] = hy2;
      }
      if (nch === 2) {
        const L = chans[0]; const R = chans[1];
        let [x1, x2, y1, y2, u1, u2, v1, v2] = low;
        for (let i = 0; i < n; i++) {
          const m = L[i] + R[i]; const d = L[i] - R[i];
          mid += m * m; side += d * d;
          const ym = lb0 * m + lb1 * x1 + lb2 * x2 - la1 * y1 - la2 * y2;
          x2 = x1; x1 = m; y2 = y1; y1 = ym;
          const ys = lb0 * d + lb1 * u1 + lb2 * u2 - la1 * v1 - la2 * v2;
          u2 = u1; u1 = d; v2 = v1; v1 = ys;
          lowMid += ym * ym; lowSide += ys * ys;
        }
        low.set([x1, x2, y1, y2, u1, u2, v1, v2]);
      }
      tp?.push(chans);
      for (let i = 0; i < n; i++) {
        blockSum += scratch[i];
        if (++blockFill === hop) {
          energies.push(blockSum / hop);
          blockSum = 0;
          blockFill = 0;
        }
      }
      // spectrum: one Hann-windowed frame (mono sum) every specHop samples; a frame that would straddle
      // two chunks is taken at the start of the next chunk instead
      const { hann } = fftTables(N);
      let at = Math.max(0, nextSpec - samples);
      while (at + N <= n) {
        for (let k = 0; k < N; k++) {
          let v = 0;
          for (let c = 0; c < nch; c++) v += chans[c][at + k];
          re[k] = (v / nch) * hann[k];
          im[k] = 0;
        }
        fft(re, im);
        for (let k = 1; k <= N / 2; k++) total[k] += re[k] * re[k] + im[k] * im[k];
        at += specHop;
      }
      nextSpec = samples + at;
      samples += n;
    },
    result() {
      const e = blockFill ? [...energies, blockSum / blockFill] : energies;
      const { integrated } = e.length ? integratedLoudness(Float64Array.from(e)) : { integrated: -200 };
      const rms = samples ? Math.sqrt(sumSq / (samples * nch)) : 0;
      const binHz = fs / N;
      const bandE = {};
      let all = 0;
      let centroidNum = 0;
      for (let k = 1; k < total.length; k++) {
        const hz = k * binHz;
        if (hz < 20 || hz > 20000) continue;
        all += total[k];
        centroidNum += hz * total[k];
        for (const [name, lo, hi] of BANDS) if (hz >= lo && hz < hi) bandE[name] = (bandE[name] || 0) + total[k];
      }
      const bandsPercent = {};
      for (const [name] of BANDS) bandsPercent[name] = all > 0 ? Math.round(((bandE[name] || 0) / all) * 1000) / 10 : 0;
      const lra = loudnessRange(e);
      const lowHz = lowPeakHz(total, binHz);
      return {
        duration: r3(samples / fs),
        lufs: r1(integrated),
        loudnessRangeLu: lra === null ? null : r1(lra),
        peakDb: r1(toDb(peak)),
        ...(tp ? { truePeakDb: r1(toDb(Math.max(peak, tp.peak()))) } : {}),
        lowPeakHz: lowHz,
        lowPeakNote: hzToNote(lowHz),
        lowWidth: nch === 2 && lowMid > 1e-9 ? r2(Math.sqrt(lowSide / lowMid)) : null,
        rmsDb: r1(toDb(rms)),
        crestDb: r1(toDb(peak) - toDb(rms)),
        centroidHz: all > 0 ? Math.round(centroidNum / all) : 0,
        bandsPercent,
        stereoWidth: nch === 2 && mid ? r2(Math.sqrt(side / mid)) : null,
        invalidSamples: invalid
      };
    }
  };
}

/**
 * Envelope of a single hit/note (mono sum, 5 ms RMS frames), timed from its onset: how fast it attacks and how
 * long it rings — e.g. whether an 808 tail runs into the next kick.
 * Returns { attackMs, decay20Ms, decay40Ms, decay60Ms } (null where the level never drops that far).
 */
export function envelopeTimes({ channels, sampleRate: fs }) {
  const n = channels[0]?.length || 0;
  const hop = Math.max(1, Math.round(fs * 0.005));
  const frames = [];
  for (let s = 0; s < n; s += hop) {
    let z = 0;
    let c = 0;
    for (const ch of channels) for (let i = s; i < Math.min(n, s + hop); i++) { z += ch[i] * ch[i]; c++; }
    frames.push(Math.sqrt(z / Math.max(1, c)));
  }
  let pk = 0;
  for (let i = 1; i < frames.length; i++) if (frames[i] > frames[pk]) pk = i;
  if (!frames.length || frames[pk] <= 1e-6) return { attackMs: null, decay20Ms: null, decay40Ms: null, decay60Ms: null };
  const peakDb = toDb(frames[pk]);
  let onset = 0;
  while (onset < pk && toDb(frames[onset]) < peakDb - 40) onset++;
  const ms = (i) => Math.round((i - onset) * (hop / fs) * 1000);
  const after = (drop) => {
    for (let i = pk; i < frames.length; i++) if (toDb(frames[i]) < peakDb - drop) return ms(i);
    return null;
  };
  return { attackMs: ms(pk), decay20Ms: after(20), decay40Ms: after(40), decay60Ms: after(60) };
}

/** One-paragraph plain-English description. */
export function describeAnalysis(a) {
  if (a.kind === 'silence') return 'Silent audio.';
  const parts = [];
  parts.push(`${a.duration}s ${a.channels === 1 ? 'mono' : 'stereo'} ${a.kind}, likely ${a.character}.`);
  parts.push(`Loudness ${a.lufs} LUFS, peak ${a.peakDb} dBFS, crest ${a.crestDb} dB.`);
  const b = a.spectrum.bandsPercent;
  parts.push(`Spectrum ${a.spectrum.brightness} (centroid ${a.spectrum.centroidHz} Hz, ${a.spectrum.tonality}); energy sub ${b.sub}% / low ${b.low}% / low-mid ${b.lowMid}% / mid ${b.mid}% / high-mid ${b.highMid}% / high ${b.high}%.`);
  if (a.pitch && a.kind === 'one-shot') parts.push(`Pitch ≈ ${a.pitch.note} (${a.pitch.hz} Hz, ${a.pitch.cents > 0 ? '+' : ''}${a.pitch.cents} cents).`);
  if (a.tempo && a.tempo.confidence >= 0.35) parts.push(`Tempo ≈ ${a.tempo.bpm} BPM${a.loop ? ` (${a.loop.bars} bars)` : ''}.`);
  if (a.key && a.key.confidence > 0.5) parts.push(`Key ≈ ${a.key.key} ${a.key.scale}.`);
  if (a.invalidSamples) parts.push(`WARNING: ${a.invalidSamples} invalid (NaN/Infinity) samples — the audio is broken somewhere.`);
  if (a.clipping.samples > 0) parts.push(`Clipping: ${a.clipping.samples} samples.`);
  if (a.silence.headMs > 30) parts.push(`${a.silence.headMs} ms silence at the start.`);
  return parts.join(' ');
}
