// Band-limited resampling shared by the wave editor (speed changes, sample-rate conversion on paste) and pitch shifting
// (resample + time-stretch for chords and drums). Shrinking low-passes first, so nothing above the new Nyquist folds
// back as an alias.

/** Cubic (Catmull-Rom) interpolation of channel c at fractional position p. */
export function cubicAt(c, p) {
  const i = Math.floor(p);
  const t = p - i;
  const y0 = c[Math.max(0, i - 1)] || 0;
  const y1 = c[i] || 0;
  const y2 = c[Math.min(c.length - 1, i + 1)] || 0;
  const y3 = c[Math.min(c.length - 1, i + 2)] || 0;
  return y1 + 0.5 * t * (y2 - y0 + t * (2 * y0 - 5 * y1 + 4 * y2 - y3 + t * (3 * (y1 - y2) + y3 - y0)));
}

/** Filter length for shrinking by `ratio`: steeper (longer) the more the bandwidth shrinks. */
const tapsFor = (ratio) => Math.min(255, Math.max(63, 2 * Math.round(16 / ratio) + 1));

/** A windowed-sinc (Blackman) low-pass at `cutoff` (fraction of the sample rate). */
export function lowpassChannels(channels, cutoff, taps = 63) {
  const h = new Float32Array(taps);
  const mid = (taps - 1) / 2;
  let sum = 0;
  for (let k = 0; k < taps; k++) {
    const x = k - mid;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (taps - 1));
    h[k] = sinc * w;
    sum += h[k];
  }
  for (let k = 0; k < taps; k++) h[k] /= sum;
  return channels.map((c) => {
    const out = new Float32Array(c.length);
    const n = c.length;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      if (i >= mid && i + mid < n) {
        for (let k = 0; k < taps; k++) acc += h[k] * c[i + k - mid];
      } else {
        // past the ends the edge sample holds (zeros would pull the first and last samples towards silence)
        for (let k = 0; k < taps; k++) { const j = i + k - mid; acc += h[k] * c[j < 0 ? 0 : j >= n ? n - 1 : j]; }
      }
      out[i] = acc;
    }
    return out;
  });
}

// windowed-sinc interpolation kernel for making a signal longer: 16 taps each side, tabulated at 512 sub-sample phases
const K = 16;
const PHASES = 512;
let kernel = null;
function sincKernel() {
  if (kernel) return kernel;
  kernel = new Float32Array((PHASES + 1) * 2 * K);
  const fc = 0.92; // just under the original Nyquist: nothing above it is made up
  for (let ph = 0; ph <= PHASES; ph++) {
    const frac = ph / PHASES;
    let sum = 0;
    for (let k = -K + 1; k <= K; k++) {
      const t = k - frac;
      const x = Math.PI * fc * t;
      const sinc = t === 0 ? 1 : Math.sin(x) / x;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / K) + 0.08 * Math.cos((2 * Math.PI * t) / K); // Blackman
      const v = Math.abs(t) >= K ? 0 : sinc * w;
      kernel[ph * 2 * K + (k + K - 1)] = v;
      sum += v;
    }
    for (let k = 0; k < 2 * K; k++) kernel[ph * 2 * K + k] /= sum;
  }
  return kernel;
}

/** Interpolate c at positions 0, step, 2 × step … (m of them) with the windowed sinc; past the ends the edge sample holds. */
function sincResample(c, m, step, kern) {
  const out = new Float32Array(m);
  const last = c.length - 1;
  const taps = 2 * K;
  for (let o = 0; o < m; o++) {
    const p = Math.min(last, o * step);
    const i = Math.floor(p);
    const row = Math.round((p - i) * PHASES) * taps;
    const j0 = i - K + 1;
    let acc = 0;
    if (j0 >= 0 && j0 + taps - 1 <= last) {
      for (let k = 0; k < taps; k++) acc += c[j0 + k] * kern[row + k];
    } else {
      for (let k = 0; k < taps; k++) { const j = j0 + k; acc += c[j < 0 ? 0 : j > last ? last : j] * kern[row + k]; }
    }
    out[o] = acc;
  }
  return out;
}

/**
 * Where band-limiting made peaks (a square wave's ringing) pass −0.2 dBFS and the input's own peak, turn down just
 * those moments: a gain that dips smoothly over ±W samples around each overshoot (the minimum of the needed gain over
 * the window, then averaged over it, so no sample keeps more gain than it needs) — the level elsewhere is untouched.
 */
function keepUnder(channels, out) {
  let pin = 0;
  let pout = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) pin = Math.max(pin, Math.abs(c[i]));
  for (const c of out) for (let i = 0; i < c.length; i++) pout = Math.max(pout, Math.abs(c[i]));
  const ceiling = Math.max(pin, 0.977);
  if (pout <= ceiling) return out;
  const n = out[0].length;
  const need = new Float32Array(n).fill(1);
  for (const c of out) for (let i = 0; i < n; i++) { const a = Math.abs(c[i]); if (a > ceiling) need[i] = Math.min(need[i], ceiling / a); }
  const W = 96;
  const low = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    if (need[i] >= 1) continue;
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) if (need[i] < low[j]) low[j] = need[i];
  }
  let sum = 0;
  for (let i = 0; i < Math.min(n, W); i++) sum += low[i];
  for (let i = 0; i < n; i++) {
    if (i + W < n) sum += low[i + W];
    if (i - W - 1 >= 0) sum -= low[i - W - 1];
    const g = Math.min(need[i], sum / (Math.min(n - 1, i + W) - Math.max(0, i - W) + 1));
    if (g < 1) for (const c of out) c[i] *= g;
  }
  return out;
}

/**
 * Resample channels to `outLen` frames (output frame i reads input position i × n / outLen). Shrinking low-passes
 * and interpolates; stretching interpolates with a windowed sinc, so no mirror images of the original appear above it.
 * The result never clips where the input didn't.
 */
export function resampleChannels(channels, outLen) {
  const n = channels[0].length;
  const m = Math.max(1, Math.round(outLen));
  if (m === n) return channels.map((c) => c.slice());
  if (!n) return channels.map(() => new Float32Array(m));
  const ratio = m / Math.max(1, n);
  if (ratio >= 1) {
    const kern = sincKernel();
    return keepUnder(channels, channels.map((c) => sincResample(c, m, n / m, kern)));
  }
  const src = lowpassChannels(channels, 0.42 * ratio, tapsFor(ratio));
  return keepUnder(channels, src.map((c) => {
    const out = new Float32Array(m);
    for (let i = 0; i < m; i++) out[i] = cubicAt(c, i / ratio);
    return out;
  }));
}
