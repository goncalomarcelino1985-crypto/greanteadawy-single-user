// Mixer effects built from native Web Audio nodes.
// Each factory returns { input, output, update(params), automation: { key: AudioParam | AudioParam[] }, dispose(), sync? }
import { divisionBeats, EFFECTS } from '@greanteadawy/core';
import { pluginEffectNode } from './plugins.js';
import { shaperCurve, dbToGain, setParam, FLAT_Q, compressorAutoMakeupDb } from './dsp.js';

/** Look-ahead delay of the browsers' DynamicsCompressorNode (Chromium/WebKit/Gecko share the same 6 ms design). */
const COMPRESSOR_LATENCY = 0.006;



function wetDry(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  input.connect(dry).connect(output);
  wet.connect(output);
  return {
    input, output, dry, wet,
    setMix(mix) {
      setParam(dry.gain, Math.cos(mix * Math.PI / 2), ctx);
      setParam(wet.gain, Math.sin(mix * Math.PI / 2), ctx);
    }
  };
}

/** Exposes one "mix" AudioParam that drives both dry and wet gains (for automation). */
function mixParam(ctx, wd) {
  // dry = 1 - m, wet = m (linear crossfade) driven by a ConstantSource
  const cs = ctx.createConstantSource();
  cs.offset.value = 0;
  const inv = ctx.createGain();
  inv.gain.value = -1;
  cs.connect(wd.wet.gain);
  cs.connect(inv).connect(wd.dry.gain);
  cs.start();
  return {
    param: cs.offset,
    set(mix) {
      wd.dry.gain.value = 1;
      wd.wet.gain.value = 0;
      setParam(cs.offset, mix, ctx);
    },
    stop() { try { cs.stop(); } catch { /* ignore */ } }
  };
}

