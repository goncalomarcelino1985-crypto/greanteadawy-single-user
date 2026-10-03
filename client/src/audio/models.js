// Physical-model instruments rendered note by note into sample buffers (pure JS, no Web Audio — testable in Node):
// piano, guitar, bass, pizzicato and the world strings (sitar, tanpura, santoor, koto, guzheng, pipa, shamisen).
// Plucked strings use Karplus–Strong with a tuned fractional delay; the piano sums inharmonic, two-stage-decaying
// partials. Notes are cached by (model, sample rate, key, velocity layer, params), so each one is computed once.

const TAU = Math.PI * 2;

/** Deterministic noise (xorshift32) so a note renders the same every time. */
function noise(seed) {
  let s = (seed ^ 0x9e3779b9) >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

const midiHz = (key) => 440 * Math.pow(2, (key - 69) / 12);

/** RBJ peaking biquad applied in place. */
function peaking(x, sr, f, q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w = (TAU * Math.min(f, sr * 0.45)) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const a0 = 1 + alpha / A;
  const b0 = (1 + alpha * A) / a0; const b1 = (-2 * cos) / a0; const b2 = (1 - alpha * A) / a0;
  const a1 = (-2 * cos) / a0; const a2 = (1 - alpha / A) / a0;
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
}

/** One-pole low-pass applied in place (cutoff in Hz). */
function onePoleLp(x, sr, f) {
  const a = 1 - Math.exp((-TAU * Math.min(f, sr * 0.45)) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); x[i] = y; }
}

const ATTACK_RMS = Math.pow(10, -18 / 20);
const SOFT_KNEE = 0.75;

/**
 * Level a rendered note by the loudness of its first 300 ms (not its peak: plucks and hammers start with a spiky
 * transient, and peak normalization left them ~15 dB quieter than sustained instruments), soft-limit what remains of
 * the transient above 0.75 (tops out under 0.95) and fade the last `fadeMs` so the buffer never ends mid-waveform.
 */
function finish(x, sr, fadeMs = 30) {
  const n = Math.min(x.length, Math.round(sr * 0.3));
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i] * x[i];
  const rms = Math.sqrt(s / Math.max(1, n));
  const g = rms > 1e-9 ? ATTACK_RMS / rms : 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * g;
    const a = Math.abs(v);
    x[i] = a <= SOFT_KNEE ? v : Math.sign(v) * (SOFT_KNEE + 0.2 * Math.tanh((a - SOFT_KNEE) / 0.2));
  }
  const f = Math.min(x.length, Math.round((sr * fadeMs) / 1000));
  for (let i = 0; i < f; i++) x[x.length - 1 - i] *= i / f;
  return x;
}

/**
 * Karplus–Strong plucked string.
 * opts: { t60 (s, decay of the fundamental), brightness 0..1 (pick/finger hardness and string damping),
 *         position 0.05..0.5 (pluck point: lower = brighter, nasal), seconds, seed, attackNoise (0..1 extra pick noise) }
 */
