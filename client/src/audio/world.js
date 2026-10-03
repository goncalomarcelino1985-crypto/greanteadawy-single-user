// The flute, beatbox, Indian and East Asian collections. Same voice contract as instruments.js and band.js: register
// sources with v.add, connect to v.out, return the natural end (or null while held) and set v.releaseFn for note-off.
//   flutes   one breath engine; WIND holds each kind's harmonic recipe, breath band and attack scoop
//   reeds    shehnai and suona (double reeds with formants), harmonium (free-reed banks + a shared bellows pulse)
//   erhu     bowed fiddle with a skin resonator
//   strings  sitar, tanpura, santoor, koto, guzheng, pipa, shamisen: physical models rendered ahead of time
//            (models.js), played like the guitar by modelVoice
//   drums    tabla (bols), taiko, gong / bell
//   beatbox  mouth sounds: plosive bursts, fricative hiss and vowel formants
import { midiToFreq } from '@greanteadawy/core';
import { noiseSource, shaperCurve, adsr, percEnv, timbre, FLAT_Q } from './dsp.js';
import { modelOf } from './models.js';
import { osc, biquad, gainNode, sharedLfo, modelVoice } from './band.js';

const nyq = (ctx) => ctx.sampleRate / 2 - 100;

const waveCache = new WeakMap();
/** A PeriodicWave from harmonic amplitudes (sine phases, normalized by the browser), cached per context. */
function harmonicWave(ctx, id, amps) {
  let m = waveCache.get(ctx);
  if (!m) waveCache.set(ctx, (m = new Map()));
  let w = m.get(id);
  if (!w) {
    const real = new Float32Array(amps.length + 1);
    const imag = new Float32Array(amps.length + 1);
    amps.forEach((a, i) => { imag[i + 1] = a; });
    w = ctx.createPeriodicWave(real, imag);
    m.set(id, w);
  }
  return w;
}

/**
 * A sine LFO (−1..1) that fades in after `delay`: a player's vibrato starts once the note has settled. Its cycle is
 * shared by every note of the context (sharedLfo), so a slurred note carries on the vibrato in phase.
 */
function delayedLfo(v, ctx, t, rate, delay, rise) {
  const lfo = sharedLfo(v, ctx, rate, t);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.setValueAtTime(0, t + delay);
  env.gain.linearRampToValueAtTime(1, t + delay + rise);
  lfo.connect(env);
  return env;
}

/**
 * Vibrato on pitch (cents) and a little on level; returns the node to connect onwards. A slurred note (`slur`) carries
 * on the vibrato of the note before it (in phase, at full depth) instead of waiting for it to fade in again.
 */
function addVibrato(v, ctx, t, p, from, detunes, cents, ampDepth, delay = 0.18, rise = 0.45, slur = false) {
  if (p.vibrato <= 0.001) return from;
  const lfo = slur ? delayedLfo(v, ctx, t, p.vibratoRate, 0, 0.02) : delayedLfo(v, ctx, t, p.vibratoRate, delay, rise);
  const pitch = gainNode(ctx, p.vibrato * cents);
  lfo.connect(pitch);
  for (const d of detunes) pitch.connect(d);
  const trem = gainNode(ctx, 1 - p.vibrato * ampDepth);
  lfo.connect(gainNode(ctx, p.vibrato * ampDepth)).connect(trem.gain);
  from.connect(trem);
  return trem;
}

/** Start `param` at `from` and slide to `to` (mono legato), or just set `to`. */
function glideParam(param, t, from, to, time) {
  if (from && time > 0.003) {
    param.setValueAtTime(from, t);
    param.exponentialRampToValueAtTime(to, t + time);
  } else {
    param.setValueAtTime(to, t);
  }
}

/** A filtered noise burst with a percussive envelope; returns its end time. */
function noiseHit(v, ctx, t, { type = 'bandpass', freq, q = 1, level, decay, attack = 0.001, hp = 0, lp = 0 }) {
  const n = v.add(noiseSource(ctx, false));
  const pass = type === 'lowpass' || type === 'highpass';
  let node = n.connect(biquad(ctx, type, Math.min(nyq(ctx), freq), pass ? FLAT_Q : q));
  if (hp) node = node.connect(biquad(ctx, 'highpass', hp, FLAT_Q));
  if (lp) node = node.connect(biquad(ctx, 'lowpass', Math.min(nyq(ctx), lp), FLAT_Q));
  const g = ctx.createGain();
  const end = percEnv(g.gain, t, level, decay, attack);
  node.connect(g).connect(v.out);
  n.start(t);
  n.stop(end);
  return end;
}

