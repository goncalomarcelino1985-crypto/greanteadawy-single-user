// Small Web Audio helpers shared by instruments and effects.

const noiseCache = new WeakMap();

/** 2 seconds of white noise (cached per context). */
export function noiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    const len = Math.floor(ctx.sampleRate * 2);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed / 0x3fffffff) - 1;
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

export function noiseSource(ctx, loop = true) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = loop;
  return src;
}

const curveCache = new Map();

/** Waveshaper curve. mode: soft (tanh), hard (clip), fold (wavefolder), crush (bit reduction) */
export function shaperCurve(mode, amount) {
  const key = `${mode}:${Math.round(amount * 1000)}`;
  if (curveCache.has(key)) return curveCache.get(key);
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    let y;
    switch (mode) {
      case 'hard': {
        const k = 1 + amount * 20;
        y = Math.max(-1, Math.min(1, x * k)) ;
        break;
      }
      case 'fold': {
        const k = 1 + amount * 6;
        y = Math.sin(x * k * Math.PI / 2);
        break;
      }
      case 'crush': {
        const levels = Math.pow(2, Math.max(1, Math.round(amount)));
        y = Math.round(x * levels / 2) / (levels / 2);
        break;
      }
      case 'clip': {
        // safety clipper: linear up to 0.86 × the ceiling, then a smooth knee that tops out 0.4 dB under it — the
        // oversampling filters ring a little past the curve, and that overshoot must still stay under the ceiling
        const c = amount;
        const top = c * 0.955;
        const knee = c * 0.86;
        const ax = Math.abs(x);
        y = ax < knee ? x : Math.sign(x) * (knee + (top - knee) * Math.tanh((ax - knee) / (top - knee)));
        break;
      }
      case 'soft':
      default: {
        const k = 1 + amount * 30;
        y = Math.tanh(x * k) / Math.tanh(k);
      }
    }
    curve[i] = y;
  }
  if (curveCache.size > 200) curveCache.clear();
  curveCache.set(key, curve);
  return curve;
}

/**
 * Web Audio reads the Q of low-pass/high-pass biquads in dB: -3.01 dB is a flat Butterworth response (Q = 1/√2).
 * A linear 0.707 there would add a resonant bump at the cutoff. (Peaking/band-pass/notch Q is linear.)
 */
export const FLAT_Q = -3.0103;

export const dbToGain = (db) => Math.pow(10, db / 20);

/**
 * The automatic makeup gain (dB) a DynamicsCompressorNode adds, following the Web Audio / Chromium algorithm:
 * the static curve is linear up to the threshold, a soft exponential knee whose slope reaches 1/ratio at
 * threshold + knee, then 1/ratio; makeup = (1 / curve(0 dBFS))^0.6. Effects divide it back out.
 */
export function compressorAutoMakeupDb(thresholdDb, kneeDb, ratio) {
  const lin = (db) => Math.pow(10, db / 20);
  const db = (x) => 20 * Math.log10(Math.max(x, 1e-12));
  const t = lin(thresholdDb);
  const kneeCurve = (x, k) => (x < t ? x : t + (1 - Math.exp(-k * (x - t))) / k);
  const slopeAt = (x, k) => {
    if (x < t) return 1;
    const x2 = x * 1.001;
    return (db(kneeCurve(x2, k)) - db(kneeCurve(x, k))) / (db(x2) - db(x));
  };
  const kneeEndDb = thresholdDb + kneeDb;
  const kneeEnd = lin(kneeEndDb);
  let k = 5;
  if (kneeDb > 0) {
    let lo = 0.1;
    let hi = 10000;
    for (let i = 0; i < 15; i++) {
      if (slopeAt(kneeEnd, k) < 1 / ratio) hi = k; else lo = k;
      k = Math.sqrt(lo * hi);
    }
  }
  const yKneeEndDb = db(kneeCurve(kneeEnd, k));
  const fullRange = 1 < kneeEnd ? kneeCurve(1, k) : lin(yKneeEndDb + (1 / ratio) * (0 - kneeEndDb));
  return 0.6 * -db(fullRange);
}
export const gainToDb = (g) => (g <= 0.00001 ? -Infinity : 20 * Math.log10(g));

/** Map normalized 0..1 to a param range (log or linear). */
export function denormalize(v, def) {
  const { min, max, curve } = def;
  if (curve === 'log' && min > 0) return min * Math.pow(max / min, v);
  return min + (max - min) * v;
}

export function normalize(value, def) {
  const { min, max, curve } = def;
  if (curve === 'log' && min > 0) return Math.log(value / min) / Math.log(max / min);
  return (value - min) / (max - min);
}