const FACTORIES = {
  eq(ctx) {
    const nyq = ctx.sampleRate / 2 - 100;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = FLAT_Q;
    const low = ctx.createBiquadFilter(); low.type = 'lowshelf';
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking';
    const high = ctx.createBiquadFilter(); high.type = 'highshelf';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = FLAT_Q;
    hp.connect(low).connect(mid).connect(high).connect(lp);
    return {
      input: hp, output: lp,
      update(p) {
        // 20 Hz / 20 kHz are "off": park the filters where they can't colour anything
        setParam(hp.frequency, p.hpf > 20.5 ? p.hpf : 5, ctx);
        setParam(lp.frequency, Math.min(nyq, p.lpf < 19999 ? p.lpf : nyq), ctx);
        setParam(low.gain, p.low, ctx); setParam(low.frequency, p.lowFreq, ctx);
        setParam(mid.gain, p.mid, ctx); setParam(mid.frequency, p.midFreq, ctx); setParam(mid.Q, p.midQ, ctx);
        setParam(high.gain, p.high, ctx); setParam(high.frequency, p.highFreq, ctx);
      },
      automation: { hpf: hp.frequency, lpf: lp.frequency, low: low.gain, lowFreq: low.frequency, mid: mid.gain, midFreq: mid.frequency, high: high.gain, highFreq: high.frequency },
      transform: { lpf: (v) => Math.min(nyq, v) }
    };
  },

  filter(ctx) {
    const wd = wetDry(ctx);
    const f = ctx.createBiquadFilter();
    wd.input.connect(f).connect(wd.wet);
    const mix = mixParam(ctx, wd);
    return {
      input: wd.input, output: wd.output,
      update(p) {
        f.type = p.type;
        setParam(f.frequency, Math.min(ctx.sampleRate / 2 - 100, p.cutoff), ctx);
        setParam(f.Q, p.resonance, ctx);
        mix.set(p.mix);
      },
      automation: { cutoff: f.frequency, resonance: f.Q, mix: mix.param },
      dispose: () => mix.stop()
    };
  },

  compressor(ctx) {
    const wd = wetDry(ctx);
    const c = ctx.createDynamicsCompressor();
    // the browser adds automatic makeup gain (0.6 × the reduction at 0 dBFS — ≈ +7 dB at the defaults, ~+14 dB for a
    // low-threshold parallel setting): take it back out, so the Makeup knob is the only makeup. The correction follows
    // the set threshold/ratio; automating them moves the level like the browser's own makeup did.
    const unAuto = ctx.createGain();
    const makeup = ctx.createGain();
    // browsers' compressors look ahead (≈6 ms): delay the dry path to match, or parallel compression comb-filters
    const align = ctx.createDelay(0.05);
    // whole samples, truncated like the browsers' own look-ahead (264 frames @ 44.1k): a fractional delay would
    // interpolate (dulling the dry highs) and an extra frame would comb-filter against the compressed path
    align.delayTime.value = Math.floor(COMPRESSOR_LATENCY * ctx.sampleRate) / ctx.sampleRate;
    wd.input.disconnect();
    wd.input.connect(align).connect(wd.dry);
    wd.input.connect(c).connect(unAuto).connect(makeup).connect(wd.wet);
    const mix = mixParam(ctx, wd);
    return {
      input: wd.input, output: wd.output,
      update(p) {
        setParam(c.threshold, p.threshold, ctx); setParam(c.ratio, p.ratio, ctx);
        setParam(c.attack, p.attack, ctx); setParam(c.release, p.release, ctx); setParam(c.knee, p.knee, ctx);
        setParam(unAuto.gain, dbToGain(-compressorAutoMakeupDb(p.threshold, p.knee, Math.max(1, p.ratio))), ctx);
        setParam(makeup.gain, dbToGain(p.makeup), ctx);
        mix.set(p.mix ?? 1);
      },
      automation: { threshold: c.threshold, ratio: c.ratio, makeup: makeup.gain, mix: mix.param },
      transform: { makeup: dbToGain },
      meter: () => c.reduction,
      dispose: () => mix.stop()
    };
  },

  delay(ctx, engine) {
    const wd = wetDry(ctx);
    const split = ctx.createGain();
    const dl = ctx.createDelay(4);
    const dr = ctx.createDelay(4);
    const fbl = ctx.createGain();
    const fbr = ctx.createGain();
    // flat (non-resonant) filters: with a resonant peak the feedback loop gain could exceed 1 and run away
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.Q.value = FLAT_Q;
    const tone2 = ctx.createBiquadFilter(); tone2.type = 'lowpass'; tone2.Q.value = FLAT_Q;
    // repeats lose their lows each time round, so echoes never build up mud under the kick and bass
    const lowCut = ctx.createBiquadFilter(); lowCut.type = 'highpass'; lowCut.frequency.value = 120; lowCut.Q.value = FLAT_Q;
    const lowCut2 = ctx.createBiquadFilter(); lowCut2.type = 'highpass'; lowCut2.frequency.value = 120; lowCut2.Q.value = FLAT_Q;
    const merger = ctx.createChannelMerger(2);
    const mono = ctx.createGain();
    mono.channelCount = 1; mono.channelCountMode = 'explicit'; mono.channelInterpretation = 'speakers';
    wd.input.connect(mono).connect(split);
    dl.connect(lowCut).connect(tone); dr.connect(lowCut2).connect(tone2);
    tone.connect(merger, 0, 0);
    tone2.connect(merger, 0, 1);
    merger.connect(wd.wet);
    const mix = mixParam(ctx, wd);
    let pingPong = null;
    let params = null;
    const wire = (pp) => {
      if (pp === pingPong) return;
      pingPong = pp;
      for (const n of [split, tone, tone2, fbl, fbr]) { try { n.disconnect(); } catch { /* ignore */ } }
      tone.connect(merger, 0, 0);
      tone2.connect(merger, 0, 1);
      if (pp) {
        split.connect(dl);
        tone.connect(fbl).connect(dr);
        tone2.connect(fbr).connect(dl);
      } else {
        split.connect(dl); split.connect(dr);
        tone.connect(fbl).connect(dl);
        tone2.connect(fbr).connect(dr);
      }
    };
    const setTime = () => {
      if (!params) return;
      const sec = (divisionBeats(params.time) * 60) / engine.bpm;
      setParam(dl.delayTime, Math.min(3.9, sec), ctx, 0.05);
      setParam(dr.delayTime, Math.min(3.9, pingPong ? sec : sec * 1.01), ctx, 0.05);
    };
    return {
      input: wd.input, output: wd.output,
      update(p) {
        params = p;
        wire(p.pingPong);
        setTime();
        setParam(fbl.gain, p.feedback, ctx); setParam(fbr.gain, p.feedback, ctx);
        setParam(tone.frequency, p.tone, ctx); setParam(tone2.frequency, p.tone, ctx);
        mix.set(p.mix);
      },
      onTempo: setTime,
      automation: { feedback: [fbl.gain, fbr.gain], tone: [tone.frequency, tone2.frequency], mix: mix.param },
      dispose: () => mix.stop()
    };
  },

  reverb(ctx, engine) {
    const wd = wetDry(ctx);
    const pre = ctx.createDelay(1);
    // normalize (the default) scales every impulse to the same loudness, so a new room sound keeps the mix level
    const conv = ctx.createConvolver();
    const damp = ctx.createBiquadFilter(); damp.type = 'lowpass'; damp.Q.value = FLAT_Q;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 120; hp.Q.value = FLAT_Q;
    wd.input.connect(pre).connect(hp).connect(conv).connect(damp).connect(wd.wet);
    const mix = mixParam(ctx, wd);
    let room = '';
    let timer = null;
    const build = (decay, size) => { conv.buffer = impulse(ctx, decay, size); };
    return {
      input: wd.input, output: wd.output,
      update(p) {
        const size = p.size ?? 0.5;
        const key = `${p.decay}:${size}`;
        if (key !== room) {
          room = key;
          clearTimeout(timer);
          // building a long room takes ~50–100 ms: while a knob is dragged in the studio, build once it settles;
          // offline renders (and the first build) need it right away
          if (!conv.buffer || !engine?.realtime) build(p.decay, size);
          else timer = setTimeout(() => build(p.decay, size), 120);
        }
        setParam(pre.delayTime, p.predelay, ctx);
        setParam(damp.frequency, p.damping, ctx);
        mix.set(p.mix);
      },
      automation: { damping: damp.frequency, mix: mix.param },
      dispose: () => { clearTimeout(timer); mix.stop(); }
    };
  },

  distortion(ctx) {
    const wd = wetDry(ctx);
    const pre = ctx.createGain();
    const ws = ctx.createWaveShaper();
    ws.oversample = '4x';
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
    const out = ctx.createGain();
    wd.input.connect(pre).connect(ws).connect(tone).connect(wd.wet);
    wd.output.connect(out);
    const mix = mixParam(ctx, wd);
    let key = '';
    return {
      input: wd.input, output: out,
      update(p) {
        const k = `${p.mode}:${p.drive}`;
        if (k !== key) { key = k; ws.curve = shaperCurve(p.mode, p.drive); }
        setParam(pre.gain, 1 + p.drive * 2, ctx);
        setParam(tone.frequency, p.tone, ctx);
        setParam(out.gain, p.output, ctx);
        mix.set(p.mix);
      },
      automation: { tone: tone.frequency, mix: mix.param, output: out.gain },
      dispose: () => mix.stop()
    };
  },

  chorus(ctx) {
    const wd = wetDry(ctx);
    const split = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const dl = ctx.createDelay(0.1);
    const dr = ctx.createDelay(0.1);
    const lfo = ctx.createOscillator();
    const gl = ctx.createGain();
    const gr = ctx.createGain();
    lfo.connect(gl).connect(dl.delayTime);
    lfo.connect(gr).connect(dr.delayTime);
    lfo.start();
    wd.input.connect(split);
    split.connect(dl, 0); split.connect(dr, 1);
    dl.connect(merger, 0, 0); dr.connect(merger, 0, 1);
    merger.connect(wd.wet);
    const mix = mixParam(ctx, wd);
    return {
      input: wd.input, output: wd.output,
      update(p) {
        setParam(lfo.frequency, p.rate, ctx);
        setParam(dl.delayTime, p.delay, ctx); setParam(dr.delayTime, p.delay, ctx);
        const depth = p.depth * p.delay * 0.9;
        setParam(gl.gain, depth, ctx); setParam(gr.gain, -depth, ctx);
        mix.set(p.mix);
      },
      automation: { rate: lfo.frequency, mix: mix.param },
      dispose: () => { try { lfo.stop(); } catch { /* ignore */ } mix.stop(); }
    };
  },

  phaser(ctx) {
    const wd = wetDry(ctx);
    const stages = [0, 1, 2, 3].map(() => { const f = ctx.createBiquadFilter(); f.type = 'allpass'; f.Q.value = 0.6; return f; });
    for (let i = 0; i < stages.length - 1; i++) stages[i].connect(stages[i + 1]);
    const fb = ctx.createGain();
    const fbDelay = ctx.createDelay(0.01);
    fbDelay.delayTime.value = 0.0005;
    stages[3].connect(fb).connect(fbDelay).connect(stages[0]);
    wd.input.connect(stages[0]);
    stages[3].connect(wd.wet);
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.connect(lg);
    for (const s of stages) lg.connect(s.detune);
    lfo.start();
    const mix = mixParam(ctx, wd);
    return {
      input: wd.input, output: wd.output,
      update(p) {
        setParam(lfo.frequency, p.rate, ctx);
        setParam(lg.gain, p.depth * 2400, ctx);
        for (const s of stages) setParam(s.frequency, p.frequency, ctx);
        setParam(fb.gain, p.feedback, ctx);
        mix.set(p.mix);
      },
      automation: { rate: lfo.frequency, mix: mix.param },
      dispose: () => { try { lfo.stop(); } catch { /* ignore */ } mix.stop(); }
    };
  },

  bitcrusher(ctx) {
    const wd = wetDry(ctx);
    const ws = ctx.createWaveShaper();
    wd.input.connect(ws).connect(wd.wet);
    const mix = mixParam(ctx, wd);
    let bits = null;
    return {
      input: wd.input, output: wd.output,
      update(p) {
        if (p.bits !== bits) { bits = p.bits; ws.curve = shaperCurve('crush', p.bits); }
        mix.set(p.mix);
      },
      automation: { mix: mix.param },
      dispose: () => mix.stop()
    };
  },

  stereo(ctx) {
    const input = ctx.createGain();
    const wide = ctx.createGain();
    const out = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    input.channelCount = 2; input.channelCountMode = 'explicit';
    wide.channelCount = 2; wide.channelCountMode = 'explicit';
    wide.connect(split);
    merger.connect(out);
    // optional mono low end: a Linkwitz-Riley crossover (two cascaded Butterworths) whose lows are summed to mono
    const bq = (type) => { const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = FLAT_Q; return f; };
    const lp = [bq('lowpass'), bq('lowpass')];
    const hp = [bq('highpass'), bq('highpass')];
    const monoLow = ctx.createGain();
    monoLow.channelCount = 1; monoLow.channelCountMode = 'explicit'; monoLow.channelInterpretation = 'speakers';
    lp[0].connect(lp[1]).connect(monoLow).connect(out);
    hp[0].connect(hp[1]).connect(wide);
    let split2 = null;
    const route = (on) => {
      if (on === split2) return;
      split2 = on;
      try { input.disconnect(); } catch { /* ignore */ }
      if (on) { input.connect(lp[0]); input.connect(hp[0]); } else input.connect(wide);
    };
    // outL = L*(1+w)/2 + R*(1-w)/2 ; outR = L*(1-w)/2 + R*(1+w)/2, driven by one width ConstantSource
    const w = ctx.createConstantSource();
    w.start();
    const mk = (sign) => {
      const g = ctx.createGain();
      g.gain.value = 0.5;
      const s = ctx.createGain();
      s.gain.value = sign * 0.5;
      w.connect(s).connect(g.gain);
      return g;
    };
    const ll = mk(1); const rl = mk(-1); const lr = mk(-1); const rr = mk(1);
    split.connect(ll, 0); split.connect(rl, 1); split.connect(lr, 0); split.connect(rr, 1);
    ll.connect(merger, 0, 0); rl.connect(merger, 0, 0);
    lr.connect(merger, 0, 1); rr.connect(merger, 0, 1);
    return {
      input, output: out,
      update(p) {
        setParam(w.offset, p.width, ctx);
        const f = p.monoBelow ?? 0;
        route(f >= 20);
        if (f >= 20) for (const x of [...lp, ...hp]) setParam(x.frequency, f, ctx);
      },
      automation: { width: w.offset },
      dispose: () => { try { w.stop(); } catch { /* ignore */ } }
    };
  },

  pump(ctx, engine) {
    const g = ctx.createGain();
    let lfo = null;
    let lfoGain = null;
    let params = null;
    const stopLfo = (time) => {
      if (lfo) { try { lfo.stop(time); } catch { /* ignore */ } lfo = null; }
    };
    const idle = () => {
      stopLfo(ctx.currentTime);
      g.gain.cancelScheduledValues(ctx.currentTime);
      g.gain.setValueAtTime(1, ctx.currentTime);
    };
    return {
      input: g, output: g,
      get source() { return params?.source || null; },
      update(p) {
        const changed = !params || p.rate !== params.rate || p.depth !== params.depth || p.shape !== params.shape || p.source !== params.source;
        params = p;
        if (changed && engine.transport?.playing) this.sync(engine.transport.syncPoint());
      },
      /** Note-driven mode: duck at `time` (called by the Transport for each note of the source channel). */
      trigger(time) {
        if (!params?.source) return;
        const release = Math.max(0.03, params.shape * (60 / engine.bpm));
        g.gain.setTargetAtTime(1 - params.depth, time, 0.002);
        g.gain.setTargetAtTime(1, time + 0.01, release / 3);
      },
      /** Restart the LFO aligned to the beat grid: { time, tick, bpm } */
      sync({ time, tick, bpm }) {
        if (!params) return;
        if (params.source) {
          // the source channel's notes drive it; just drop a running grid LFO
          if (lfo) {
            stopLfo(time);
            g.gain.cancelScheduledValues(time);
            g.gain.setValueAtTime(1, time);
          }
          return;
        }
        stopLfo(time);
        const beats = divisionBeats(params.rate);
        const periodTicks = beats * 96;
        const phase = ((tick % periodTicks) + periodTicks) % periodTicks / periodTicks;
        const { wave, mean } = pumpWave(ctx, params.depth, params.shape, phase);
        lfo = ctx.createOscillator();
        lfo.setPeriodicWave(wave);
        lfo.frequency.value = bpm / 60 / beats;
        lfoGain = ctx.createGain();
        lfoGain.gain.value = 1;
        lfo.connect(lfoGain).connect(g.gain);
        g.gain.cancelScheduledValues(time);
        g.gain.setValueAtTime(mean, time);
        lfo.start(time);
      },
      stopSync: idle,
      automation: {},
      dispose: () => stopLfo(ctx.currentTime)
    };
  },

  limiter(ctx) {
    const pre = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    const clip = ctx.createWaveShaper();
    clip.oversample = '4x'; // the final clip stage would otherwise alias and create inter-sample overs
    const post = ctx.createGain();
    pre.connect(comp).connect(post).connect(clip);
    let ceiling = null;
    return {
      input: pre, output: clip,
      update(p) {
        setParam(pre.gain, dbToGain(p.gain), ctx);
        // the compressor catches peaks just under the ceiling (its 6 ms look-ahead keeps it clean) and the
        // oversampled clip stage takes the last ~1.5 dB — a deeper threshold made masters 3–4 dB quieter than asked
        const threshold = p.ceiling - LIMITER_HEADROOM;
        comp.threshold.value = threshold;
        comp.knee.value = 1;
        comp.ratio.value = 20;
        comp.attack.value = 0.001;
        comp.release.value = p.release;
        // the Web Audio compressor adds automatic makeup gain: take it back out exactly
        post.gain.value = dbToGain(-compressorAutoMakeupDb(threshold, 1, 20));
        if (p.ceiling !== ceiling) { ceiling = p.ceiling; clip.curve = shaperCurve('clip', dbToGain(p.ceiling)); }
      },
      automation: { gain: pre.gain },
      transform: { gain: dbToGain },
      meter: () => comp.reduction
    };
  }
};