/** A sine (or other wave) with a percussive envelope and an optional pitch drop; returns its end time. */
function toneHit(v, ctx, t, { wave = 'sine', freq, from = 0, drop = 0.03, level, decay, attack = 0.001, dest }) {
  const o = v.add(osc(ctx, wave, from || freq, t));
  if (from) o.frequency.exponentialRampToValueAtTime(freq, t + drop);
  const g = ctx.createGain();
  const end = percEnv(g.gain, t, level, decay, attack);
  o.connect(g).connect(dest || v.out);
  o.start(t);
  o.stop(end);
  return end;
}

// ------------------------------------------------------------------ flutes

// harmonic amplitudes, Q of the pitched breath band, the attack scoop (cents below, settling time), the air band and
// a level that puts a held C5 at velocity 0.8 near -21 LUFS (like the e-piano and strings)
const WIND = {
  flute: { harm: [1, 0.5, 0.2, 0.11, 0.05, 0.03, 0.015], q: 4, scoop: [-25, 0.06], air: 7000, level: 0.56 },
  panflute: { harm: [1, 0.18, 0.06, 0.025], q: 3, scoop: [-15, 0.04], air: 6000, level: 0.51 },
  recorder: { harm: [1, 0.12, 0.2, 0.05, 0.06, 0.02], q: 6, scoop: [-10, 0.03], air: 8000, level: 0.43 },
  whistle: { harm: [1, 0.32, 0.16, 0.08, 0.04, 0.02], q: 5, scoop: [-20, 0.03], air: 9000, level: 0.48 },
  ocarina: { harm: [1, 0.04, 0.015], q: 8, scoop: [-10, 0.05], air: 4000, level: 0.52 },
  bansuri: { harm: [1, 0.35, 0.14, 0.06, 0.03], q: 3, scoop: [-35, 0.09], air: 6000, level: 0.57 },
  shakuhachi: { harm: [1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.02], q: 2, scoop: [-60, 0.18], air: 7000, level: 0.59 },
  dizi: { harm: [1, 0.55, 0.38, 0.25, 0.2, 0.14, 0.1, 0.07, 0.05], q: 4, scoop: [-20, 0.04], air: 9000, level: 0.64 }
};

function wind(kind) {
  const w = WIND[kind];
  return (v, ctx, p, { t, vel, velRaw, key, glideFrom }) => {
    const f = midiToFreq(key);
    v.freq = f;
    const slur = !!glideFrom && p.glide > 0.003; // mono legato: the new note continues the breath, no new attack
    const tone = v.add(ctx.createOscillator());
    tone.setPeriodicWave(harmonicWave(ctx, kind, w.harm));
    glideParam(tone.frequency, t, slur && glideFrom, f, p.glide);
    if (!slur) {
      // the note speaks from slightly flat (a shakuhachi swells up from well below)
      tone.detune.setValueAtTime(w.scoop[0], t);
      tone.detune.setTargetAtTime(0, t, w.scoop[1] / 3);
    }
    // blowing harder (velocity, tone) overblows: more harmonics through a brighter low-pass
    const bright = Math.max(f * 1.2, Math.min(nyq(ctx), f * (1.5 + 10 * p.tone * p.tone) * timbre(velRaw, 0.45)));
    const lp = biquad(ctx, 'lowpass', bright, FLAT_Q);
    const mix = ctx.createGain();
    tone.connect(lp).connect(mix);
    if (p.breath > 0.001) {
      // breath: air noise around the note's pitch, plus a little broadband hiss
      const n = v.add(noiseSource(ctx, true));
      const band = biquad(ctx, 'bandpass', Math.min(nyq(ctx), f), w.q);
      glideParam(band.frequency, t, slur && glideFrom, Math.min(nyq(ctx), f), p.glide);
      n.connect(band).connect(gainNode(ctx, p.breath * 3.2)).connect(mix);
      n.connect(biquad(ctx, 'bandpass', Math.min(nyq(ctx), w.air), 0.7)).connect(gainNode(ctx, p.breath * 0.08)).connect(mix);
      n.start(t);
    }
    if (p.buzz > 0.001) {
      // the dizi's membrane: the tone driven into a buzz, kept to its nasal band
      const ws = ctx.createWaveShaper();
      ws.curve = shaperCurve('soft', 0.5);
      ws.oversample = '2x';
      lp.connect(gainNode(ctx, 2)).connect(ws).connect(biquad(ctx, 'bandpass', Math.min(nyq(ctx), 3200), 1.1))
        .connect(gainNode(ctx, p.buzz * 0.5)).connect(mix);
    }
    const amp = ctx.createGain();
    amp.gain.value = 0;
    const env = adsr(amp.gain, t, { attack: slur ? 0.012 : p.attack, decay: 0.3, sustain: 0.85, release: p.release }, vel * p.gain * w.level);
    mix.connect(amp);
    addVibrato(v, ctx, t, p, amp, [tone.detune], 22, 0.12, 0.18, 0.45, slur).connect(v.out);
    if (!slur && p.chiff > 0.001) {
      // chiff: the tongued "t" of the attack, a short burst of air a little above the note
      noiseHit(v, ctx, t, { freq: f * 3, q: 1.2, level: vel * p.gain * p.chiff * 2.5 * timbre(velRaw, 0.5), decay: 0.05, attack: 0.004 });
    }
    tone.start(t);
    v.releaseFn = (time) => env.release(time, ctx.currentTime) + 0.05;
    return null;
  };
}

