// "Band" instruments (GarageBand-style): grand piano, guitar and bass guitar play physical-model notes rendered
// ahead of time (models.js / modelPool.js); electric piano, drawbar organ and bowed strings are oscillator engines.
// Same voice contract as instruments.js: register sources with v.add, connect to v.out, return the natural end
// (or null while held) and set v.releaseFn for note-off.
import { midiToFreq } from '@greanteadawy/core';
import { shaperCurve, adsr, timbre, phasedSine, noiseSource, FLAT_Q } from './dsp.js';
import { modelOf, layerOf } from './models.js';
import { noteBuffer, liveNoteBuffer } from './modelPool.js';

const TAU = Math.PI * 2;

export function osc(ctx, type, freq, t) {
  const o = ctx.createOscillator();
  if (type) o.type = type;
  o.frequency.setValueAtTime(freq, t);
  return o;
}

export function biquad(ctx, type, freq, q, gainDb = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.min(ctx.sampleRate / 2 - 100, Math.max(10, freq));
  f.Q.value = q;
  f.gain.value = gainDb;
  return f;
}

export function gainNode(ctx, value) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/** An LFO (sine) whose cycle is shared by every note of the context (see phasedSine). */
export function sharedLfo(v, ctx, rate, t) {
  const o = v.add(ctx.createOscillator());
  o.setPeriodicWave(phasedSine(ctx, TAU * rate * t));
  o.frequency.setValueAtTime(rate, t);
  o.start(t);
  return o;
}

/**
 * Soft overdrive after `from`, whose peak is about `peak`: the signal is brought to 0.9 for the shaper (its curve
 * spans ±1) and the output back to `peak`, then down by 1 + 2·amount, since saturation also raises the average level
 * (a squashed note is far denser than a clean one): drive adds harmonics and density rather than a jump in volume.
 */
export function overdrive(ctx, from, amount, peak, cabHz) {
  const a = Math.max(0.01, amount);
  const ws = ctx.createWaveShaper();
  ws.curve = shaperCurve('soft', a);
  ws.oversample = '2x';
  const k = 1 + a * 30;
  const y = Math.tanh(0.9 * k) / Math.tanh(k);
  const pre = gainNode(ctx, peak > 0 ? 0.9 / peak : 1);
  const post = gainNode(ctx, peak / y / (1 + 2 * a));
  from.connect(pre).connect(ws).connect(post);
  if (!cabHz) return post;
  const cab = biquad(ctx, 'lowpass', cabHz, FLAT_Q); // speaker cabinet: no fizz above ~5 kHz
  post.connect(cab);
  return cab;
}

// ------------------------------------------------------------------ model voices (piano, guitar, bass, pizzicato)

// Rendered notes are levelled by the loudness of their first 300 ms (models.js), and like recordings of the real
// instruments they keep a large crest factor. These factors put a single note at velocity 0.8 and default gain at
// ≈ -24…-26 LUFS with peaks around -4 dBFS — a few dB under the sustained keys, as with sampled instruments.
const MODEL_LEVEL = { piano: 2.4, guitar: 1.6, bass: 1.8, pizzicato: 1.8 };

/**
 * Plays a pre-rendered note. Velocity picks a timbre layer; the level follows the squared velocity curve. Mono glides
 * (bass) slide the playback rate from the previous note and skip the new note's pluck, like a fretted slide.
 * opts: { level, release, damped (false = rings through note-off), pan, glide, drive, cabHz }
 */
