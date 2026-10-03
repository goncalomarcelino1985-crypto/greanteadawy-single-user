// 3D objects in the audio engine (coordinates and layouts: packages/core/src/spatial.js).
//   stereo    objects stay in the stereo mix, panned by their x (what you hear with spatial monitoring off)
//   binaural  each object goes through an HRTF panner (headphones) into the master — master FX still apply
//   speakers  offline 5.1/7.1/7.1.4: the bed (master) feeds L/R, each object is spread over the speakers by
//             energy-preserving gains (+ its LFE send); objects skip the master bus, as in an Atmos renderer
//   objects   offline stems: bed on channels 1–2, every object on its own channel (mono) for ADM / object stems
import { SPEAKER_LAYOUTS, speakerGains, normalizeInsertSpatial } from '@greanteadawy/core';
import { FLAT_Q } from './dsp.js';

const LFE_HZ = 120;

const HRTF_TRIM = Math.pow(10, -3.5 / 20);

export class SpatialRig {
  constructor(engine, { mode = 'stereo', layout = null, objectOrder = [] } = {}) {
    this.engine = engine;
    this.ctx = engine.ctx;
    this.mode = mode;
    this.layout = layout ? SPEAKER_LAYOUTS[layout] : null;
    this.layoutId = layout;
    this.objectOrder = objectOrder; // objects mode: insert index → output channel 2 + position in this list
    this.nodes = new Map(); // insert index → object node
    this.merger = null;
    if (mode === 'speakers' || mode === 'objects') {
      const n = this.ctx.destination.channelCount;
      const dest = this.ctx.destination;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete'; // the stereo bed lands on channels 1–2, nothing is up-mixed
      this.merger = this.ctx.createChannelMerger(n);
      this.merger.connect(dest);
    }
  }

  /** Does this rig take objects out of the normal stereo routing? */
  get routesObjects() {
    return this.mode !== 'stereo';
  }

  setMode(mode) {
    if (mode === this.mode || this.merger) return false; // offline rigs are fixed
    for (const i of [...this.nodes.keys()]) this.detach(i);
    this.mode = mode;
    return true;
  }

  /** The node an object insert's output connects to (created on first use). */
  attach(index, spatial) {
    let node = this.nodes.get(index);
    if (!node) {
      node = this.create(index);
      this.nodes.set(index, node);
      node.cur = normalizeInsertSpatial(spatial);
      node.apply(node.cur, this.ctx.currentTime, false);
    }
    return node;
  }

  detach(index) {
    const node = this.nodes.get(index);
    if (!node) return;
    for (const n of node.all) { try { n.disconnect(); } catch { /* ignore */ } }
    this.nodes.delete(index);
  }

  /** Static position (no automation playing). */
  place(index, spatial) {
    const node = this.nodes.get(index);
    if (!node) return;
    node.cur = normalizeInsertSpatial(spatial);
    const t = this.ctx.currentTime;
    node.cancel(t);
    node.apply(node.cur, t, false);
  }

  /** AudioParam-like handles for automating one axis ('x' | 'y' | 'z'); positions are re-panned at each point. */
  axisParams(index, axis) {
    const node = this.nodes.get(index);
    if (!node) return [];
    return [{
      cancelScheduledValues: (t) => node.cancel(t),
      setValueAtTime: (v, t) => { node.cur = { ...node.cur, [axis]: v }; node.apply(node.cur, t, false); },
      linearRampToValueAtTime: (v, t) => { node.cur = { ...node.cur, [axis]: v }; node.apply(node.cur, t, true); }
    }];
  }

  create(index) {
    const ctx = this.ctx;
    // objects are mono: (L + R)/√2 keeps a centred source at its stereo-mix loudness
    const down = ctx.createGain();
    down.channelCount = 1;
    down.channelCountMode = 'explicit';
    down.channelInterpretation = 'speakers';
    down.gain.value = Math.SQRT2; // the down-mix averages (L + R)/2: ×√2 makes it (L + R)/√2
    const all = [down];
    const set = (param, v, t, ramp) => (ramp ? param.linearRampToValueAtTime(v, t) : param.setValueAtTime(v, t));

    if (this.mode === 'binaural') {
      // Chromium's HRTF panner adds ≈ 2–4 dB of energy over a constant-power pan (measured: front/side ≈ +3.8 dB,
      // rear/overhead ≈ +2 dB): take 3.5 dB off so switching monitoring or exporting binaural doesn't jump in level
      down.gain.value = Math.SQRT2 * HRTF_TRIM;
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'linear';
      p.rolloffFactor = 0; // direction only: distance doesn't change the level
      p.refDistance = 1;
      p.maxDistance = 10000;
      down.connect(p).connect(this.engine.inserts[0].input);
      all.push(p);
      // Web Audio: x right, y up, z towards the listener (front = -z)
      return {
        input: down, all,
        apply: (pos, t, ramp) => {
          set(p.positionX, pos.x, t, ramp);
          set(p.positionY, pos.z, t, ramp);
          set(p.positionZ, -pos.y - (Math.abs(pos.x) + Math.abs(pos.y) + pos.z < 1e-3 ? 0.01 : 0), t, ramp);
        },
        cancel: (t) => { for (const a of [p.positionX, p.positionY, p.positionZ]) a.cancelScheduledValues(t); }
      };
    }

    if (this.mode === 'speakers') {
      const layout = this.layout;
      const gains = layout.speakers.map(([, d], ch) => {
        if (!d) return null;
        const g = ctx.createGain();
        g.gain.value = 0;
        down.connect(g);
        g.connect(this.merger, 0, ch);
        all.push(g);
        return g;
      });
      // LFE send: 24 dB/oct low-pass at 120 Hz into the LFE channel
      const lfeCh = layout.speakers.findIndex(([id]) => id === 'LFE');
      const lfe = ctx.createGain();
      lfe.gain.value = 0;
      const lp1 = ctx.createBiquadFilter();
      const lp2 = ctx.createBiquadFilter();
      for (const f of [lp1, lp2]) { f.type = 'lowpass'; f.frequency.value = LFE_HZ; f.Q.value = FLAT_Q; }
      down.connect(lfe).connect(lp1).connect(lp2).connect(this.merger, 0, lfeCh);
      all.push(lfe, lp1, lp2);
      return {
        input: down, all,
        apply: (pos, t, ramp) => {
          const g = speakerGains(this.layoutId, pos);
          gains.forEach((node, i) => { if (node) set(node.gain, g[i], t, ramp); });
          set(lfe.gain, pos.lfe ?? 0, t, ramp);
        },
        cancel: (t) => { for (const node of [...gains, lfe]) node?.gain.cancelScheduledValues(t); }
      };
    }

    // objects: one channel each (positions travel as metadata)
    const slot = this.objectOrder.indexOf(index);
    if (slot >= 0) down.connect(this.merger, 0, 2 + slot);
    return { input: down, all, apply: () => {}, cancel: () => {} };
  }
}