// ------------------------------------------------------------------ double reeds and harmonium

// harmonic roll-off (1/n^roll) and formants [Hz, Q, dB at nasal = 1]
const REED = {
  shehnai: { roll: 0.85, formants: [[1150, 3.5, 9], [2750, 3, 6]], level: 0.7 },
  suona: { roll: 0.65, formants: [[1350, 2.5, 8], [3100, 2.2, 7]], level: 1.1 } // a loud outdoor horn
};

function reed(kind) {
  const r = REED[kind];
  const amps = Array.from({ length: 30 }, (_, i) => 1 / Math.pow(i + 1, r.roll));
  return (v, ctx, p, { t, vel, velRaw, key, glideFrom }) => {
    const f = midiToFreq(key);
    v.freq = f;
    const slur = !!glideFrom && p.glide > 0.003;
    const src = v.add(ctx.createOscillator());
    src.setPeriodicWave(harmonicWave(ctx, kind, amps));
    glideParam(src.frequency, t, slur && glideFrom, f, p.glide);
    if (!slur) {
      src.detune.setValueAtTime(-15, t);
      src.detune.setTargetAtTime(0, t, 0.015);
    }
    const lp = biquad(ctx, 'lowpass', Math.max(f * 1.5, Math.min(nyq(ctx), f * (2.5 + 14 * Math.pow(p.tone, 1.5)) * timbre(velRaw, 0.4))), FLAT_Q);
    src.connect(lp);
    if (p.breath > 0.001) {
      const n = v.add(noiseSource(ctx, true));
      n.connect(biquad(ctx, 'bandpass', 2200, 0.8)).connect(gainNode(ctx, p.breath * 0.25)).connect(lp);
      n.start(t);
    }
    let node = lp;
    for (const [hz, q, db] of r.formants) node = node.connect(biquad(ctx, 'peaking', Math.min(nyq(ctx), hz), q, db * (0.3 + 0.9 * p.nasal)));
    const amp = ctx.createGain();
    amp.gain.value = 0;
    const env = adsr(amp.gain, t, { attack: slur ? 0.012 : p.attack, decay: 0.2, sustain: 0.9, release: p.release }, vel * p.gain * r.level);
    node.connect(amp);
    addVibrato(v, ctx, t, p, amp, [src.detune], 30, 0.1, 0.12, 0.35, slur).connect(v.out);
    src.start(t);
    v.releaseFn = (time) => env.release(time, ctx.currentTime) + 0.05;
    return null;
  };
}

// a free reed: every harmonic, the even ones a little weaker (a nasal, accordion-like buzz)
const FREE_REED = Array.from({ length: 24 }, (_, i) => (1 / (i + 1)) * ((i + 1) % 2 ? 1 : 0.7));

function harmonium(v, ctx, p, { t, velRaw, key }) {
  const f = midiToFreq(key);
  v.freq = f;
  // bass, male and female reeds an octave apart, never quite in tune with each other
  const banks = [[p.bassReed, 0.5, -3], [p.maleReed, 1, 0], [p.femaleReed, 2, 3.5]].filter(([lvl]) => lvl > 0.001);
  if (!banks.length) return t;
  const energy = banks.reduce((s, [l]) => s + l * l, 0);
  const scale = Math.pow(energy, 0.15) / Math.sqrt(energy); // more reeds = fuller and only a little louder
  const wave = harmonicWave(ctx, 'harmonium', FREE_REED);
  const mix = ctx.createGain();
  for (const [lvl, mul, cents] of banks) {
    if (f * mul > nyq(ctx)) continue;
    const o = v.add(ctx.createOscillator());
    o.setPeriodicWave(wave);
    o.frequency.setValueAtTime(f * mul, t);
    // a reed "speaks" from slightly flat
    o.detune.setValueAtTime(cents - 8, t);
    o.detune.setTargetAtTime(cents, t, 0.012);
    o.connect(gainNode(ctx, lvl * scale)).connect(mix);
    o.start(t);
  }
  if (!v.sources.length) return t;
  const body = biquad(ctx, 'peaking', 1300, 1.2, 3);
  const lp = biquad(ctx, 'lowpass', Math.min(nyq(ctx), f * (3 + 12 * p.tone)), FLAT_Q);
  const amp = ctx.createGain();
  amp.gain.value = 0;
  // a harmonium is (almost) not velocity sensitive
  const env = adsr(amp.gain, t, { attack: p.attack, decay: 0.05, sustain: 1, release: p.release }, p.gain * 0.35 * (0.8 + 0.2 * velRaw));
  mix.connect(body).connect(lp).connect(amp);
  let node = amp;
  if (p.bellows > 0.001) {
    // one bellows for the whole instrument: the pulse moves every note together
    const lfo = sharedLfo(v, ctx, p.bellowsRate, t);
    const trem = gainNode(ctx, 1 - p.bellows * 0.15);
    lfo.connect(gainNode(ctx, p.bellows * 0.15)).connect(trem.gain);
    node.connect(trem);
    node = trem;
  }
  node.connect(v.out);
  v.releaseFn = (time) => env.release(time, ctx.currentTime) + 0.03;
  return null;
}