export function modelVoice(v, ctx, spec, { t, vel, velRaw, key, glideFrom }, opts) {
  const exact = Math.max(0, Math.min(127, Math.round(key)));
  // offline renders use the exact note (prewarmed before the render); live playing never waits for a render when a
  // neighbouring note is ready — it plays that one repitched while the exact note renders in a worker
  const live = typeof OfflineAudioContext === 'undefined' || !(ctx instanceof OfflineAudioContext);
  const { buffer: buf, key: base } = live ? liveNoteBuffer(ctx.sampleRate, spec, exact, layerOf(velRaw)) : { buffer: noteBuffer(ctx.sampleRate, spec, exact, layerOf(velRaw)), key: exact };
  const f = midiToFreq(key);
  v.freq = f;
  const rate = Math.pow(2, (key - base) / 12);
  const src = v.add(ctx.createBufferSource());
  src.buffer = buf;
  const slide = glideFrom && opts.glide > 0.005;
  if (slide) {
    src.playbackRate.setValueAtTime(Math.max(0.25, Math.min(4, glideFrom / midiToFreq(base))), t);
    src.playbackRate.exponentialRampToValueAtTime(rate, t + opts.glide);
  } else {
    src.playbackRate.value = rate;
  }
  const level = vel * opts.level;
  const amp = ctx.createGain();
  const offset = slide ? Math.min(0.04, buf.duration / 4) : 0;
  if (slide) {
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(level, t + 0.008);
  } else {
    amp.gain.value = level;
  }
  src.connect(amp);
  let node = amp;
  if (opts.drive > 0.01) node = overdrive(ctx, amp, opts.drive, level * 0.9, opts.cabHz);
  if (opts.pan && ctx.createStereoPanner) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
    node.connect(pan);
    node = pan;
  }
  node.connect(v.out);
  src.start(t, offset);
  const natural = t + (buf.duration - offset) / rate;
  src.stop(natural + 0.01);
  v.releaseFn = (time) => {
    if (time >= natural || opts.damped === false) return natural;
    const rt = Math.max(time, t + (slide ? 0.008 : 0));
    amp.gain.cancelScheduledValues(rt);
    amp.gain.setValueAtTime(level, rt);
    amp.gain.setTargetAtTime(0, rt, opts.release / 5);
    return Math.min(natural, rt + opts.release * 1.5);
  };
  return natural;
}

function piano(v, ctx, p, args) {
  return modelVoice(v, ctx, modelOf('piano', p), args, {
    level: p.gain * MODEL_LEVEL.piano,
    release: p.release,
    damped: args.key < 91, // the top strings of a piano have no dampers
    pan: p.stereo * 0.8 * Math.max(-1, Math.min(1, (args.key - 64) / 40))
  });
}

function guitar(v, ctx, p, args) {
  return modelVoice(v, ctx, modelOf('guitar', p), args, { level: p.gain * MODEL_LEVEL.guitar, release: p.release, drive: p.drive, cabHz: 5200 });
}

function bass(v, ctx, p, args) {
  return modelVoice(v, ctx, modelOf('bass', p), args, { level: p.gain * MODEL_LEVEL.bass, release: p.release, glide: p.mono ? p.glide : 0, drive: p.drive, cabHz: 3800 });
}

// ------------------------------------------------------------------ electric piano (FM)

