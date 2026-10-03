// Synthesized instruments. Every function schedules one note ("voice") on a Web Audio graph.
import { midiToFreq, instrumentDefaults, INSTRUMENTS } from '@greanteadawy/core';
import { noiseSource, shaperCurve, adsr, percEnv, timbre, FLAT_Q } from './dsp.js';
import { BAND } from './band.js';
import { WORLD } from './world.js';
import { pluginVoice } from './plugins.js';

/** A playing note. Owns its sources; supports note-off (release) and fast kill (choke / stop). */
export class Voice {
  constructor(ctx, dest, start) {
    this.ctx = ctx;
    this.start = start;
    this.end = start + 10;
    this.out = ctx.createGain();
    this.out.connect(dest);
    this.sources = [];
    this.releaseFn = null;
    this.freq = 0;
    this.done = false;
    this.killedAt = null;
    this.onDone = null;
    this.pending = 0;
  }

  add(src) {
    this.sources.push(src);
    this.pending++;
    src.onended = () => {
      if (--this.pending <= 0 && !this.done) this.cleanup();
    };
    return src;
  }

  stopAt(time) {
    this.end = time;
    for (const s of this.sources) {
      try { s.stop(time); } catch { /* not started */ }
    }
  }

  /** Note off at `time` (schedules the release phase). */
  release(time) {
    if (this.killedAt !== null) return;
    if (this.releaseFn) {
      const end = this.releaseFn(time);
      if (end) this.stopAt(end);
    }
  }

  /** Fast fade-out (choke groups, mono cut, transport stop). */
  kill(time) {
    if (this.killedAt !== null && this.killedAt <= time) return;
    const t = Math.max(time, this.ctx.currentTime);
    this.killedAt = t;
    const g = this.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(1, t);
    g.linearRampToValueAtTime(0, t + 0.012);
    this.stopAt(t + 0.02);
  }

  cleanup() {
    this.done = true;
    try { this.out.disconnect(); } catch { /* ignore */ }
    this.onDone?.(this);
  }
}

const reversedCache = new WeakMap();
function reversed(ctx, buf) {
  let r = reversedCache.get(buf);
  if (!r) {
    r = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const src = buf.getChannelData(c);
      const dst = r.getChannelData(c);
      for (let i = 0, n = src.length; i < n; i++) dst[i] = src[n - 1 - i];
    }
    reversedCache.set(buf, r);
  }
  return r;
}

function osc(ctx, type, freq, t) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  return o;
}

/**
 * A biquad. For low-/high-pass `q` is in dB (Web Audio): the drum voices use 0.7 dB — a slight bump that is part of
 * their tuned sound — while FLAT_Q gives a neutral Butterworth response.
 */
function filter(ctx, type, freq, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.min(ctx.sampleRate / 2 - 100, Math.max(10, freq));
  f.Q.value = q;
  return f;
}

function noiseBurst(v, ctx, t, level, decay, hp = 1500) {
  const n = v.add(noiseSource(ctx, false));
  const f = filter(ctx, 'highpass', hp);
  const g = ctx.createGain();
  percEnv(g.gain, t, level, decay);
  n.connect(f).connect(g).connect(v.out);
  n.start(t);
  n.stop(t + decay + 0.05);
}

/**
 * Velocity → gain: a squared curve (≈ 40 dB of range) like most hardware and sample players. A plain linear
 * multiplier made a ghost note (0.45) only 7 dB quieter than a normal hit, so grooves sounded machine-flat.
 * 1 → 0 dB, 0.8 → -3.9 dB, 0.45 → -13.9 dB, 0.3 → -21 dB.
 */
export const velocityGain = (v) => v * v;

const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

function metallic(v, ctx, t, base, end, dest, level) {
  for (const r of METAL_RATIOS) {
    const o = v.add(osc(ctx, 'square', base * r, t));
    const g = ctx.createGain();
    g.gain.value = level / METAL_RATIOS.length;
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(end);
  }
}

// ---------------------------------------------------------------- drums