// ------------------------------------------------------------------ erhu

function erhu(v, ctx, p, { t, vel, velRaw, key, glideFrom }) {
  const f = midiToFreq(key);
  v.freq = f;
  const slur = !!glideFrom && p.glide > 0.003;
  const src = v.add(osc(ctx, 'sawtooth', f, t));
  glideParam(src.frequency, t, slur && glideFrom, f, p.glide);
  // bow pressure (velocity) and pitch open the tone; the python-skin resonator gives the nasal, vocal colour
  const cut = (900 + p.brightness * p.brightness * 6500) * timbre(velRaw, 0.55) * Math.pow(2, (key - 67) / 24);
  const hp = biquad(ctx, 'highpass', Math.max(30, f * 0.7), FLAT_Q);
  const lp = biquad(ctx, 'lowpass', Math.min(nyq(ctx), cut), FLAT_Q);
  src.connect(hp);
  if (p.bowNoise > 0.001) {
    const n = v.add(noiseSource(ctx, true));
    n.connect(biquad(ctx, 'bandpass', Math.min(nyq(ctx), 2500), 0.9)).connect(gainNode(ctx, p.bowNoise * 0.3)).connect(hp);
    n.start(t);
  }
  const skin = hp.connect(lp)
    .connect(biquad(ctx, 'peaking', 750, 1.4, 2 + 6 * p.body))
    .connect(biquad(ctx, 'peaking', 1650, 2, 1 + 4 * p.body))
    .connect(biquad(ctx, 'peaking', Math.min(nyq(ctx), 3100), 2.5, 1 + 3 * p.body));
  const amp = ctx.createGain();
  amp.gain.value = 0;
  const attack = slur ? 0.012 : p.attack * (1.3 - 0.6 * velRaw); // harder bowing speaks faster; a slur is one bow
  const env = adsr(amp.gain, t, { attack, decay: 0.3, sustain: 0.9, release: p.release }, vel * p.gain * 0.5);
  skin.connect(amp);
  addVibrato(v, ctx, t, p, amp, [src.detune], 40, 0.06, 0.15, 0.5, slur).connect(v.out);
  src.start(t);
  v.releaseFn = (time) => env.release(time, ctx.currentTime) + 0.05;
  return null;
}

// ------------------------------------------------------------------ modelled strings

// rendered notes are levelled by their attack (models.js); these put them near the guitar and piano
const MODEL_LEVEL = { sitar: 2.1, tanpura: 1.7, santoor: 1.8, koto: 2, guzheng: 2, pipa: 1.8, shamisen: 1.8 };

const plucked = (kind) => (v, ctx, p, args) =>
  modelVoice(v, ctx, modelOf(kind, p), args, { level: p.gain * MODEL_LEVEL[kind], release: p.release, glide: p.mono ? p.glide : 0 });

// ------------------------------------------------------------------ tabla

const DAYAN_MODES = [1, 2, 3, 4.01, 5.03]; // the syahi (black patch) makes the treble drum's modes almost harmonic
// per stroke: mode amplitudes, mode decays (s), finger slap level
const DAYAN = {
  tun: [[1, 0.25, 0.08, 0.04, 0.02], [1.1, 0.5, 0.3, 0.2, 0.15], 0.2],
  tin: [[0.5, 0.7, 0.35, 0.15, 0.08], [0.55, 0.6, 0.4, 0.25, 0.2], 0.3],
  na: [[0.15, 0.6, 0.8, 0.45, 0.25], [0.12, 0.55, 0.65, 0.4, 0.3], 0.5],
  te: [[0.4, 0.3, 0.2, 0.1, 0.05], [0.06, 0.05, 0.04, 0.03, 0.03], 0.9]
};
// bol → [treble (dayan) stroke, bass (bayan) stroke]
const BOLS = { na: ['na', null], tin: ['tin', null], tun: ['tun', null], te: ['te', null], ge: [null, 'ge'], ke: [null, 'ke'], dha: ['na', 'ge'], dhin: ['tin', 'ge'] };