export function pluckString(sr, freq, { t60 = 4, brightness = 0.6, position = 0.18, seconds = 4, seed = 1, attackNoise = 0, noiseMix = 1 } = {}) {
  const len = Math.max(64, Math.ceil(sr * seconds));
  const out = new Float32Array(len);
  const rand = noise(seed + Math.round(freq * 100));
  // damping low-pass inside the loop (darker strings lose highs faster); its phase delay is compensated below
  const lpHz = 800 + brightness * brightness * 9000 + freq * 2;
  const a = 1 - Math.exp((-TAU * Math.min(lpHz, sr * 0.45)) / sr);
  const lpDelay = (1 - a) / a; // low-frequency phase delay of the one-pole, in samples
  const period = sr / freq;
  let total = period - 0.5 - lpDelay; // the two-point average adds half a sample
  if (total < 2) total = 2;
  let Li = Math.floor(total);
  let d = total - Li;
  if (d < 0.1 && Li > 2) { Li -= 1; d += 1; } // keep the allpass coefficient well-behaved
  const c = (1 - d) / (1 + d);
  const g = Math.pow(10, -3 / (Math.max(0.05, t60) * freq)); // per-period loss for the requested T60
  const line = new Float64Array(Li);
  // excitation: one period of filtered noise, combed at the pluck position
  const ex = new Float64Array(Li);
  let lp = 0;
  const exA = 0.15 + brightness * 0.85;
  for (let i = 0; i < Li; i++) { lp += exA * (rand() - lp); ex[i] = lp; }
  const comb = Math.max(1, Math.round(position * Li));
  // excitation = noiseMix × noise combed at the pluck point + (1 − noiseMix) × the string's real starting shape, a
  // triangle peaking at the pluck point (harmonics ∝ sin(nπ·position)/n²: a round, fundamental-heavy pluck)
  let exPeak = 0;
  for (let i = 0; i < Li; i++) { line[i] = ex[i] - (i >= comb ? ex[i - comb] : 0); exPeak = Math.max(exPeak, Math.abs(line[i])); }
  if (noiseMix < 1) {
    const k = exPeak || 1;
    for (let i = 0; i < Li; i++) {
      const tri = i < comb ? i / comb : (Li - i) / (Li - comb);
      line[i] = noiseMix * line[i] + (1 - noiseMix) * k * tri;
    }
  }
  let mean = 0;
  for (let i = 0; i < Li; i++) mean += line[i];
  mean /= Li;
  for (let i = 0; i < Li; i++) line[i] -= mean;
  let idx = 0;
  let prev = 0;
  let apX = 0;
  let apY = 0;
  let filt = 0;
  for (let n = 0; n < len; n++) {
    const cur = line[idx];
    out[n] = cur;
    const avg = 0.5 * (cur + prev);
    prev = cur;
    filt += a * (avg - filt);
    // first-order allpass for the fractional part of the delay (exact tuning)
    const y = c * filt + apX - c * apY;
    apX = filt; apY = y;
    line[idx] = g * y;
    idx = idx + 1 === Li ? 0 : idx + 1;
  }
  if (attackNoise > 0) {
    const n = Math.min(len, Math.round(sr * 0.012));
    const r = noise(seed * 7 + 3);
    for (let i = 0; i < n; i++) out[i] += attackNoise * 0.6 * r() * (1 - i / n) * (1 - i / n);
  }
  return out;
}

/** Guitar note: string + body (acoustic / nylon) or pickup (electric) colouring. */
export function renderGuitar(sr, key, vel, p) {
  const f = midiHz(key);
  const bright = Math.max(0, Math.min(1, p.brightness * (0.6 + 0.5 * vel)));
  const mute = p.mute || 0;
  const t60 = Math.max(0.15, p.sustain * Math.pow(2, -(key - 52) / 24) * (1 - 0.9 * mute));
  const seconds = Math.min(10, t60 * 1.15 + 0.1);
  const x = pluckString(sr, f, {
    t60, seconds, seed: key * 13, // same noise for every velocity layer: only the brightness changes
    brightness: bright * (1 - 0.6 * mute) * (p.body === 'nylon' ? 0.7 : 1),
    position: p.position, attackNoise: (p.body === 'nylon' ? 0.05 : 0.15) * vel
  });
  if (p.body === 'acoustic') {
    peaking(x, sr, 105, 2.2, 6); peaking(x, sr, 220, 2, 3.5); peaking(x, sr, 2600, 1.2, 2.5);
  } else if (p.body === 'nylon') {
    peaking(x, sr, 110, 2, 5); peaking(x, sr, 260, 2, 2.5); onePoleLp(x, sr, 5200);
  } else {
    peaking(x, sr, 2200, 1.5, 4); onePoleLp(x, sr, 6000); // pickup resonance, no body
  }
  if (mute > 0) onePoleLp(x, sr, 6000 - 4800 * mute);
  return finish(x, sr);
}

/**
 * Bass guitar / upright note. Mostly the string's own (triangle) pluck shape — a bass lives on its fundamental and
 * first few harmonics — with a little noise for the finger/pick/slap attack, through a pickup + amp low-pass.
 */