const DRUMS = {
  kick(v, ctx, p, { t, vel, velRaw, ratio }) {
    const o = v.add(osc(ctx, 'sine', p.sweep * ratio, t));
    o.frequency.exponentialRampToValueAtTime(Math.max(20, p.tune * ratio), t + p.sweepTime);
    const amp = ctx.createGain();
    const end = percEnv(amp.gain, t, vel, p.decay, 0.0015);
    o.connect(amp);
    let node = amp;
    if (p.drive > 0.01) {
      const ws = ctx.createWaveShaper();
      ws.curve = shaperCurve('soft', p.drive * 0.6);
      ws.oversample = '2x';
      amp.connect(ws);
      node = ws;
    }
    node.connect(v.out);
    o.start(t);
    o.stop(end);
    // softer hits have less beater click
    if (p.click > 0.01) noiseBurst(v, ctx, t, vel * p.click * 0.5 * timbre(velRaw, 0.25), 0.01, 2500);
    return end;
  },

  snare(v, ctx, p, { t, vel, velRaw, ratio }) {
    const o = v.add(osc(ctx, 'triangle', p.tone * ratio * 1.5, t));
    o.frequency.exponentialRampToValueAtTime(p.tone * ratio, t + 0.02);
    const tg = ctx.createGain();
    const e1 = percEnv(tg.gain, t, vel * (1 - p.snappy * 0.45), p.toneDecay);
    o.connect(tg).connect(v.out);
    o.start(t);
    o.stop(e1);
    const n = v.add(noiseSource(ctx, false));
    const color = p.color * ratio * timbre(velRaw, 0.75); // ghost notes are darker
    const hp = filter(ctx, 'highpass', color * 0.35);
    const lp = filter(ctx, 'lowpass', Math.min(16000, color * 2.2));
    const ng = ctx.createGain();
    const e2 = percEnv(ng.gain, t, vel * (0.25 + p.snappy * 0.75), p.noiseDecay);
    n.connect(hp).connect(lp).connect(ng).connect(v.out);
    n.start(t);
    n.stop(e2);
    return Math.max(e1, e2);
  },

  clap(v, ctx, p, { t, vel, velRaw, ratio }) {
    const n = v.add(noiseSource(ctx, false));
    const bp = filter(ctx, 'bandpass', p.color * ratio * timbre(velRaw, 0.8), 1.8);
    const hp = filter(ctx, 'highpass', 600);
    const g = ctx.createGain();
    const gg = g.gain;
    gg.setValueAtTime(0, t);
    for (let i = 0; i < 3; i++) {
      const s = t + i * p.spread;
      gg.setValueAtTime(vel * 2.8, s);
      gg.exponentialRampToValueAtTime(Math.max(1e-4, vel * 0.3), s + p.spread * 0.9);
    }
    const tail = t + 3 * p.spread;
    gg.setValueAtTime(vel * 2.4, tail);
    gg.exponentialRampToValueAtTime(Math.max(1e-4, vel * 0.2 * (0.2 + p.room)), tail + p.decay * 0.35);
    gg.exponentialRampToValueAtTime(0.0001, tail + p.decay * (1 + p.room));
    const end = tail + p.decay * (1 + p.room) + 0.02;
    n.connect(bp).connect(hp).connect(g).connect(v.out);
    n.start(t);
    n.stop(end);
    return end;
  },

  hat(v, ctx, p, { t, vel, velRaw, ratio: pitchRatio }) {
    const ratio = pitchRatio * timbre(velRaw, 0.85); // softer = a touch darker (a hat has no "body" pitch to keep)
    const end = t + p.decay + 0.02;
    const bp = filter(ctx, 'bandpass', Math.min(16000, p.color * ratio), 0.9);
    const hp = filter(ctx, 'highpass', Math.min(15000, p.color * 0.75 * ratio));
    const amp = ctx.createGain();
    percEnv(amp.gain, t, vel * 1.5, p.decay);
    bp.connect(hp).connect(amp).connect(v.out);
    if (p.metallic > 0.01) metallic(v, ctx, t, 40 * ratio * (p.color / 9000), end, bp, p.metallic * 1.6);
    if (p.metallic < 0.99) {
      const n = v.add(noiseSource(ctx, false));
      const ng = ctx.createGain();
      ng.gain.value = (1 - p.metallic) * 1.2;
      n.connect(ng).connect(bp);
      n.start(t);
      n.stop(end);
    }
    return end;
  },

  cymbal(v, ctx, p, { t, vel, ratio }) {
    const end = t + p.decay + 0.05;
    const hp = filter(ctx, 'highpass', p.color * 0.6 * ratio);
    const bp = filter(ctx, 'bandpass', Math.min(15000, p.color * ratio), 0.5);
    const amp = ctx.createGain();
    percEnv(amp.gain, t, vel * 0.7, p.decay, 0.002);
    hp.connect(bp).connect(amp).connect(v.out);
    metallic(v, ctx, t, 60 * ratio, end, hp, 0.9);
    const n = v.add(noiseSource(ctx, false));
    const ng = ctx.createGain();
    ng.gain.value = 0.8;
    n.connect(ng).connect(hp);
    n.start(t);
    n.stop(end);
    return end;
  },

  tom(v, ctx, p, { t, vel, ratio }) {
    const f = p.pitch * ratio;
    const o = v.add(osc(ctx, 'sine', f * (1 + p.sweep), t));
    o.frequency.exponentialRampToValueAtTime(f, t + p.decay * 0.6);
    const amp = ctx.createGain();
    const end = percEnv(amp.gain, t, vel, p.decay, 0.002);
    o.connect(amp).connect(v.out);
    o.start(t);
    o.stop(end);
    noiseBurst(v, ctx, t, vel * 0.15, 0.015, 3000);
    return end;
  },

  rim(v, ctx, p, { t, vel, ratio }) {
    const o = v.add(osc(ctx, 'triangle', p.pitch * ratio, t));
    const o2 = v.add(osc(ctx, 'square', p.pitch * ratio * 1.48, t));
    const hp = filter(ctx, 'highpass', 500);
    const amp = ctx.createGain();
    const end = percEnv(amp.gain, t, vel * 0.8, p.decay);
    const g2 = ctx.createGain();
    g2.gain.value = 0.3;
    o.connect(hp);
    o2.connect(g2).connect(hp);
    hp.connect(amp).connect(v.out);
    o.start(t); o2.start(t);
    o.stop(end); o2.stop(end);
    noiseBurst(v, ctx, t, vel * 0.4, 0.008, 4000);
    return end;
  },

  cowbell(v, ctx, p, { t, vel, ratio }) {
    const f = p.pitch * ratio;
    const bp = filter(ctx, 'bandpass', f * 1.45, 2.5);
    const amp = ctx.createGain();
    const ag = amp.gain;
    ag.setValueAtTime(0, t);
    ag.linearRampToValueAtTime(vel, t + 0.002);
    ag.exponentialRampToValueAtTime(Math.max(1e-4, vel * 0.3), t + 0.03);
    ag.exponentialRampToValueAtTime(0.0001, t + p.decay);
    const end = t + p.decay + 0.02;
    for (const mul of [1, 1.48]) {
      const o = v.add(osc(ctx, 'square', f * mul, t));
      o.connect(bp);
      o.start(t);
      o.stop(end);
    }
    bp.connect(amp).connect(v.out);
    return end;
  },

  shaker(v, ctx, p, { t, vel, ratio }) {
    const n = v.add(noiseSource(ctx, false));
    const bp = filter(ctx, 'bandpass', p.color * ratio, 1.2);
    const hp = filter(ctx, 'highpass', 2500);
    const amp = ctx.createGain();
    const end = percEnv(amp.gain, t, vel * 0.9, p.decay, 0.008);
    n.connect(bp).connect(hp).connect(amp).connect(v.out);
    n.start(t);
    n.stop(end);
    return end;
  },

  perc(v, ctx, p, { t, vel, ratio }) {
    const f = p.pitch * ratio;
    const o = v.add(osc(ctx, p.wave, f * (1 + p.sweep * 2), t));
    o.frequency.exponentialRampToValueAtTime(f, t + Math.max(0.005, p.decay * 0.4));
    const amp = ctx.createGain();
    const end = percEnv(amp.gain, t, vel * (p.wave === 'square' || p.wave === 'sawtooth' ? 0.5 : 0.9), p.decay);
    o.connect(amp).connect(v.out);
    o.start(t);
    o.stop(end);
    if (p.noise > 0.01) noiseBurst(v, ctx, t, vel * p.noise * 0.6, p.decay * 0.5, 1200);
    return end;
  }
};