function dayan(v, ctx, t, stroke, f, vel, velRaw, decay) {
  const [amps, decays, slap] = DAYAN[stroke];
  let end = t;
  DAYAN_MODES.forEach((m, i) => {
    if (f * m > nyq(ctx) || amps[i] < 0.01) return;
    // the head is a touch tighter for an instant after the strike
    end = Math.max(end, toneHit(v, ctx, t, { freq: f * m, from: f * m * 1.01, drop: 0.03, level: vel * amps[i] * 0.63 * (i ? timbre(velRaw, 0.5) : 1), decay: decays[i] * decay }));
  });
  const closed = stroke === 'te';
  return Math.max(end, noiseHit(v, ctx, t, { freq: closed ? 1800 : 3200, q: 1, level: vel * slap * (closed ? 1.8 : 0.9) * timbre(velRaw, 0.5), decay: closed ? 0.035 : 0.012 }));
}

function bayan(v, ctx, t, stroke, f, bend, vel, velRaw, decay) {
  if (stroke === 'ke') {
    // closed: the flat hand stops the head at once
    return Math.max(
      noiseHit(v, ctx, t, { type: 'lowpass', freq: 900, level: vel * 2.6, decay: 0.07 }),
      toneHit(v, ctx, t, { freq: f * 1.3, level: vel * 0.8, decay: 0.05 })
    );
  }
  // open (ge): a boom whose pitch rises as the heel of the palm presses into the head
  const o = v.add(osc(ctx, 'sine', f, t));
  const o2 = v.add(osc(ctx, 'sine', f * 1.59, t)); // a second, inharmonic membrane mode
  if (bend > 0.01) {
    o.frequency.setTargetAtTime(f * (1 + 0.5 * bend), t + 0.03, 0.12);
    o2.frequency.setTargetAtTime(f * 1.59 * (1 + 0.5 * bend), t + 0.03, 0.12);
  }
  const g = ctx.createGain();
  const e1 = percEnv(g.gain, t, vel * 0.9, 0.9 * decay, 0.002);
  const g2 = ctx.createGain();
  const e2 = percEnv(g2.gain, t, vel * 0.15 * timbre(velRaw, 0.5), 0.25 * decay, 0.002);
  o.connect(g).connect(v.out);
  o2.connect(g2).connect(v.out);
  o.start(t); o.stop(e1);
  o2.start(t); o2.stop(e2);
  return Math.max(e1, e2, noiseHit(v, ctx, t, { type: 'lowpass', freq: 500, level: vel * 0.6, decay: 0.03 }));
}

function tabla(v, ctx, p, { t, vel, velRaw, ratio }) {
  const [d, b] = BOLS[p.stroke] || BOLS.na;
  const both = d && b ? 0.8 : 1;
  let end = t + 0.02;
  if (d) end = Math.max(end, dayan(v, ctx, t, d, p.tune * ratio, vel * both, velRaw, p.decay));
  if (b) end = Math.max(end, bayan(v, ctx, t, b, p.bayanTune * ratio, p.bend, vel * both, velRaw, p.decay));
  return end;
}

// ------------------------------------------------------------------ taiko

const TAIKO_MODES = [[1, 1], [1.59, 0.45], [2.14, 0.3], [2.3, 0.22], [2.65, 0.15], [2.92, 0.1]]; // circular membrane

function taiko(v, ctx, p, { t, vel, velRaw, ratio }) {
  const f = p.pitch * ratio;
  let end = t + 0.02;
  TAIKO_MODES.forEach(([m, a], i) => {
    const amp = (i === 0 ? 1 : a * p.body * 1.6 * timbre(velRaw, 0.5)) * 0.75;
    if (amp < 0.005 || f * m * 1.15 > nyq(ctx)) return;
    // the skin's tension drops as it rebounds: every mode falls a little in pitch
    end = Math.max(end, toneHit(v, ctx, t, { freq: f * m, from: f * m * 1.15, drop: 0.07, level: vel * amp, decay: p.decay / (1 + (m - 1) * 1.5), attack: 0.002 }));
  });
  if (p.stick > 0.01) {
    // the bachi: a wooden click, and the slap of the skin
    end = Math.max(end, noiseHit(v, ctx, t, { freq: 1800, q: 0.9, level: vel * p.stick * timbre(velRaw, 0.4), decay: 0.025 }));
    end = Math.max(end, noiseHit(v, ctx, t, { type: 'lowpass', freq: Math.min(4000, f * 8), level: vel * p.stick * 0.7, decay: 0.06 }));
  }
  return end;
}

// ------------------------------------------------------------------ gong and temple bell