export function renderBass(sr, key, vel, p) {
  const f = midiHz(key);
  const style = p.style || 'finger';
  const mute = p.mute || 0;
  const base = { finger: 0.25, pick: 0.55, slap: 0.75, upright: 0.15 }[style] ?? 0.25;
  const bright = Math.max(0, Math.min(1, (base + p.brightness * 0.5) * (0.65 + 0.45 * vel) * (1 - 0.6 * mute)));
  const t60 = Math.max(0.12, p.sustain * (style === 'upright' ? 0.6 : 1) * Math.pow(2, -(key - 40) / 30) * (1 - 0.85 * mute));
  const seconds = Math.min(9, t60 * 1.15 + 0.1);
  const x = pluckString(sr, f, {
    t60, seconds, seed: key * 31, brightness: bright * 0.7,
    position: style === 'pick' ? 0.1 : style === 'slap' ? 0.08 : 0.2,
    // a harder pluck is less round: more of the noisy, harmonic-rich attack
    noiseMix: Math.min(0.8, ({ finger: 0.25, pick: 0.4, slap: 0.45, upright: 0.15 }[style] ?? 0.25) * (0.4 + 1.2 * vel)),
    attackNoise: (style === 'slap' ? 0.7 : style === 'pick' ? 0.2 : 0.08) * vel
  });
  if (style === 'upright') {
    peaking(x, sr, 95, 1.6, 4);
    onePoleLp(x, sr, 1400 + 1200 * bright); onePoleLp(x, sr, 2600);
  } else {
    // a magnetic pickup near the bridge hears the string as a comb (no harmonics at multiples of 1/position):
    // it lifts the 2nd–4th harmonics that make a bass audible on small speakers
    const d = Math.max(1, Math.round((sr / f) * (style === 'pick' ? 0.12 : 0.18)));
    for (let i = x.length - 1; i >= d; i--) x[i] -= 0.85 * x[i - d];
    const lp = 900 + 4500 * bright * bright;
    onePoleLp(x, sr, lp); onePoleLp(x, sr, lp * 1.8);
    if (style === 'slap') { peaking(x, sr, 500, 1, -4); peaking(x, sr, 3000, 1, 7); } // scooped mids, snappy top
  }
  return finish(x, sr);
}

/** Pizzicato string (strings instrument). */
export function renderPizzicato(sr, key, vel, p) {
  const f = midiHz(key);
  const t60 = Math.max(0.15, 1.2 * Math.pow(2, -(key - 55) / 18));
  const x = pluckString(sr, f, { t60, seconds: Math.min(3, t60 + 0.1), seed: key * 5 + 1, brightness: 0.25 + 0.4 * p.brightness * vel, position: 0.3 });
  peaking(x, sr, 280, 1.5, 5); peaking(x, sr, 2800, 1.2, 3);
  return finish(x, sr);
}

/**
 * Acoustic piano note: inharmonic partials (f_n = n·f0·√(1 + B·n²)) with a hammer-shaped spectrum, a strike-position
 * comb, two-stage decay (prompt + aftersound) that is faster for high partials and high notes, beating unison strings
 * and a short hammer noise.
 */