const impulseCache = new WeakMap(); // per AudioContext: offline renders don't pin rooms of other contexts

/**
 * A generated room: sparse early reflections (spread by `size`), then a diffuse tail whose high frequencies die
 * faster than its lows (as in real rooms), with independent noise per side for width. Seeded, so renders are
 * reproducible. The convolver normalizes its level.
 */
function impulse(ctx, decay, size = 0.5) {
  const sr = ctx.sampleRate;
  const key = `${decay}:${size}`;
  let rooms = impulseCache.get(ctx);
  if (!rooms) impulseCache.set(ctx, (rooms = new Map()));
  if (rooms.has(key)) return rooms.get(key);
  const len = Math.max(1, Math.floor(sr * Math.min(10, decay * 1.2)));
  const buf = ctx.createBuffer(2, len, sr);
  const erEnd = 0.008 + size * 0.07; // early reflections window (s)
  const onset = 0.004 + size * 0.03; // the diffuse tail fades in over this time
  const hfDecay = decay * (0.35 + 0.25 * (1 - size)); // highs reach -60 dB this soon
  const lnK = Math.log(1000);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let seed = 0x9e3779b9 ^ (c + 1) * 0x85ebca6b ^ Math.round(decay * 1000) * 31 ^ Math.round(size * 1000);
    const rand = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return ((seed >>> 0) / 4294967296) * 2 - 1;
    };
    if (!seed) seed = 1;
    let y = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp((-lnK * t) / decay);
      // one-pole low-pass sweeping down from ~16 kHz: the tail darkens as it decays
      const fc = Math.max(400, 16000 * Math.exp((-lnK * t) / hfDecay));
      y += (1 - Math.exp((-2 * Math.PI * fc) / sr)) * (rand() - y);
      const fade = t < onset ? t / onset : 1;
      d[i] = y * env * fade;
    }
    // early reflections: a handful of discrete taps, different per side
    const taps = 6 + Math.round(size * 8);
    for (let k = 0; k < taps; k++) {
      const at = Math.floor(sr * (0.002 + erEnd * ((k + 0.5 + 0.4 * rand()) / taps)));
      if (at < len) d[at] += (rand() < 0 ? -1 : 1) * 0.5 * Math.pow(0.82, k);
    }
  }
  if (rooms.size > 8) rooms.clear();
  rooms.set(key, buf);
  return buf;
}