// [ratio, amplitude, decay factor]: a gong's crowded inharmonic modes; a bell's hum, prime, minor third, fifth...
const GONG_MODES = [[1, 1, 1], [1.52, 0.7, 0.8], [2.03, 0.55, 0.65], [2.31, 0.5, 0.6], [2.84, 0.4, 0.5], [3.13, 0.35, 0.45], [3.72, 0.3, 0.4], [4.21, 0.25, 0.35], [4.95, 0.2, 0.3], [5.6, 0.16, 0.25]];
const BELL_MODES = [[0.5, 0.6, 1.3], [1, 1, 1], [1.19, 0.5, 0.75], [1.5, 0.4, 0.6], [2, 0.45, 0.5], [2.51, 0.25, 0.4], [2.66, 0.2, 0.35], [3.01, 0.2, 0.3], [4.1, 0.12, 0.2]];

function gong(v, ctx, p, { t, vel, velRaw, ratio }) {
  const f = p.pitch * ratio;
  const hard = Math.max(0.05, p.mallet * timbre(velRaw, 0.5));
  const bendTo = 1 + 0.12 * p.bend; // opera gongs: the pitch falls (daluo) or rises (xiaoluo) after the hit
  let end = t + 0.05;
  (p.type === 'bell' ? BELL_MODES : GONG_MODES).forEach(([m, a, d], i) => {
    const fm = f * m;
    if (fm * Math.max(1, bendTo) > nyq(ctx)) return;
    const o = v.add(osc(ctx, 'sine', fm, t));
    if (Math.abs(p.bend) > 0.01) o.frequency.exponentialRampToValueAtTime(fm * bendTo, t + 0.35);
    const g = ctx.createGain();
    // a harder mallet excites more of the high modes
    const e = percEnv(g.gain, t, vel * a * Math.pow(0.3 + 0.7 * hard, i / 3) * 0.45, p.decay * d, 0.003);
    o.connect(g).connect(v.out);
    o.start(t);
    o.stop(e);
    end = Math.max(end, e);
  });
  if (p.shimmer > 0.01) {
    // the tam-tam's bloom: after the hit the energy spreads into a high, shimmering wash
    const n = v.add(noiseSource(ctx, true));
    const g = ctx.createGain();
    const swell = t + 0.3 + 0.3 * (1 - hard);
    const e = swell + p.decay * 0.6;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel * p.shimmer * 0.25, swell);
    g.gain.exponentialRampToValueAtTime(0.0001, e);
    n.connect(biquad(ctx, 'bandpass', Math.min(nyq(ctx), 3200), 0.7)).connect(biquad(ctx, 'highpass', 1500, FLAT_Q)).connect(g).connect(v.out);
    n.start(t);
    n.stop(e + 0.02);
    end = Math.max(end, e + 0.02);
  }
  return Math.max(end, noiseHit(v, ctx, t, { type: 'lowpass', freq: 500, level: vel * 0.5 * (0.5 + hard), decay: 0.04 }));
}

// ------------------------------------------------------------------ beatbox

function bbkick(v, ctx, p, { t, vel, velRaw, ratio }) {
  const f = p.pitch * ratio;
  // the lips: a low pressure thump that drops fast (shorter and rounder than a drum machine's)
  const o = v.add(osc(ctx, 'sine', f * (1 + p.punch * 2.5), t));
  o.frequency.exponentialRampToValueAtTime(f, t + 0.035);
  const amp = ctx.createGain();
  const end = percEnv(amp.gain, t, vel * 0.8, p.decay, 0.003);
  o.connect(amp);
  let node = amp;
  if (p.drive > 0.01) {
    // close-mic proximity: a little saturated
    const ws = ctx.createWaveShaper();
    ws.curve = shaperCurve('soft', p.drive * 0.8);
    ws.oversample = '2x';
    // saturation raises the average level: drive adds grit, not loudness
    node = node.connect(ws).connect(gainNode(ctx, 1 / (1 + 1.5 * p.drive)));
  }
  node.connect(biquad(ctx, 'lowpass', 3000, FLAT_Q)).connect(v.out);
  o.start(t);
  o.stop(end);
  if (p.air <= 0.01) return end;
  // the "b": a puff of air through the lips and the pop of the lips parting
  noiseHit(v, ctx, t, { freq: 1800, q: 1.2, level: vel * p.air * 0.8, decay: 0.006 });
  return Math.max(end, noiseHit(v, ctx, t, { type: 'lowpass', freq: 900, level: vel * p.air * 1.6 * timbre(velRaw, 0.4), decay: 0.035 }));
}