export function renderPiano(sr, key, vel, p) {
  const f0 = midiHz(key);
  const hardness = Math.max(0, Math.min(1, p.hardness * 0.6 + vel * 0.6));
  const bright = Math.max(0.05, p.brightness);
  const B = 0.00005 * Math.exp(0.055 * (key - 21)); // ≈ 0.0004 at C4, like a concert grand
  const t60 = Math.min(18, Math.max(0.6, p.decay * Math.pow(2, -(key - 48) / 22)));
  const seconds = Math.min(10, t60 + 0.3); // past 10 s the aftersound is ~60 dB down; a 60 ms fade ends it
  const len = Math.ceil(sr * seconds);
  const out = new Float32Array(len);
  const nyq = sr * 0.45;
  const nc = 3 + 26 * hardness * bright; // spectral roll-off point (harmonic number)
  const strings = key < 32 ? 1 : key < 46 ? 2 : 3;
  const detune = p.detune || 0; // cents between neighbouring unison strings
  let maxN = 1;
  while (maxN < 64 && (maxN + 1) * f0 * Math.sqrt(1 + B * (maxN + 1) * (maxN + 1)) < nyq) maxN++;
  for (let n = 1; n <= maxN; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n);
    let amp = 1 / Math.pow(n, 0.8 + (1 - bright) * 0.9 + (1 - vel) * 0.5); // soft notes have fewer overtones
    amp /= 1 + Math.pow(n / nc, 3);
    amp *= 0.15 + Math.abs(Math.sin((Math.PI * n) / 8)); // hammer strikes at ~1/8 of the string
    if (amp < 0.0008) continue;
    const tn = t60 / (1 + 0.22 * (n - 1) + fn / 6000);
    const tau2 = tn / 6.9;
    const tau1 = tau2 * 0.15; // prompt sound (energy leaving through the bridge) vs the slow aftersound
    const life = Math.min(len, Math.ceil(sr * Math.min(seconds, tau2 * Math.log(amp / 0.00005))));
    if (life <= 0) continue;
    const k1 = Math.exp(-1 / (sr * tau1));
    const k2 = Math.exp(-1 / (sr * tau2));
    // unison strings beat against the main one (low partials only — that's where it's heard). Equal strings would
    // cancel completely at the bottom of each beat; the bridge coupling of a real piano keeps it shallow, except
    // when the unisons are far out of tune (honky-tonk), so the side strings get louder with the detune.
    const nStr = n <= 8 ? strings : 1;
    const side = Math.min(0.5, 0.15 + 0.035 * detune);
    const norm = 1 + (nStr - 1) * side;
    for (let s = 0; s < nStr; s++) {
      const off = s === 0 ? 0 : (s === 1 ? 1 : -1) * detune;
      const weight = (s === 0 ? 1 : side) / norm;
      const w = (TAU * fn * Math.pow(2, off / 1200)) / sr;
      // recursive sine oscillator: y[n] = 2cos(w)·y[n-1] − y[n-2]
      const c2 = 2 * Math.cos(w);
      // the hammer strikes all unison strings at once: they start in phase and drift apart (beating)
      let y1 = Math.sin(-w);
      let y2 = Math.sin(-2 * w);
      let e1 = 0.6 * amp * weight;
      let e2 = 0.4 * amp * weight;
      for (let i = 0; i < life; i++) {
        const y = c2 * y1 - y2;
        y2 = y1; y1 = y;
        out[i] += y * (e1 + e2);
        e1 *= k1; e2 *= k2;
      }
    }
  }
  // hammer thump/noise
  const hn = Math.round(sr * (0.004 + 0.012 * (1 - hardness)));
  const r = noise(key * 17 + 5);
  let lp = 0;
  const a = 0.05 + 0.5 * hardness;
  for (let i = 0; i < hn && i < len; i++) { lp += a * (r() - lp); out[i] += lp * 0.12 * vel * (1 - i / hn); }
  // a gentle fade-in of 1 ms avoids a click from the partials' random start phases
  const fi = Math.round(sr * 0.001);
  for (let i = 0; i < fi; i++) out[i] *= i / fi;
  return finish(out, sr, 60);
}

// ------------------------------------------------------------------ world strings
// sitar, tanpura, santoor (Indian); koto, guzheng, pipa, shamisen (East Asian)

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Karplus–Strong string for the world instruments: pluckString's tuned loop, made to hold `t60` for high notes too
 * (a santoor or guzheng keeps ringing up top), with an optional mallet strike (`strike` = pulse width in ms, santoor) instead of a pluck: a raised-cosine pulse, shorter =
 * a harder, brighter mallet.
 */