function epiano(v, ctx, p, { t, vel, velRaw, key }) {
  const f = midiToFreq(key);
  v.freq = f;
  const reed = p.model === 'reed';
  const nyq = ctx.sampleRate / 2;
  const level = vel * p.gain * 0.9;
  const t60 = Math.max(0.3, p.decay * Math.pow(2, -(key - 60) / 24));
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(level, t + 0.0015);
  // 1:1 FM puts a sideband at 0 Hz (DC): block it
  const dcBlock = biquad(ctx, 'highpass', 20, FLAT_Q);
  out.connect(dcBlock);
  out.gain.setTargetAtTime(0, t + 0.0015, t60 / 6.9);
  // body: carrier + modulator at the same frequency; harder notes "bark" (more index), decaying quickly to a sine-ish tone
  const car = v.add(osc(ctx, 'sine', f, t));
  const mod = v.add(osc(ctx, 'sine', f, t));
  const idx = (reed ? 0.7 + 3 * p.bark : 0.25 + 2.2 * p.bark) * timbre(velRaw, 0.25);
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(idx * f, t);
  mg.gain.setTargetAtTime(idx * f * (reed ? 0.35 : 0.15), t + 0.002, reed ? 0.4 : 0.25);
  mod.connect(mg).connect(car.frequency);
  car.connect(out);
  const srcs = [car, mod];
  // bell / tine "ding": a high modulator ratio gives inharmonic sidebands that die away fast
  const ratio = reed ? 7 : 14;
  if (p.bell > 0.01 && f * (ratio + 1) < nyq * 0.9) {
    const c2 = v.add(osc(ctx, 'sine', f, t));
    const m2 = v.add(osc(ctx, 'sine', f * ratio, t));
    const mg2 = ctx.createGain();
    mg2.gain.setValueAtTime(f * ratio * 0.9 * timbre(velRaw, 0.3), t);
    mg2.gain.setTargetAtTime(0, t + 0.001, 0.05);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(p.bell * 0.45 * timbre(velRaw, 0.4), t);
    bg.gain.setTargetAtTime(0, t + 0.001, 0.12);
    m2.connect(mg2).connect(c2.frequency);
    c2.connect(bg).connect(out);
    srcs.push(c2, m2);
  }
  let node = dcBlock;
  if (p.tremoloDepth > 0.01) {
    const lfo = sharedLfo(v, ctx, p.tremoloRate, t);
    if (!reed && ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner(); // Suitcase-style stereo tremolo (auto-pan)
      const depth = gainNode(ctx, p.tremoloDepth * 0.9);
      lfo.connect(depth).connect(pan.pan);
      node.connect(pan);
      node = pan;
    } else {
      const trem = gainNode(ctx, 1 - p.tremoloDepth * 0.4);
      const depth = gainNode(ctx, p.tremoloDepth * 0.4);
      lfo.connect(depth).connect(trem.gain);
      node.connect(trem);
      node = trem;
    }
  }
  node.connect(v.out);
  for (const s of srcs) s.start(t);
  const natural = t + 0.0015 + t60 + 0.05;
  v.stopAt(natural);
  v.releaseFn = (time) => {
    if (time >= natural) return natural;
    const rt = Math.max(time, t + 0.0015);
    out.gain.cancelScheduledValues(rt);
    out.gain.setValueAtTime(level * Math.exp((-6.9 * (rt - t - 0.0015)) / t60), rt);
    out.gain.setTargetAtTime(0, rt, p.release / 5);
    return Math.min(natural, rt + p.release * 1.5);
  };
  return natural;
}

// ------------------------------------------------------------------ drawbar organ

// harmonic numbers of the nine drawbars relative to the 16' sub-octave (f/2): 16' 5⅓' 8' 4' 2⅔' 2' 1⅗' 1⅓' 1'
const DRAWBARS = [['db16', 1], ['db513', 3], ['db8', 2], ['db4', 4], ['db223', 6], ['db2', 8], ['db135', 10], ['db113', 12], ['db1', 16]];
const organWaves = new WeakMap();

/** The tonewheel waveform of a registration (each drawbar step is 3 dB) and its level compensation. */
function organWave(ctx, p) {
  let m = organWaves.get(ctx);
  if (!m) organWaves.set(ctx, (m = new Map()));
  const levels = DRAWBARS.map(([k]) => Math.max(0, Math.min(8, Math.round(p[k] || 0))));
  const id = levels.join('');
  let w = m.get(id);
  if (!w) {
    const real = new Float32Array(17);
    const imag = new Float32Array(17);
    let energy = 0;
    DRAWBARS.forEach(([, h], i) => {
      if (!levels[i]) return;
      const a = Math.pow(10, (-3 * (8 - levels[i])) / 20);
      imag[h] += a;
      energy += a * a;
    });
    // more drawbars are louder, as on the real thing, but compressed: loudness ∝ energy^0.15 (all nine at 8 ≈ +1.4 dB
    // over the 8' alone, a soft registration a few dB under it)
    const scale = energy ? Math.pow(energy, 0.15) / Math.sqrt(energy) : 0;
    let peak = 0;
    for (let i = 0; i < 512; i++) {
      let x = 0;
      for (let h = 1; h < 17; h++) x += imag[h] * Math.sin((TAU * h * i) / 512);
      peak = Math.max(peak, Math.abs(x) * scale);
    }
    w = { wave: ctx.createPeriodicWave(real, imag, { disableNormalization: true }), scale, peak };
    m.set(id, w);
  }
  return w;
}