/** Safely set an AudioParam now (smoothly, to avoid zipper noise). */
const initialized = new WeakSet();

/**
 * Set an AudioParam, gliding (no zipper noise) when it changes later — but jump straight to the first value: a node
 * that starts at its built-in default and glides from there would colour the first ~50 ms of every render (an EQ
 * starting at 350 Hz, a compressor without its makeup correction).
 */
export function setParam(param, value, ctx, smooth = 0.015) {
  if (!param || !Number.isFinite(value)) return;
  const t = ctx.currentTime;
  try {
    param.cancelScheduledValues(t);
    if (initialized.has(param)) param.setTargetAtTime(value, t, smooth);
    else {
      initialized.add(param);
      param.setValueAtTime(value, t);
    }
  } catch {
    param.value = value;
  }
}

/**
 * ADSR envelope on an AudioParam. Returns { valueAt, release(time), kill(time) }.
 * Release works both when scheduled ahead of time (sequencer notes) and live (key up),
 * including notes released before the attack has finished.
 */
export function adsr(param, start, { attack = 0.005, decay = 0.2, sustain = 0.7, release = 0.2 }, peak = 1) {
  const a = Math.max(0.001, attack);
  const d = Math.max(0.005, decay);
  const s = Math.max(0, Math.min(1, sustain)) * peak;
  const r = Math.max(0.003, release);
  param.cancelScheduledValues(start);
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + a);
  // setTargetAtTime's event time is the start of the decay, so a later cancelScheduledValues(t) keeps it
  param.setTargetAtTime(s, start + a, d / 3);
  const valueAt = (t) => {
    const dt = t - start;
    if (dt <= 0) return 0;
    if (dt < a) return peak * (dt / a);
    return s + (peak - s) * Math.exp(-(dt - a) / (d / 3));
  };
  let releasedAt = null;
  return {
    valueAt,
    release(time, now = -Infinity) {
      if (releasedAt !== null && releasedAt <= time) return releasedAt + r * 5;
      const t = Math.max(time, start);
      releasedAt = t;
      const v = valueAt(t);
      if (t < start + a) {
        if (start >= now) {
          // still in the future: rebuild a shortened attack that ends at the release point
          param.cancelScheduledValues(start);
          param.setValueAtTime(0, start);
          param.linearRampToValueAtTime(v, t);
        } else if (param.cancelAndHoldAtTime) {
          param.cancelAndHoldAtTime(t);
        } else {
          param.cancelScheduledValues(t);
          param.setValueAtTime(v, t);
        }
      } else {
        // the linear attack ramp and the setTarget decay both start before t, so cancelling from t keeps them
        param.cancelScheduledValues(t);
        param.setValueAtTime(v, t);
      }
      param.setTargetAtTime(0, t, r / 4);
      return t + r * 1.5;
    },
    kill(time) {
      const t = Math.max(time, start);
      const v = releasedAt !== null && t > releasedAt ? 0.0001 : valueAt(t);
      param.cancelScheduledValues(t);
      param.setValueAtTime(v, t);
      param.linearRampToValueAtTime(0, t + 0.008);
      releasedAt = t;
      return t + 0.01;
    }
  };
}

/** Simple decaying (percussive) envelope: peak -> 0 over `decay` seconds, exponential. */
export function percEnv(param, start, peak, decay, attack = 0.001) {
  param.cancelScheduledValues(start);
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + attack);
  param.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.0005), start + attack + Math.max(0.005, decay));
  param.setValueAtTime(0, start + attack + Math.max(0.005, decay) + 0.001);
  return start + attack + decay + 0.01;
}

/** Velocity → timbre multiplier: 1 at the default velocity 0.8, `floor` + slope above/below (soft = darker). */
export const timbre = (velRaw, floor) => floor + ((1 - floor) / 0.8) * velRaw;

const phasedWaves = new WeakMap();
/**
 * A sine PeriodicWave starting at `phase` (radians). LFOs built from it at note start continue one shared cycle
 * (phase = 2π·rate·startTime), so every note's tremolo or rotary moves together instead of each restarting at 0.
 */
export function phasedSine(ctx, phase) {
  let m = phasedWaves.get(ctx);
  if (!m) phasedWaves.set(ctx, (m = new Map()));
  const q = ((Math.round((phase / (2 * Math.PI)) * 256) % 256) + 256) % 256;
  let w = m.get(q);
  if (!w) {
    const ph = (q / 256) * 2 * Math.PI;
    w = ctx.createPeriodicWave(new Float32Array([0, Math.sin(ph)]), new Float32Array([0, Math.cos(ph)]), { disableNormalization: true });
    m.set(q, w);
  }
  return w;
}