export function worldString(sr, freq, { t60 = 3, brightness = 0.6, position = 0.15, seconds = 3, seed = 1, attackNoise = 0, noiseMix = 1, strike = 0 } = {}) {
  const len = Math.max(64, Math.ceil(sr * seconds));
  const out = new Float32Array(len);
  const rand = noise(seed + Math.round(freq * 100));
  const w0 = (TAU * freq) / sr;
  const target = Math.pow(10, -3 / (Math.max(0.05, t60) * freq)); // per-period gain for the requested T60
  const onePole = (hz) => 1 - Math.exp((-TAU * hz) / sr);
  const hLpAt = (a) => a / Math.sqrt(1 - 2 * (1 - a) * Math.cos(w0) + (1 - a) * (1 - a));
  const hAvgAt = (s) => Math.sqrt((1 - s) * (1 - s) + s * s + 2 * s * (1 - s) * Math.cos(w0));
  // a high note goes round the loop a thousand times a second, so even small filter losses at f0 add up to a quick
  // death: open the damping low-pass, then lighten the averager (y = (1−S)·x + S·x₋₁), until the loss at f0 fits
  // the requested T60. The loop gain stays below 1 at DC (stable).
  let lpHz = Math.min(sr * 0.45, 800 + brightness * brightness * 9000 + freq * 2);
  let a = onePole(lpHz);
  let S = 0.5;
  for (let i = 0; i < 120 && hAvgAt(S) * hLpAt(a) * 0.99995 < target; i++) {
    if (lpHz < sr * 0.45) a = onePole((lpHz = Math.min(sr * 0.45, lpHz * 1.15)));
    else if (S > 0.01) S *= 0.85;
    else if (a < 1) a = 1; // the very top of the range: no damping filter at all, the gain alone sets the decay
    else { S = 0; break; }
  }
  const g = Math.min(0.99995, target / (hAvgAt(S) * hLpAt(a)));
  // tuning: the delay line + a first-order allpass make up the period minus the filters' exact phase delay at f0
  const avgDelay = Math.atan2(S * Math.sin(w0), 1 - S + S * Math.cos(w0)) / w0;
  const lpDelay = Math.atan2((1 - a) * Math.sin(w0), 1 - (1 - a) * Math.cos(w0)) / w0;
  let total = sr / freq - avgDelay - lpDelay;
  if (total < 2) total = 2;
  let Li = Math.floor(total);
  let d = total - Li;
  if (d < 0.1 && Li > 2) { Li -= 1; d += 1; }
  const c = Math.sin((w0 * (1 - d)) / 2) / Math.sin((w0 * (1 + d)) / 2);
  const line = new Float64Array(Li);
  const ex = new Float64Array(Li);
  if (strike > 0) {
    const w = Math.max(2, Math.min(Li - 1, Math.round((sr * strike) / 1000)));
    for (let i = 0; i < w; i++) ex[i] = 0.5 * (1 - Math.cos((TAU * i) / w));
  } else {
    let lp = 0;
    const exA = 0.15 + brightness * 0.85;
    for (let i = 0; i < Li; i++) { lp += exA * (rand() - lp); ex[i] = lp; }
  }
  const comb = Math.max(1, Math.round(position * Li));
  let exPeak = 0;
  for (let i = 0; i < Li; i++) { line[i] = ex[i] - (i >= comb ? ex[i - comb] : 0); exPeak = Math.max(exPeak, Math.abs(line[i])); }
  if (noiseMix < 1 && !strike) {
    const k = exPeak || 1;
    for (let i = 0; i < Li; i++) {
      const tri = i < comb ? i / comb : (Li - i) / (Li - comb);
      line[i] = noiseMix * line[i] + (1 - noiseMix) * k * tri;
    }
  }
  let mean = 0;
  for (let i = 0; i < Li; i++) mean += line[i];
  mean /= Li;
  for (let i = 0; i < Li; i++) line[i] -= mean;
  let idx = 0;
  let prev = 0;
  let apX = 0;
  let apY = 0;
  let filt = 0;
  for (let n = 0; n < len; n++) {
    const cur = line[idx];
    out[n] = cur;
    const avg = (1 - S) * cur + S * prev;
    prev = cur;
    filt += a * (avg - filt);
    const y = c * filt + apX - c * apY;
    apX = filt; apY = y;
    line[idx] = g * y;
    idx = idx + 1 === Li ? 0 : idx + 1;
  }
  if (attackNoise > 0) {
    const n = Math.min(len, Math.round(sr * 0.01));
    const r = noise(seed * 7 + 5);
    for (let i = 0; i < n; i++) out[i] += attackNoise * 0.6 * r() * (1 - i / n) * (1 - i / n);
  }
  return out;
}

/**
 * Jawari / sawari bridge buzz, in place. The string touches its curved bridge for a short moment at the top of every
 * cycle; that contact turns each crest into a narrow pulse (u > th, normalised by the string's current amplitude so
 * the buzz lasts as long as the note) whose width sets the colour: ~0.15–0.4 ms pulses put a bright formant at
 * 2–6 kHz, the singing "zing". The contact lengthens as the note dies away, so the formant slides down (the jawari
 * sweep); `bloom` (s) lets the buzz grow in after the pluck, as on a tanpura.
 */
function jawariBuzz(x, sr, freq, amount, bloom = 0) {
  if (amount <= 0.001) return;
  const rel = Math.exp(-1 / (sr * Math.max(0.02, 3 / freq)));
  const hp = Math.exp((-TAU * 700) / sr);
  const contact0 = 0.00012 + 0.00025 * (1 - amount); // s
  let env = 0;
  let envMax = 1e-9;
  let hx = 0;
  let hy = 0;
  let th = 1;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    env = Math.max(Math.abs(v), env * rel);
    envMax = Math.max(envMax, env);
    if ((i & 63) === 0) {
      const contact = contact0 * (1 + 2 * (1 - Math.sqrt(env / envMax)));
      th = Math.cos(Math.min(Math.PI / 2, Math.PI * freq * contact));
    }
    const u = v / (env + 1e-9);
    const over = u > th ? (u - th) / (1 - th + 1e-6) : 0;
    const b = over * env * (bloom > 0 ? 1 - 0.75 * Math.exp(-i / (sr * bloom)) : 1);
    const y = hp * (hy + b - hx); // one-pole high-pass: the buzz lives in the upper partials
    hx = b; hy = y;
    x[i] = v + amount * 4 * y;
  }
}