function bbsnare(v, ctx, p, { t, vel, velRaw, ratio }) {
  const tone = Math.min(nyq(ctx) * 0.8, p.tone * ratio * timbre(velRaw, 0.8));
  let end = t;
  const hit = (at, o) => { end = Math.max(end, noiseHit(v, ctx, at, { ...o, level: o.level * 1.2 })); };
  switch (p.style) {
    case 'psh': // "P" then a spitty "sh"
      hit(t, { freq: 900, q: 0.8, level: vel * p.snap * 2.2, decay: 0.01 });
      hit(t, { freq: tone * 0.65, q: 1.1, level: vel * 1.8, decay: p.decay * 1.3, attack: 0.004, hp: 1200 });
      break;
    case 'k': // inward K: a click, then the hiss of the breath drawn in through a narrow throat
      hit(t, { freq: 2300, q: 2, level: vel * p.snap * 2.4, decay: 0.006 });
      hit(t, { freq: tone * 0.5, q: 2.6, level: vel * 3.6, decay: p.decay * 0.85, attack: 0.012 });
      break;
    case 'kch': // "K" and "ch", the second burst a moment later, like a clap
      hit(t, { freq: 2500, q: 1.6, level: vel * p.snap * 2.4, decay: 0.006 });
      hit(t, { freq: tone, q: 1, level: vel * 1.5, decay: p.decay, attack: 0.002 });
      hit(t + 0.012, { freq: tone * 0.8, q: 1, level: vel * 1.2, decay: p.decay * 0.8 });
      break;
    default: // "Pf": the lips burst open, then an "f" hiss
      hit(t, { freq: 800, q: 0.8, level: vel * p.snap * 2.2, decay: 0.009 });
      hit(t, { type: 'highpass', freq: tone * 0.5, level: vel * 1.1, decay: p.decay, attack: 0.003, lp: tone * 2 });
  }
  if (p.body > 0.01) end = Math.max(end, toneHit(v, ctx, t, { wave: 'triangle', freq: 170 * ratio, from: 210 * ratio, drop: 0.05, level: vel * p.body * 0.7, decay: 0.07 }));
  return end;
}

function bbhat(v, ctx, p, { t, vel, velRaw, ratio }) {
  const color = Math.min(nyq(ctx) * 0.85, p.color * ratio * timbre(velRaw, 0.85));
  const inward = p.style === 'inward';
  const sh = p.style === 'tch';
  let end = t;
  // the tongue tapping the palate, then the "s" (or "sh") of the hat
  if (p.click > 0.01) end = noiseHit(v, ctx, t, { freq: Math.min(nyq(ctx) * 0.8, 4500 * ratio), q: 1.5, level: vel * p.click, decay: 0.004 });
  return Math.max(end, noiseHit(v, ctx, t + (inward ? 0.004 : 0), {
    freq: sh ? color * 0.5 : color, q: sh ? 1.2 : 1.8, hp: sh ? 1800 : 3500,
    level: vel * (inward ? 0.65 : 0.8), decay: p.decay, attack: inward ? 0.015 : p.style === 'ts' ? 0.004 : 0.002
  }));
}

const VOWELS = {
  oo: [[300, 6, 1], [870, 8, 0.35], [2240, 10, 0.12]],
  oh: [[500, 6, 1], [900, 8, 0.5], [2400, 10, 0.15]],
  ah: [[730, 5, 1], [1090, 7, 0.6], [2440, 10, 0.2]],
  mm: [[250, 5, 1], [1000, 10, 0.08], [2300, 12, 0.04]]
};
const VOWEL_LEVEL = { mm: 1.6 }; // a closed-mouth hum is quieter: level it with the open vowels

function bbbass(v, ctx, p, { t, vel, key, glideFrom }) {
  const f = midiToFreq(key);
  v.freq = f;
  const slur = !!glideFrom && p.glide > 0.003;
  const src = v.add(osc(ctx, 'sawtooth', f, t));
  glideParam(src.frequency, t, slur && glideFrom, f, p.glide);
  const voice = ctx.createGain();
  src.connect(voice);
  let node = voice;
  let sub = null;
  if (p.growl > 0.01) {
    // the throat: a sub-octave rattle and some grit
    sub = v.add(osc(ctx, 'square', f / 2, t));
    glideParam(sub.frequency, t, slur && glideFrom / 2, f / 2, p.glide);
    sub.connect(gainNode(ctx, p.growl * 0.35)).connect(voice);
    const ws = ctx.createWaveShaper();
    ws.curve = shaperCurve('soft', p.growl * 0.7);
    ws.oversample = '2x';
    node.connect(ws);
    node = ws;
  }
  const mix = ctx.createGain();
  // the chest (fundamental and first harmonics: a beatbox bass lives down here) and the mouth's vowel formants
  node.connect(biquad(ctx, 'lowpass', Math.min(nyq(ctx), f * 2.5), FLAT_Q)).connect(mix);
  const formants = (VOWELS[p.vowel] || VOWELS.oo).map(([hz, q, g]) => {
    const bp = biquad(ctx, 'bandpass', hz, q);
    node.connect(bp).connect(gainNode(ctx, g * 0.9)).connect(mix);
    return bp;
  });
  if (p.wobble > 0.01) {
    // the mouth opening and closing: "wub"
    const lfo = v.add(osc(ctx, 'sine', p.wobbleRate, t));
    const depth = gainNode(ctx, p.wobble * 900);
    lfo.connect(depth);
    for (const bp of formants) depth.connect(bp.detune);
    lfo.start(t);
  }
  const amp = ctx.createGain();
  amp.gain.value = 0;
  const env = adsr(amp.gain, t, { attack: slur ? 0.008 : p.attack, decay: 0.15, sustain: 0.9, release: p.release }, vel * p.gain * 0.9 * (VOWEL_LEVEL[p.vowel] || 1));
  mix.connect(amp).connect(v.out);
  src.start(t);
  sub?.start(t);
  v.releaseFn = (time) => env.release(time, ctx.currentTime) + 0.05;
  return null;
}