// ---------------------------------------------------------------- melodic

function bass808(v, ctx, p, { t, vel, key, glideFrom }) {
  const f = midiToFreq(key);
  v.freq = f;
  const o = v.add(osc(ctx, 'sine', glideFrom || f * Math.pow(2, p.punch / 12), t));
  o.frequency.exponentialRampToValueAtTime(f, t + (glideFrom ? Math.max(0.005, p.glide) : p.punchTime));
  const amp = ctx.createGain();
  const g = amp.gain;
  const atk = 0.004;
  const tau = p.decay / 6.9; // reaches -60 dB after `decay` seconds
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(vel, t + atk);
  // setTargetAtTime (not an exponential ramp) so a note-off can cancel from its time without losing the decay
  g.setTargetAtTime(0, t + atk, tau);
  const valueAt = (time) => (time <= t + atk ? vel * Math.max(0, (time - t) / atk) : vel * Math.exp(-(time - t - atk) / tau));
  let node = amp;
  if (p.drive > 0.01) {
    const ws = ctx.createWaveShaper();
    ws.curve = shaperCurve('soft', p.drive * 0.7);
    ws.oversample = '2x';
    node.connect(ws);
    node = ws;
  }
  const lp = filter(ctx, 'lowpass', p.tone, 0.5);
  o.connect(amp);
  node.connect(lp).connect(v.out);
  o.start(t);
  const natural = t + atk + p.decay + 0.02;
  o.stop(natural);
  if (p.click > 0.01 && !glideFrom) noiseBurst(v, ctx, t, vel * p.click * 0.4, 0.008, 3000);
  v.releaseFn = (time) => {
    if (time >= natural) return natural;
    const rt = Math.max(time, t + atk); // let the (4 ms) attack finish
    g.cancelScheduledValues(rt);
    g.setValueAtTime(valueAt(rt), rt);
    g.setTargetAtTime(0, rt, 0.025);
    return rt + 0.15;
  };
  return natural;
}