/** One-pole DC blocker in place (the one-sided bridge pushes the waveform off centre). */
function dcBlock(x, sr, f = 20) {
  const R = Math.exp((-TAU * f) / sr);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = x[i] - x1 + R * y1;
    x1 = x[i]; y1 = y;
    x[i] = y;
  }
}

/**
 * Sympathetic strings: two-pole resonators at fixed pitches, driven by the played string. They ring only when the note
 * or one of its harmonics matches their tuning — the shimmering halo of a sitar's taraf.
 */
function sympathetic(x, sr, keys, amount, t60 = 2.5) {
  const add = new Float64Array(x.length);
  const r = Math.pow(10, -3 / (t60 * sr));
  for (const k of keys) {
    const f = midiHz(k);
    if (f > sr * 0.4) continue;
    const w = (TAU * f) / sr;
    const c1 = 2 * r * Math.cos(w);
    const c2 = -r * r;
    const gIn = (1 - r) * 2 * Math.sin(w); // ≈ unity gain at resonance
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const y = c1 * y1 + c2 * y2 + gIn * x[i];
      y2 = y1; y1 = y;
      add[i] += y;
    }
  }
  for (let i = 0; i < x.length; i++) x[i] += amount * add[i];
}

/** A plectrum (bachi) hitting a skin: a short burst of band-limited noise (lp − lp = a band) added to the start. */
function skinHit(x, sr, seed, level, centre, decay) {
  const n = Math.min(x.length, Math.round(sr * decay * 5));
  const r = noise(seed);
  const aHi = 1 - Math.exp((-TAU * centre * 2) / sr);
  const aLo = 1 - Math.exp((-TAU * centre * 0.5) / sr);
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const v = r();
    hi += aHi * (v - hi);
    lo += aLo * (v - lo);
    x[i] += level * 2.5 * (hi - lo) * Math.exp(-i / (sr * decay));
  }
}

const SA_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const TARAF = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19]; // sympathetic strings: Sa's major scale (Bilawal), ~1½ octaves

export function renderSitar(sr, key, vel, p) {
  const f = midiHz(key);
  const bright = clamp01(p.brightness * (0.55 + 0.6 * vel));
  const t60 = Math.max(0.3, p.sustain * Math.pow(2, -(key - 60) / 30));
  const symp = p.sympathetic || 0;
  const seconds = Math.min(10, t60 * 1.1 + 0.2 + symp * 1.5);
  const x = worldString(sr, f, { t60, seconds, seed: key * 19 + 7, brightness: bright, position: 0.13, noiseMix: 0.6, attackNoise: 0.3 * vel });
  jawariBuzz(x, sr, f, p.jawari);
  dcBlock(x, sr);
  peaking(x, sr, 180, 1.5, 4); peaking(x, sr, 1100, 1.2, 2); peaking(x, sr, 3300, 1.5, 3 + 3 * p.jawari);
  if (symp > 0) sympathetic(x, sr, TARAF.map((s) => 60 + Math.max(0, SA_NOTES.indexOf(p.sa)) + s), symp * 0.6);
  return finish(x, sr);
}

export function renderTanpura(sr, key, vel, p) {
  const f = midiHz(key);
  const t60 = Math.max(1, p.sustain * Math.pow(2, -(key - 48) / 36));
  const x = worldString(sr, f, {
    t60, seconds: Math.min(10, t60 * 1.05 + 0.2), seed: key * 23 + 1,
    brightness: clamp01(0.25 + 0.6 * p.brightness * (0.7 + 0.4 * vel)), position: 0.22, noiseMix: 0.2, attackNoise: 0.04 * vel
  });
  jawariBuzz(x, sr, f, p.jawari, 0.6);
  dcBlock(x, sr);
  peaking(x, sr, 130, 1.5, 4); peaking(x, sr, 2600, 1.2, 2 + 4 * p.jawari);
  return finish(x, sr, 80);
}