/**
 * dB from the limiter's ceiling down to its compressor threshold. At ratio 20 the browser's compressor lets peaks
 * rise ~1 dB over its threshold when driven 12 dB into it; the oversampled clip stage (topping out 0.4 dB under the
 * ceiling) rounds off the rest. Calibrated by rendering the genre templates at +0/+6/+12/+18 dB input gain.
 */
export const LIMITER_HEADROOM = 1.5;

const pumpCache = new Map();
/** Periodic wave for the sidechain-style ducking curve, phase-shifted. */
function pumpWave(ctx, depth, shape, phase) {
  const key = `${depth.toFixed(3)}:${shape.toFixed(3)}:${phase.toFixed(3)}`;
  const cached = pumpCache.get(key);
  if (cached && cached.ctx === ctx) return cached;
  const N = 256;
  const H = 48;
  const samples = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = ((i / N) + phase) % 1;
    // duck to (1 - depth) at the beat, recover with a smooth curve by `shape` of the period
    const r = Math.min(1, x / Math.max(0.02, shape));
    const curve = 1 - depth * Math.pow(1 - r, 2.2);
    samples[i] = curve;
  }
  let mean = 0;
  for (const s of samples) mean += s;
  mean /= N;
  const real = new Float32Array(H);
  const imag = new Float32Array(H);
  for (let k = 1; k < H; k++) {
    let a = 0;
    let b = 0;
    for (let i = 0; i < N; i++) {
      const ang = (2 * Math.PI * k * i) / N;
      a += (samples[i] - mean) * Math.cos(ang);
      b += (samples[i] - mean) * Math.sin(ang);
    }
    real[k] = (2 * a) / N;
    imag[k] = (2 * b) / N;
  }
  const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  const res = { wave, mean, ctx };
  if (pumpCache.size > 64) pumpCache.clear();
  pumpCache.set(key, res);
  return res;
}

export function createEffectNode(ctx, type, engine, effect = null) {
  if (type === 'plugin') {
    const fx = pluginEffectNode(ctx, engine, effect || {});
    fx.type = type;
    fx.def = { params: fx.defs };
    return fx;
  }
  const f = FACTORIES[type];
  if (!f) throw new Error(`Unknown effect ${type}`);
  const fx = f(ctx, engine);
  fx.type = type;
  fx.def = EFFECTS[type];
  return fx;
}