function synth(v, ctx, p, { t, vel, velRaw, key, glideFrom }) {
  const f = midiToFreq(key);
  v.freq = f;
  const flt = ctx.createBiquadFilter();
  flt.type = p.filterType;
  // harder notes open the filter a little more (low-pass only: a brighter high-pass would sound thinner, not louder)
  const velCut = p.filterType === 'lowpass' ? Math.pow(2, (velRaw - 0.8) * 1.5) : 1;
  const cut = Math.max(20, Math.min(20000, p.cutoff * velCut * Math.pow(2, ((key - 60) / 12) * p.keyTrack)));
  flt.frequency.value = Math.min(ctx.sampleRate / 2 - 100, cut);
  flt.Q.value = p.resonance;
  let fenv = null;
  if (Math.abs(p.filterEnv) > 0.001) {
    fenv = adsr(flt.detune, t, { attack: p.fAttack, decay: p.fDecay, sustain: p.fSustain, release: p.fRelease }, p.filterEnv * 4800 * timbre(velRaw, 0.3));
  }
  const amp = ctx.createGain();
  amp.gain.value = 0;
  const env = adsr(amp.gain, t, { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release }, vel * p.gain * 1.8);
  flt.connect(amp);
  let last = amp;
  const oscs = [];
  const unison = Math.max(1, Math.round(p.unison));
  for (let i = 1; i <= 3; i++) {
    const wave = p[`osc${i}Wave`];
    const level = p[`osc${i}Level`];
    if (wave === 'off' || level <= 0) continue;
    const det = p[`osc${i}Oct`] * 1200 + p[`osc${i}Semi`] * 100 + p[`osc${i}Fine`];
    if (wave === 'noise') {
      const n = v.add(noiseSource(ctx, true));
      const g = ctx.createGain();
      g.gain.value = level * 0.4;
      n.connect(g).connect(flt);
      n.start(t);
      continue;
    }
    for (let u = 0; u < unison; u++) {
      const spread = unison > 1 ? (u / (unison - 1)) * 2 - 1 : 0;
      const o = v.add(ctx.createOscillator());
      o.type = wave;
      const ratio = Math.pow(2, det / 1200);
      if (glideFrom && p.glide > 0) {
        o.frequency.setValueAtTime(glideFrom * ratio, t);
        o.frequency.exponentialRampToValueAtTime(f * ratio, t + p.glide);
      } else {
        o.frequency.setValueAtTime(f * ratio, t);
      }
      o.detune.value = spread * p.unisonDetune;
      const g = ctx.createGain();
      g.gain.value = (level * (wave === 'square' || wave === 'sawtooth' ? 0.5 : 0.8)) / Math.sqrt(unison);
      o.connect(g);
      if (unison > 1 && p.unisonSpread > 0 && ctx.createStereoPanner) {
        const pan = ctx.createStereoPanner();
        pan.pan.value = spread * p.unisonSpread;
        g.connect(pan).connect(flt);
      } else {
        g.connect(flt);
      }
      o.start(t);
      oscs.push(o);
    }
  }
  if (p.lfoDepth > 0.001) {
    const lfo = v.add(osc(ctx, 'sine', p.lfoRate, t));
    const lg = ctx.createGain();
    lfo.connect(lg);
    if (p.lfoTarget === 'pitch') {
      lg.gain.value = p.lfoDepth * 100;
      for (const o of oscs) lg.connect(o.detune);
    } else if (p.lfoTarget === 'filter') {
      lg.gain.value = p.lfoDepth * 3600;
      lg.connect(flt.detune);
    } else {
      const trem = ctx.createGain();
      trem.gain.value = 1 - p.lfoDepth * 0.5;
      lg.gain.value = p.lfoDepth * 0.5;
      lg.connect(trem.gain);
      amp.connect(trem);
      last = trem;
    }
    lfo.start(t);
  }
  last.connect(v.out);
  v.releaseFn = (time) => {
    const e = env.release(time, ctx.currentTime);
    fenv?.release(time, ctx.currentTime);
    return e + 0.05;
  };
  if (!oscs.length && !v.sources.length) return t;
  return null;
}