export function renderSantoor(sr, key, vel, p) {
  const f = midiHz(key);
  const hard = clamp01(p.hardness * 0.7 + vel * 0.5);
  const t60 = Math.max(0.5, p.sustain * Math.pow(2, -(key - 72) / 30));
  const seconds = Math.min(10, t60 * 1.1 + 0.15);
  const strike = 0.25 + (1 - hard) * 1.6; // ms
  const spread = 0.6 + 3.4 * (p.shimmer ?? 0.4); // cents: the strings of a course never quite agree
  const x = new Float32Array(Math.max(64, Math.ceil(sr * seconds)));
  [[0, 1], [1, 0.75], [-0.55, 0.6]].forEach(([d, w], i) => {
    const s = worldString(sr, f * Math.pow(2, (d * spread) / 1200), {
      t60: t60 * (1 - 0.08 * i), seconds, seed: key * 29 + i * 101,
      brightness: clamp01(0.3 + 0.65 * p.brightness * (0.6 + 0.5 * hard)), position: 0.11, strike, attackNoise: 0.1 * hard
    });
    for (let j = 0; j < x.length; j++) x[j] += w * s[j];
  });
  peaking(x, sr, 420, 1.4, 3); peaking(x, sr, 2200, 1.3, 2.5);
  return finish(x, sr, 60);
}

/** Koto, guzheng and pipa: plucked with picks or nails, coloured by their bodies. */
const ZITHERS = {
  koto: { ref: 62, slope: 30, noiseMix: 0.55, pick: 0.35, body: [[230, 1.6, 4], [850, 1.4, 2], [2900, 1.4, 3.5]], lp: 9000 },
  guzheng: { ref: 67, slope: 30, noiseMix: 0.6, pick: 0.3, body: [[150, 1.5, 3], [480, 1.5, 2], [3200, 1.3, 3]], partner: 0.25 },
  pipa: { ref: 64, slope: 26, noiseMix: 0.7, pick: 0.5, body: [[260, 1.5, 2], [1050, 1.3, 5], [3500, 1.5, 2]] }
};

function renderZither(kind) {
  const z = ZITHERS[kind];
  return (sr, key, vel, p) => {
    const f = midiHz(key);
    const bright = clamp01(p.brightness * (0.55 + 0.6 * vel));
    const t60 = Math.max(0.2, p.sustain * Math.pow(2, -(key - z.ref) / z.slope));
    const seconds = Math.min(10, t60 * 1.1 + 0.15);
    const x = worldString(sr, f, { t60, seconds, seed: key * 37 + kind.length, brightness: bright, position: p.position, noiseMix: z.noiseMix, attackNoise: z.pick * vel });
    if (z.partner) {
      // metal-nylon strings ring on with a slow beat: a second, slightly sharp string from the same pluck
      const y = worldString(sr, f * Math.pow(2, 2.5 / 1200), { t60: t60 * 1.15, seconds, seed: key * 41 + 3, brightness: bright * 0.8, position: Math.min(0.4, p.position * 1.3), noiseMix: z.noiseMix });
      for (let i = 0; i < x.length; i++) x[i] += z.partner * y[i];
    }
    for (const [hz, q, db] of z.body) peaking(x, sr, hz, q, db);
    if (z.lp) onePoleLp(x, sr, z.lp);
    return finish(x, sr);
  };
}

export function renderShamisen(sr, key, vel, p) {
  const f = midiHz(key);
  const bright = clamp01(p.brightness * (0.55 + 0.6 * vel));
  const t60 = Math.max(0.2, p.sustain * Math.pow(2, -(key - 57) / 28));
  const x = worldString(sr, f, { t60, seconds: Math.min(10, t60 * 1.1 + 0.15), seed: key * 47, brightness: bright, position: 0.1, noiseMix: 0.65, attackNoise: 0.2 * vel });
  jawariBuzz(x, sr, f, (p.sawari ?? 0.5) * 0.6);
  dcBlock(x, sr);
  skinHit(x, sr, key * 53 + 9, (p.thwack ?? 0.5) * (0.4 + 0.8 * vel), 700, 0.03);
  peaking(x, sr, 620, 1.3, 4); peaking(x, sr, 2600, 1.4, 3);
  return finish(x, sr);
}