const ROTARY = { slow: { rate: 0.8, cents: 4, pan: 0.35, am: 0.08 }, fast: { rate: 6.7, cents: 7, pan: 0.5, am: 0.15 } };

function organ(v, ctx, p, { t, velRaw, key }) {
  const f = midiToFreq(key);
  v.freq = f;
  const { wave, scale, peak } = organWave(ctx, p);
  // an organ is (almost) not velocity sensitive
  const level = p.gain * 0.2 * (0.75 + 0.25 * velRaw);
  const mix = ctx.createGain(); // tonewheels + percussion + click, before the overdrive (as on the real thing)
  const oscs = [];
  if (scale > 0) {
    const o = v.add(ctx.createOscillator());
    o.setPeriodicWave(wave);
    o.frequency.setValueAtTime(f / 2, t);
    o.connect(gainNode(ctx, scale)).connect(mix);
    oscs.push(o);
  }
  if (p.percussion) {
    const po = v.add(osc(ctx, 'sine', f * (p.percHarmonic === 'second' ? 2 : 3), t));
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0, t);
    pg.gain.linearRampToValueAtTime(0.5, t + 0.002);
    pg.gain.setTargetAtTime(0, t + 0.002, p.percDecay / 5);
    po.connect(pg).connect(mix);
    oscs.push(po);
  }
  if (!oscs.length) return t;
  if (p.click > 0.01) {
    const n = v.add(noiseSource(ctx, false));
    const bp = biquad(ctx, 'bandpass', 2800, 0.8);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(p.click * 0.35, t);
    cg.gain.setTargetAtTime(0, t, 0.003);
    n.connect(bp).connect(cg).connect(mix);
    n.start(t);
    n.stop(t + 0.03);
  }
  const env = ctx.createGain();
  env.gain.value = 0;
  const e = adsr(env.gain, t, { attack: 0.004, decay: 0.01, sustain: 1, release: 0.04 }, level);
  (p.drive > 0.01 ? overdrive(ctx, mix, p.drive * 0.6, peak + (p.percussion ? 0.5 : 0), 6500) : mix).connect(env);
  let node = env;
  const rot = ROTARY[p.rotary];
  if (rot) {
    // rotary speaker: one LFO shared by all notes drives doppler (pitch), level and pan
    const lfo = sharedLfo(v, ctx, rot.rate, t);
    const dop = gainNode(ctx, rot.cents);
    lfo.connect(dop);
    for (const o of oscs) dop.connect(o.detune);
    const am = gainNode(ctx, 1 - rot.am);
    lfo.connect(gainNode(ctx, rot.am)).connect(am.gain);
    node.connect(am);
    node = am;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      lfo.connect(gainNode(ctx, rot.pan)).connect(pan.pan);
      node.connect(pan);
      node = pan;
    }
  }
  node.connect(v.out);
  for (const o of oscs) o.start(t);
  v.releaseFn = (time) => e.release(time, ctx.currentTime) + 0.02;
  return null;
}

// ------------------------------------------------------------------ bowed strings

const sawWaves = new WeakMap();
/** A band-limited sawtooth starting `cycles` (quantized to 1/64) into its period; the browser normalizes its level. */
function phasedSaw(ctx, cycles) {
  let m = sawWaves.get(ctx);
  if (!m) sawWaves.set(ctx, (m = new Map()));
  const q = ((Math.round(cycles * 64) % 64) + 64) % 64;
  let w = m.get(q);
  if (!w) {
    const N = 128;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    const ph = (q / 64) * TAU;
    for (let n = 1; n < N; n++) {
      const b = (2 / (n * Math.PI)) * (n % 2 ? 1 : -1);
      real[n] = b * Math.sin(n * ph);
      imag[n] = b * Math.cos(n * ph);
    }
    w = ctx.createPeriodicWave(real, imag);
    m.set(q, w);
  }
  return w;
}