function fm(v, ctx, p, { t, vel, velRaw, key }) {
  const f = midiToFreq(key);
  v.freq = f;
  const car = v.add(osc(ctx, p.carrierWave, f, t));
  car.detune.value = p.detune;
  const modF = f * p.ratio;
  const mod = v.add(osc(ctx, 'sine', modF, t));
  const mg = ctx.createGain();
  const depth = p.index * modF * timbre(velRaw, 0.4); // like a real e-piano: soft = round, hard = bark
  mg.gain.setValueAtTime(depth, t);
  mg.gain.setTargetAtTime(depth * p.indexSustain, t + 0.001, Math.max(0.005, p.indexDecay) / 3);
  mod.connect(mg).connect(car.frequency);
  const amp = ctx.createGain();
  amp.gain.value = 0;
  const env = adsr(amp.gain, t, { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release }, vel * p.gain);
  // integer ratios put a sideband at 0 Hz (DC offset): a 15 Hz high-pass removes it without touching the tone
  car.connect(amp).connect(filter(ctx, 'highpass', 15, FLAT_Q)).connect(v.out);
  car.start(t);
  mod.start(t);
  v.releaseFn = (time) => env.release(time, ctx.currentTime) + 0.05;
  return null;
}

function sampler(v, ctx, p, { t, vel, velRaw, key, buffer }) {
  if (!buffer) return t;
  const buf = p.reverse ? reversed(ctx, buffer) : buffer;
  const src = v.add(ctx.createBufferSource());
  src.buffer = buf;
  const rate = p.pitched ? Math.pow(2, (key - p.rootKey) / 12) : 1;
  src.playbackRate.value = rate;
  const amp = ctx.createGain();
  amp.gain.value = 0;
  const env = adsr(amp.gain, t, { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release }, vel * p.gain);
  let head = amp;
  if (p.cutoff < 19999) {
    // a low-pass that opens with velocity (soft = darker), like most sample players; flat Q (-3 dB = Butterworth)
    head = filter(ctx, 'lowpass', p.cutoff * timbre(velRaw, 0.5), FLAT_Q);
    head.connect(amp);
  }
  src.connect(head);
  // a short fade at the sample's (trimmed) end: stopping mid-waveform would click
  const tailFade = ctx.createGain();
  amp.connect(tailFade).connect(v.out);
  const dur = buf.duration;
  const offset = Math.min(dur - 0.001, p.start * dur);
  const stop = Math.max(offset + 0.001, Math.min(dur, (p.end ?? 1) * dur));
  if (p.loop && !p.oneShot) {
    // sustain loop: repeats loopStart..loopEnd until the note is released
    src.loop = true;
    src.loopStart = Math.min(dur - 0.005, (p.loopStart ?? 0) * dur);
    src.loopEnd = Math.max(src.loopStart + 0.005, Math.min(dur, (p.loopEnd ?? 1) * dur));
    src.start(t, offset);
    v.releaseFn = (time) => env.release(time, ctx.currentTime);
    return null;
  }
  src.start(t, offset, stop - offset);
  const natural = t + (stop - offset) / rate;
  const fadeLen = Math.min(0.004, (natural - t) / 2);
  tailFade.gain.setValueAtTime(1, natural - fadeLen);
  tailFade.gain.linearRampToValueAtTime(0, natural);
  src.stop(natural + 0.01);
  v.releaseFn = p.oneShot ? () => natural : (time) => Math.min(natural, env.release(time, ctx.currentTime));
  return natural;
}