// ------------------------------------------------------------------ models per instrument

/** Timbre layers per note: velocity picks one (soft = darker); the voice applies the exact level as gain. */
export const LAYERS = 4;
export const layerOf = (velRaw) => Math.max(0, Math.min(LAYERS - 1, Math.floor(velRaw * LAYERS)));
const layerVelocity = (layer) => (layer + 0.5) / LAYERS;

/** Which params change a rendered note (others — gain, release, stereo, drive — are applied live). */
const MODELS = {
  piano: { render: renderPiano, keys: ['brightness', 'hardness', 'decay', 'detune'] },
  guitar: { render: renderGuitar, keys: ['body', 'brightness', 'position', 'sustain', 'mute'] },
  bass: { render: renderBass, keys: ['style', 'brightness', 'sustain', 'mute'] },
  pizzicato: { render: renderPizzicato, keys: ['brightness'] },
  sitar: { render: renderSitar, keys: ['jawari', 'brightness', 'sustain', 'sympathetic', 'sa'] },
  tanpura: { render: renderTanpura, keys: ['jawari', 'brightness', 'sustain'] },
  santoor: { render: renderSantoor, keys: ['hardness', 'shimmer', 'brightness', 'sustain'] },
  koto: { render: renderZither('koto'), keys: ['brightness', 'sustain', 'position'] },
  guzheng: { render: renderZither('guzheng'), keys: ['brightness', 'sustain', 'position'] },
  pipa: { render: renderZither('pipa'), keys: ['brightness', 'sustain', 'position'] },
  shamisen: { render: renderShamisen, keys: ['thwack', 'sawari', 'brightness', 'sustain'] }
};

const subsets = new WeakMap();
/**
 * The physical model an instrument's notes come from, or null: { model, p, id } where p holds only the params
 * that shape the rendered note and id is its cache-key form. `params` must be a stable, complete params object.
 */
export function modelOf(kind, params) {
  const model = kind === 'strings' ? (params.articulation === 'pizzicato' ? 'pizzicato' : null) : MODELS[kind] ? kind : null;
  if (!model) return null;
  let s = subsets.get(params);
  if (!s || s.model !== model) {
    const p = {};
    for (const k of MODELS[model].keys) p[k] = params[k];
    s = { model, p, id: JSON.stringify(p) };
    subsets.set(params, s);
  }
  return s;
}

/** Render one note of a model (pure; used directly by the worker and by tests). */
export function renderModel(model, sr, key, layer, p) {
  return MODELS[model].render(sr, key, layerVelocity(layer), p);
}

// ------------------------------------------------------------------ cache

const cache = new Map();
let cachedSamples = 0;
const MAX_CACHED_SAMPLES = 40_000_000; // ≈ 160 MB of Float32 audio
let pinned = new Set(); // keys of the notes the open project plays: evicted only when nothing else is left

export const noteCacheKey = (spec, sr, key, layer) => `${spec.model}|${sr}|${key}|${layer}|${spec.id}`;

/** A cached rendered note (anything with a .length in samples: Float32Array or AudioBuffer), most recent last. */
export function cacheGet(k) {
  const hit = cache.get(k);
  if (hit) {
    cache.delete(k);
    cache.set(k, hit);
  }
  return hit;
}

export function cachePut(k, value) {
  if (cache.has(k)) return cache.get(k);
  cache.set(k, value);
  cachedSamples += value.length;
  // least recently used first, sparing the project's own notes; then, if that's not enough, anything but this note
  for (const spare of [true, false]) {
    for (const [old, d] of cache) {
      if (cachedSamples <= MAX_CACHED_SAMPLES) return value;
      if (old === k || (spare && pinned.has(old))) continue;
      cache.delete(old);
      cachedSamples -= d.length;
    }
  }
  return value;
}

/** The notes the open project plays (cache keys): kept in the cache in preference to others. */
export function pinNotes(keys) {
  pinned = new Set(keys);
}

/** Has this note been rendered? (no LRU update) */
export const isCached = (k) => cache.has(k);

/** A rendered note, cached; `wrap` turns the Float32Array into what is stored (e.g. an AudioBuffer). */
export function modelNote(spec, sr, key, layer, wrap = (x) => x) {
  const k = noteCacheKey(spec, sr, key, layer);
  return cacheGet(k) || cachePut(k, wrap(renderModel(spec.model, sr, key, layer, spec.p)));
}