// Start phases of the players (in cycles). Small offsets: the saws' edges no longer coincide (no spike on every
// attack) but the fundamentals stay in phase — evenly spread phases would cancel them on short notes.
const PLAYER_PHASES = [0, 0.11, -0.09, 0.05, -0.13, 0.14, -0.04, 0.08];

function strings(v, ctx, p, args) {
  if (p.articulation === 'pizzicato') {
    return modelVoice(v, ctx, modelOf('strings', p), args, { level: p.gain * MODEL_LEVEL.pizzicato, release: 0.12 });
  }
  const { t, vel, velRaw, key } = args;
  const f = midiToFreq(key);
  v.freq = f;
  const staccato = p.articulation === 'staccato';
  const players = Math.max(1, Math.min(8, Math.round(p.ensemble)));
  // body: a darker low-pass that opens with bow pressure (velocity) and pitch, plus the main body/bridge resonances
  const cut = (700 + p.brightness * p.brightness * 6500) * timbre(velRaw, 0.55) * Math.pow(2, (key - 60) / 24);
  const lp = biquad(ctx, 'lowpass', cut, FLAT_Q);
  const body = biquad(ctx, 'peaking', key < 52 ? 220 : 300, 1.2, 3);
  const bridge = biquad(ctx, 'peaking', 2500, 1, 3.5);
  const hp = biquad(ctx, 'highpass', Math.max(30, f * 0.6), FLAT_Q);
  const amp = ctx.createGain();
  amp.gain.value = 0;
  const level = vel * p.gain * 1.1;
  const attack = staccato ? 0.012 : p.attack * (1.3 - 0.6 * velRaw); // harder bowing speaks faster
  const env = adsr(amp.gain, t, staccato
    ? { attack, decay: 0.22, sustain: 0, release: Math.min(p.release, 0.15) }
    : { attack, decay: 0.4, sustain: 0.85, release: p.release }, level);
  hp.connect(lp).connect(body).connect(bridge).connect(amp).connect(v.out);
  // delayed vibrato; two LFOs at slightly different rates, alternating between players, so a section doesn't
  // wobble in lock-step
  const vibs = [];
  if (p.vibrato > 0.01 && !staccato) {
    for (let i = 0; i < Math.min(2, players); i++) {
      const lfo = v.add(osc(ctx, 'sine', p.vibratoRate * (i ? 1.07 : 0.96), t));
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(0, t);
      depth.gain.setValueAtTime(0, t + 0.25);
      depth.gain.linearRampToValueAtTime(p.vibrato * 22, t + 0.9); // cents
      lfo.connect(depth);
      vibs.push(depth);
    }
  }
  for (let i = 0; i < players; i++) {
    const spread = players > 1 ? (i / (players - 1)) * 2 - 1 : 0;
    // each player's saw starts at its own phase: in-phase saws would add up to a spike on every attack
    const o = v.add(osc(ctx, null, f, t));
    o.setPeriodicWave(phasedSaw(ctx, PLAYER_PHASES[i]));
    o.detune.value = spread * (5 + players) + ((i * 7) % 5) - 2; // a section is never perfectly in tune
    if (vibs.length) vibs[i % vibs.length].connect(o.detune);
    const g = gainNode(ctx, 0.45 / Math.sqrt(players));
    o.connect(g);
    if (players > 1 && ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = spread * 0.6;
      g.connect(pan).connect(hp);
    } else {
      g.connect(hp);
    }
  }
  for (const s of v.sources) s.start(t);
  if (staccato) {
    const natural = t + attack + 0.22 * 3 + 0.05;
    v.stopAt(natural);
    v.releaseFn = (time) => Math.min(natural, env.release(time, ctx.currentTime) + 0.02);
    return natural;
  }
  v.releaseFn = (time) => env.release(time, ctx.currentTime) + 0.05;
  return null;
}

export const BAND = { piano, epiano, organ, guitar, bass, strings };