/**
 * Start a note. Returns a Voice (already connected to `dest`) or null.
 * opts: { time, duration (s, or null for live notes), key, velocity, glideFrom, buffer }
 */
const fullParams = new WeakMap();
/** Params merged over the instrument defaults (defends against partial/old project data). */
function withDefaults(kind, params) {
  let full = fullParams.get(params);
  if (!full) {
    full = { ...instrumentDefaults(kind) };
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && (typeof v !== 'number' || Number.isFinite(v))) full[k] = v;
    if (params && typeof params === 'object') fullParams.set(params, full);
  }
  return full;
}

const warned = new Set();

export function playNote(ctx, dest, instrument, opts) {
  const { kind } = instrument;
  if (!INSTRUMENTS[kind]) return null;
  const velRaw = Number.isFinite(opts.velocity) ? Math.max(0, Math.min(1, opts.velocity)) : 0.8;
  // a velocity-0 note is silent; building it would also mean exponential ramps to 0, which Web Audio refuses
  if (velRaw <= 0) return null;
  const p = kind === 'plugin' ? instrument.params : withDefaults(kind, instrument.params);
  const t = opts.time;
  const v = new Voice(ctx, dest, t);
  const key = opts.key;
  const args = { t, vel: velocityGain(velRaw), velRaw, key, ratio: Math.pow(2, (key - 60) / 12), glideFrom: opts.glideFrom, buffer: opts.buffer };
  let natural;
  try {
    if (DRUMS[kind]) natural = DRUMS[kind](v, ctx, p, args);
    else if (kind === 'bass808') natural = bass808(v, ctx, p, args);
    else if (kind === 'synth') natural = synth(v, ctx, p, args);
    else if (kind === 'fm') natural = fm(v, ctx, p, args);
    else if (kind === 'sampler') natural = sampler(v, ctx, p, args);
    else if (BAND[kind]) natural = BAND[kind](v, ctx, p, args);
    else if (WORLD[kind]) natural = WORLD[kind](v, ctx, p, args);
    else if (kind === 'plugin') natural = pluginVoice(v, ctx, instrument, args);
  } catch (err) {
    // one note the Web Audio API refuses must not break the transport (the scheduler would retry the same range on
    // every tick and stack the other notes): drop it, release what it built, say so once per instrument
    v.stopAt(t);
    v.cleanup();
    if (!warned.has(kind)) {
      warned.add(kind);
      console.warn(`GreanTeaDawy: a ${kind} note could not be played:`, err);
    }
    return null;
  }
  if (!v.sources.length) {
    v.cleanup();
    return null;
  }
  if (natural) v.end = natural;
  if (opts.duration != null && v.releaseFn) v.release(t + Math.max(0.01, opts.duration));
  else if (opts.duration != null && natural) v.stopAt(natural);
  return v;
}