function bbfx(v, ctx, p, { t, vel, ratio }) {
  const f = p.pitch * ratio;
  const end = t + p.decay;
  /** attack, hold and a short fade at `end` */
  const shape = (g, level, attack = 0.01) => {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.setValueAtTime(level, Math.max(t + attack, end - 0.04));
    g.gain.linearRampToValueAtTime(0, end);
  };
  if (p.style === 'clickroll') {
    // tongue clicks in quick succession, slowly losing force
    const n = v.add(noiseSource(ctx, true));
    const g = ctx.createGain();
    const count = Math.max(1, Math.floor(p.decay * p.rate));
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i < count; i++) {
      const at = t + i / p.rate;
      const a = vel * 5 * (1 - (0.5 * i) / count);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(a, at + 0.001);
      g.gain.exponentialRampToValueAtTime(Math.max(1e-4, a * 0.001), at + Math.min(0.012, 0.8 / p.rate));
    }
    n.connect(biquad(ctx, 'bandpass', Math.min(nyq(ctx), f * 4), 1.5)).connect(g).connect(v.out);
    n.start(t);
    n.stop(end + 0.02);
    return end + 0.02;
  }
  const g = ctx.createGain();
  let src;
  let formant;
  if (p.style === 'scratch') {
    // "wicka-wicka": a buzzy vowel pushed up and pulled back like a record under the hand
    src = v.add(osc(ctx, 'sawtooth', f, t));
    formant = biquad(ctx, 'bandpass', 700, 3);
    formant.frequency.setValueAtTime(700, t); // anchor the sweep at the note (offline renders schedule seconds ahead)
    const strokes = Math.max(1, Math.round((p.rate * p.decay) / 2));
    const step = p.decay / (strokes * 2);
    for (let i = 0; i < strokes; i++) {
      src.frequency.exponentialRampToValueAtTime(f * 2.2, t + (2 * i + 1) * step);
      src.frequency.exponentialRampToValueAtTime(f * 0.8, t + (2 * i + 2) * step);
      formant.frequency.exponentialRampToValueAtTime(1800, t + (2 * i + 1) * step);
      formant.frequency.exponentialRampToValueAtTime(700, t + (2 * i + 2) * step);
    }
    shape(g, vel * 1.4);
  } else if (p.style === 'zap') {
    // a laser: a buzz diving from high to low through a closing mouth
    src = v.add(osc(ctx, 'square', Math.min(nyq(ctx) / 2, f * 4), t));
    src.frequency.exponentialRampToValueAtTime(f * 0.5, end);
    formant = biquad(ctx, 'bandpass', 2000, 2);
    formant.frequency.setValueAtTime(2000, t);
    formant.frequency.exponentialRampToValueAtTime(500, end);
    percEnv(g.gain, t, vel * 0.9, p.decay, 0.003);
  } else {
    // a siren "woo": up and back down, with a wobble
    src = v.add(osc(ctx, 'triangle', f, t));
    src.frequency.exponentialRampToValueAtTime(f * 2, t + p.decay / 2);
    src.frequency.exponentialRampToValueAtTime(f, end);
    const lfo = v.add(osc(ctx, 'sine', p.rate, t));
    lfo.connect(gainNode(ctx, 50)).connect(src.detune);
    lfo.start(t);
    lfo.stop(end + 0.02);
    formant = biquad(ctx, 'lowpass', 1200, FLAT_Q);
    shape(g, vel * 0.36, 0.04);
  }
  src.connect(formant).connect(g).connect(v.out);
  src.start(t);
  src.stop(end + 0.02);
  return end + 0.02;
}

export const WORLD = {
  flute: wind('flute'), panflute: wind('panflute'), recorder: wind('recorder'), whistle: wind('whistle'), ocarina: wind('ocarina'),
  bbkick, bbsnare, bbhat, bbbass, bbfx,
  sitar: plucked('sitar'), tanpura: plucked('tanpura'), tabla, bansuri: wind('bansuri'), shehnai: reed('shehnai'),
  santoor: plucked('santoor'), harmonium,
  koto: plucked('koto'), guzheng: plucked('guzheng'), pipa: plucked('pipa'), shamisen: plucked('shamisen'), erhu,
  shakuhachi: wind('shakuhachi'), dizi: wind('dizi'), suona: reed('suona'), taiko, gong
};
