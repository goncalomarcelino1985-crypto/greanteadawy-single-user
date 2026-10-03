// The audio engine: channel strips -> mixer inserts (effects, routing, sends) -> master,
// plus a lookahead scheduler (Transport) that plays patterns / the playlist.
// Works with both AudioContext (realtime) and OfflineAudioContext (WAV export).
import {
  PPQ, ticksPerBar, patternLength, songLength, patternNotesInRange, songNotesInRange,
  songAudioInRange, songAudioCovering, songAutomationInRange, automationValueAt, swingTicks,
  EFFECTS, getChannel, isSpatialObject, SPATIAL_PARAMS, spatialFromNorm, instrumentDefaults
} from '@greanteadawy/core';
import { playNote, Voice } from './instruments.js';
import { prewarmModels, prewarmRange } from './modelPool.js';
import { modelOf, layerOf } from './models.js';
import { SpatialRig } from './spatial.js';
import { preparePlugins, pluginParamDefs, pluginEntry } from './plugins.js';
import { createEffectNode } from './effects.js';
import { setParam, denormalize } from './dsp.js';

const LOOKAHEAD = 0.12; // seconds
const INTERVAL = 25; // ms
const AUTOMATION_STEP = 12; // ticks between automation points (1/32 note)

// Each sample's revision (it goes up when the wave editor replaces the audio). Sample files are cached as immutable,
// so the revision is part of the URL; shared by the realtime engine and offline renders.
const SAMPLE_REVS = new Map();

/** The URL of a sample's audio at its current revision. */
export function sampleFileUrl(id) {
  return `/api/samples/${encodeURIComponent(id)}/file?v=${sampleRev(id)}`;
}

/** The revision of a sample's audio this tab knows about (1 = as uploaded). */
export function sampleRev(id) {
  return SAMPLE_REVS.get(id) || 1;
}

/**
 * Note the revisions of the sample library (called on every library refresh, whether or not the audio engine exists
 * yet — browser jobs fetch sample files in tabs nobody has clicked in). Returns the ids whose audio changed.
 */
export function noteSampleRevs(list) {
  const changed = [];
  for (const s of list || []) {
    const rev = s.rev || 1;
    const known = SAMPLE_REVS.get(s.id);
    SAMPLE_REVS.set(s.id, rev);
    if (known !== undefined && known !== rev) changed.push(s.id);
  }
  return changed;
}

export class AudioEngine {
  /** spatial (offline renders): { mode: 'binaural' | 'speakers' | 'objects', layout, objectOrder } — see spatial.js */
  constructor(ctx, { realtime = true, spatial = null } = {}) {
    this.ctx = ctx;
    this.realtime = realtime;
    this.fixedSpatial = !!spatial;
    this.project = null;
    this.bpm = 130;
    this.inserts = [];
    this.strips = new Map();
    this.voices = new Set();
    this.monoLast = new Map();
    this.samples = new Map();
    this.sampleLoads = new Map();
    this.sampleRevs = new Map(); // id -> the revision of the audio decoded (or loading) here
    this.sampleUrl = sampleFileUrl;
    this.automated = new Set();
    this.sampleFailed = new Set();
    this.metronome = false;

    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.out.connect(this.analyser);
    this.out.connect(ctx.destination);
    this.clickOut = ctx.createGain();
    this.clickOut.gain.value = 0.35;
    this.clickOut.connect(ctx.destination);
    this.transport = new Transport(this);
    this.meterBuf = new Float32Array(256);
    this.rig = new SpatialRig(this, spatial || { mode: 'stereo' });
  }

  /** Is insert i a 3D object that leaves the normal stereo routing (binaural/speaker/object rendering)? */
  routedObject(i) {
    return this.rig.routesObjects && isSpatialObject(this.project, i);
  }

  // ------------------------------------------------------------------ project sync

  setProject(project) {
    const prev = this.project;
    this.project = project;
    if (!prev || prev.bpm !== project.bpm) this.setBpm(project.bpm);
    this.syncMixer(prev);
    this.syncChannels();
    this.loadNeededSamples(project);
    preparePlugins(this.ctx, project);
    if (this.realtime) {
      // physical-model notes (piano, guitar, bass) render in background workers shortly after an edit settles
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = setTimeout(() => this.prewarmModels(), 150);
    }
  }

  /** The installed plugins changed: rebuild effect chains (plugin slots) and load what the project needs. */
  refreshPlugins() {
    for (const ins of this.inserts) ins.fxKey = '';
    const p = this.project;
    this.project = null;
    if (p) this.setProject(p);
  }

  /** Render every physical-model note the project plays that isn't cached yet (resolves when they are). */
  prewarmModels(project = this.project) {
    return project ? prewarmModels(project, this.ctx.sampleRate, { pin: this.realtime }).catch((e) => console.warn('model prewarm failed', e)) : Promise.resolve();
  }

  setBpm(bpm) {
    if (bpm === this.bpm) return;
    this.bpm = bpm;
    this.transport.onTempoChange();
    for (const ins of this.inserts) for (const fx of ins.fx) fx.node.onTempo?.();
  }

  syncMixer(prev) {
    const mixer = this.project.mixer;
    // realtime monitoring follows the project: binaural (headphones) when the spatial mix is on and set to it
    if (!this.fixedSpatial) {
      const sp = this.project.spatial;
      if (this.rig.setMode(sp?.enabled && sp.monitor === 'binaural' ? 'binaural' : 'stereo')) {
        for (const ins of this.inserts) ins.routeKey = null;
        prev = null;
      }
    }
    while (this.inserts.length < mixer.length) this.inserts.push(this.createInsert(this.inserts.length));
    while (this.inserts.length > mixer.length) this.disposeInsert(this.inserts.pop());
    // audibility of an insert depends on every insert's solo flag and the routing graph
    const soloSig = mixer.map((m) => `${m.solo ? 1 : 0}${m.output}`).join(',');
    const soloChanged = soloSig !== this.soloSig;
    this.soloSig = soloSig;
    const anySolo = mixer.some((m, i) => i > 0 && m.solo);
    const spatialSig = `${this.project.spatial?.enabled ? 1 : 0}${this.rig.mode}`;
    const spatialChanged = spatialSig !== this.spatialSig;
    this.spatialSig = spatialSig;
    mixer.forEach((m, i) => {
      const ins = this.inserts[i];
      const pm = prev?.mixer[i];
      if (pm !== m || soloChanged || spatialChanged || ins.anySolo !== anySolo) {
        ins.anySolo = anySolo;
        const audible = !m.mute && (i === 0 || !anySolo || m.solo || this.feedsSolo(i));
        if (!this.automated.has(`mixer:${i}:volume`) && !(i === 0 && this.automated.has('master:volume'))) setParam(ins.fader.gain, m.volume, this.ctx);
        // a 3D object's stereo pan is its x (stereo monitoring); routed objects are panned in 3D instead
        const object = isSpatialObject(this.project, i);
        const pan = object ? (this.rig.routesObjects ? 0 : m.spatial.x) : m.pan;
        const panAutomated = this.automated.has(`mixer:${i}:pan`) || (object && this.automated.has(`mixer:${i}:spatialX`));
        if (!panAutomated && !(i === 0 && this.automated.has('master:pan'))) setParam(ins.panner.pan, pan, this.ctx);
        if (object && this.rig.routesObjects && !['X', 'Y', 'Z'].some((a) => this.automated.has(`mixer:${i}:spatial${a}`))) this.rig.place(i, m.spatial);
        setParam(ins.mute.gain, audible ? 1 : 0, this.ctx, 0.005);
        this.syncEffects(ins, m.effects);
      }
    });
    // routing (after all inserts exist)
    mixer.forEach((m, i) => {
      const ins = this.inserts[i];
      const object = i > 0 && this.routedObject(i);
      const key = i === 0 ? 'master' : `${m.output}|${(m.sends || []).map((s) => s.to).join(',')}|${object ? `3d:${this.rig.mode}` : ''}`;
      if (ins.routeKey === key) {
        // same connections: only glide the send levels (rebuilding would click while a knob moves)
        for (const s of m.sends || []) {
          const node = ins.sendNodes.find((x) => x.to === s.to);
          if (node) setParam(node.gain.gain, s.amount, this.ctx);
        }
        return;
      }
      ins.routeKey = key;
      try { ins.post.disconnect(); } catch { /* ignore */ }
      ins.post.connect(ins.meter);
      for (const s of ins.sendNodes) { try { s.gain.disconnect(); } catch { /* ignore */ } }
      ins.sendNodes = [];
      if (i === 0) {
        ins.post.connect(this.out);
        return;
      }
      if (object) {
        ins.post.connect(this.rig.attach(i, m.spatial).input);
      } else {
        this.rig.detach(i);
        const target = this.inserts[m.output] || this.inserts[0];
        ins.post.connect(target.input);
      }
      for (const s of m.sends || []) {
        const t = this.inserts[s.to];
        if (!t || s.to === i) continue;
        const g = this.ctx.createGain();
        g.gain.value = s.amount;
        ins.post.connect(g).connect(t.input);
        ins.sendNodes.push({ to: s.to, gain: g });
      }
    });
  }

  feedsSolo(i) {
    // an insert that routes into a soloed insert stays audible
    const mixer = this.project.mixer;
    const seen = new Set();
    let cur = i;
    while (cur > 0 && !seen.has(cur)) {
      seen.add(cur);
      if (mixer[cur].solo) return true;
      cur = mixer[cur].output || 0;
    }
    return false;
  }

  createInsert(index) {
    const ctx = this.ctx;
    const ins = {
      index,
      input: ctx.createGain(),
      fader: ctx.createGain(),
      panner: ctx.createStereoPanner(),
      mute: ctx.createGain(),
      post: ctx.createGain(),
      meter: ctx.createAnalyser(),
      fx: [],
      fxKey: '',
      sendNodes: [],
      routeKey: null,
      anySolo: null
    };
    ins.meter.fftSize = 256;
    ins.fader.connect(ins.panner).connect(ins.mute).connect(ins.post);
    ins.input.connect(ins.fader);
    return ins;
  }

  disposeInsert(ins) {
    this.rig.detach(ins.index);
    for (const fx of ins.fx) fx.node.dispose?.();
    for (const n of [ins.input, ins.post]) { try { n.disconnect(); } catch { /* ignore */ } }
  }

  syncEffects(ins, effects) {
    // plugin slots are rebuilt when their plugin is installed, updated, enabled or disabled (rev = package hash or none)
    const rev = (e) => (e.type === 'plugin' ? pluginEntry(e.plugin)?.sha256 || 'none' : '');
    const key = effects.map((e) => `${e.id}:${e.type}:${e.plugin || ''}:${rev(e)}:${e.enabled ? 1 : 0}`).join('|');
    if (key !== ins.fxKey) {
      ins.fxKey = key;
      const old = new Map(ins.fx.map((f) => [f.id, f]));
      const next = [];
      for (const e of effects) {
        let f = old.get(e.id);
        if (f && f.type === e.type && f.plugin === e.plugin && f.rev === rev(e)) old.delete(e.id);
        else f = { id: e.id, type: e.type, plugin: e.plugin, rev: rev(e), node: createEffectNode(this.ctx, e.type, this, e), params: null };
        f.enabled = e.enabled;
        next.push(f);
      }
      for (const f of old.values()) {
        f.node.dispose?.();
        try { f.node.output.disconnect(); } catch { /* ignore */ }
      }
      // rewire chain: input -> enabled fx... -> fader
      try { ins.input.disconnect(); } catch { /* ignore */ }
      for (const f of next) { try { f.node.output.disconnect(); } catch { /* ignore */ } }
      let node = ins.input;
      for (const f of next) {
        if (!f.enabled) continue;
        node.connect(f.node.input);
        node = f.node.output;
      }
      node.connect(ins.fader);
      ins.fx = next;
    }
    effects.forEach((e, i) => {
      const f = ins.fx[i];
      if (f.params !== e.params) {
        f.params = e.params;
        f.node.update(e.params);
        if (e.type === 'pump' && this.transport.playing) f.node.sync(this.transport.syncPoint());
      }
    });
  }

  syncChannels() {
    const ctx = this.ctx;
    const chans = this.project.channels;
    const anySolo = chans.some((c) => c.solo);
    const ids = new Set();
    for (const c of chans) {
      ids.add(c.id);
      let s = this.strips.get(c.id);
      if (!s) {
        s = { input: ctx.createGain(), filter: ctx.createBiquadFilter(), vol: ctx.createGain(), pan: ctx.createStereoPanner(), route: null, channel: null, anySolo: null };
        s.filter.type = 'lowpass';
        s.input.connect(s.filter).connect(s.vol).connect(s.pan);
        this.strips.set(c.id, s);
      }
      if (s.channel === c && s.anySolo === anySolo) continue;
      s.channel = c;
      s.anySolo = anySolo;
      s.audible = !c.mute && (!anySolo || c.solo);
      if (!this.automated.has(`channel:${c.id}:volume`)) setParam(s.vol.gain, s.audible ? c.volume : 0, ctx, 0.008);
      else if (!s.audible) setParam(s.vol.gain, 0, ctx, 0.008);
      if (!this.automated.has(`channel:${c.id}:pan`)) setParam(s.pan.pan, c.pan, ctx);
      if (!this.automated.has(`channel:${c.id}:filterCutoff`)) setParam(s.filter.frequency, Math.min(ctx.sampleRate / 2 - 100, c.filterCutoff), ctx);
      if (!this.automated.has(`channel:${c.id}:filterRes`)) setParam(s.filter.Q, c.filterRes, ctx);
      const route = Math.min(c.mixerTrack, this.inserts.length - 1);
      if (s.route !== route) {
        try { s.pan.disconnect(); } catch { /* ignore */ }
        s.pan.connect(this.inserts[route].input);
        s.route = route;
      }
    }
    for (const [id, s] of this.strips) {
      if (!ids.has(id)) {
        try { s.pan.disconnect(); } catch { /* ignore */ }
        this.strips.delete(id);
      }
    }
  }

  // ------------------------------------------------------------------ samples

  loadNeededSamples(project) {
    const ids = new Set();
    for (const c of project.channels) if (c.instrument.kind === 'sampler' && c.instrument.params.sampleId) ids.add(c.instrument.params.sampleId);
    for (const clip of project.playlist.clips) if (clip.kind === 'audio') ids.add(clip.refId);
    return Promise.all([...ids].map((id) => this.loadSample(id).catch(() => null)));
  }

  loadSample(id) {
    if (this.samples.has(id)) return Promise.resolve(this.samples.get(id));
    if (this.sampleLoads.has(id)) return this.sampleLoads.get(id);
    if (this.sampleFailed.has(id)) return Promise.reject(new Error(`sample ${id} unavailable`));
    const rev = sampleRev(id);
    this.sampleRevs.set(id, rev);
    const p = fetch(this.sampleUrl(id))
      .then((r) => { if (!r.ok) throw new Error(`sample ${id}: ${r.status}`); return r.arrayBuffer(); })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => {
        // replaced while loading: this is the old audio, load again
        if (sampleRev(id) !== rev) {
          if (this.sampleLoads.get(id) === p) this.sampleLoads.delete(id);
          return this.loadSample(id);
        }
        this.samples.set(id, buf);
        this.sampleRevs.set(id, rev);
        if (this.sampleLoads.get(id) === p) this.sampleLoads.delete(id);
        this.onSampleLoaded?.(id);
        return buf;
      })
      .catch((e) => { if (this.sampleLoads.get(id) === p) this.sampleLoads.delete(id); this.sampleFailed.add(id); throw e; });
    this.sampleLoads.set(id, p);
    return p;
  }

  /** Forget failed sample loads (call when the sample library changes). */
  retryFailedSamples() {
    this.sampleFailed.clear();
    if (this.project) this.loadNeededSamples(this.project);
  }

  /**
   * The sample library changed: note each sample's revision, drop decoded audio whose sample was replaced (the
   * wave editor's "Replace original"), and load what the project needs again.
   */
  syncSampleLibrary(list) {
    noteSampleRevs(list);
    // decoded audio of an older revision than the library's
    for (const id of [...this.samples.keys(), ...this.sampleLoads.keys()]) {
      if (this.sampleRevs.has(id) && this.sampleRevs.get(id) !== sampleRev(id)) {
        this.samples.delete(id);
        this.sampleLoads.delete(id);
        this.sampleRevs.delete(id);
      }
    }
    this.retryFailedSamples();
  }

  // ------------------------------------------------------------------ notes

  /** Schedule a note on a channel. duration in seconds (null = held until noteOff). */
  triggerNote(channelId, key, velocity, time, duration, { pan = 0, force = false, pitch: autoPitch = 0 } = {}) {
    const ch = getChannel(this.project, channelId);
    const strip = this.strips.get(channelId);
    if (!ch || !strip) return null;
    // note-driven sidechains duck on every note of their source — even a muted "ghost" trigger channel
    this.forEachPump((node) => { if (node.source === channelId) node.trigger(time); });
    if (!force && !strip.audible) return null;
    const pitch = ch.pitch + autoPitch;
    const k = Math.max(0, Math.min(127, key + pitch));
    if (ch.chokeGroup) {
      for (const v of this.voices) if (v.chokeGroup === ch.chokeGroup && v.start < time + 0.0005 && !v.done) v.kill(time);
    }
    const p = ch.instrument.params;
    let glideFrom = null;
    if (p.mono) {
      const last = this.monoLast.get(channelId);
      if (last && !last.done && last.killedAt === null && last.start < time) {
        if (last.noteEnd === null || last.noteEnd > time - 0.001) glideFrom = last.freq || null;
        last.kill(time);
      }
    }
    // plugin instruments: at most `polyphony` voices per channel (each DSP voice is its own worklet processor) —
    // the oldest sounding one is cut, so dense parts or slow-to-finish plugins can't pile up CPU
    if (ch.instrument.kind === 'plugin') {
      const poly = pluginEntry(ch.instrument.plugin)?.manifest.polyphony || 16;
      const sounding = [...this.voices].filter((v) => v.channelId === channelId && !v.done && v.killedAt === null && v.start <= time + 0.0005 && v.end > time);
      // released notes (only their tail is left — and offline renders schedule ahead, so some already ended) go
      // first, oldest first; held notes only when that isn't enough
      const released = (v) => v.noteEnd !== null && v.noteEnd <= time;
      sounding.sort((a, b) => (released(b) - released(a)) || a.start - b.start);
      for (let i = 0; i <= sounding.length - poly; i++) sounding[i].kill(time);
    }
    let dest = strip.input;
    if (pan) {
      dest = this.ctx.createStereoPanner();
      dest.pan.value = pan;
      dest.connect(strip.input);
    }
    const buffer = ch.instrument.kind === 'sampler' ? this.samples.get(p.sampleId) : null;
    const v = playNote(this.ctx, dest, ch.instrument, { time, duration, key: k, velocity, glideFrom, buffer });
    if (!v) {
      if (dest !== strip.input) { try { dest.disconnect(); } catch { /* ignore */ } } // the note's panner, unused
      return null;
    }
    v.chokeGroup = ch.chokeGroup;
    v.channelId = channelId;
    v.noteEnd = duration == null ? null : time + duration;
    this.voices.add(v);
    v.onDone = () => {
      this.voices.delete(v);
      if (dest !== strip.input) { try { dest.disconnect(); } catch { /* ignore */ } }
    };
    if (p.mono) this.monoLast.set(channelId, v);
    return v;
  }

  /** Live note (computer keyboard / MIDI / piano roll click). Returns a handle for noteOff. */
  noteOn(channelId, key, velocity = 0.8) {
    this.prewarmChannel(channelId, key, velocity);
    return this.triggerNote(channelId, key, velocity, this.ctx.currentTime + 0.005, null, { force: true });
  }

  /**
   * Physical-model instruments (piano, guitar, bass, pizzicato): render the octave around a key the user is playing
   * live in the background workers, so the next notes play exact instead of a repitched neighbour (once per octave,
   * velocity layer and sound).
   */
  prewarmChannel(channelId, key = null, velocity = 0.8) {
    const ch = getChannel(this.project, channelId);
    if (!ch) return;
    let params;
    try { params = { ...instrumentDefaults(ch.instrument.kind), ...ch.instrument.params }; } catch { return; }
    const spec = modelOf(ch.instrument.kind, params);
    if (!spec) return;
    const k = Math.round((key ?? ch.rootKey) + (ch.pitch || 0));
    const layer = layerOf(velocity);
    const tag = `${spec.model}|${spec.id}|${layer}|${Math.floor(k / 12)}`;
    this.prewarmed ??= new Set();
    if (this.prewarmed.has(tag)) return;
    this.prewarmed.add(tag);
    prewarmRange(this.ctx.sampleRate, spec, k - 7, k + 7, layer);
  }

  noteOff(voice) {
    if (!voice) return;
    voice.noteEnd = this.ctx.currentTime;
    voice.release(this.ctx.currentTime);
  }

  preview(channelId, key, velocity = 0.8, duration = 0.3) {
    return this.triggerNote(channelId, key, velocity, this.ctx.currentTime + 0.005, duration, { force: true });
  }

  /** Audition a sample from the browser (one at a time; a new preview or Stop cuts the previous one). */
  previewSample(id) {
    this.stopPreview();
    this.loadSample(id).then((buf) => {
      this.stopPreview();
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const v = new Voice(this.ctx, this.inserts[0]?.input || this.out, this.ctx.currentTime);
      v.add(src);
      src.connect(v.out);
      src.start();
      v.end = this.ctx.currentTime + buf.duration;
      v.channelId = '__preview';
      this.voices.add(v);
      this.previewVoice = v;
      v.onDone = () => { this.voices.delete(v); if (this.previewVoice === v) this.previewVoice = null; };
    }).catch(() => {});
  }

  stopPreview() {
    if (this.previewVoice && !this.previewVoice.done) this.previewVoice.kill(this.ctx.currentTime);
    this.previewVoice = null;
  }

  /**
   * Play an AudioBuffer straight to the output (no master effects: the wave editor wants to hear the sample as it
   * is), from `offset` for `duration` seconds, optionally looping that range. One at a time. Returns a handle
   * { startedAt, offset, duration, loop, stop() } and calls handle.onEnded when it stops.
   */
  playBuffer(buffer, { offset = 0, duration = buffer.duration - offset, loop = false } = {}) {
    this.stopBuffer();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    src.connect(gain);
    gain.connect(this.out);
    const t = this.ctx.currentTime + 0.01;
    const dur = Math.max(0.005, Math.min(duration, buffer.duration - offset));
    if (loop) {
      src.loop = true;
      src.loopStart = offset;
      src.loopEnd = offset + dur;
      src.start(t, offset);
    } else {
      src.start(t, offset, dur);
    }
    const handle = { startedAt: t, offset, duration: dur, loop, onEnded: null, stop: () => this.stopBuffer(handle) };
    handle.src = src;
    handle.gain = gain;
    src.onended = () => {
      try { gain.disconnect(); } catch { /* ignore */ }
      if (this.bufferPlay === handle) this.bufferPlay = null;
      handle.onEnded?.();
    };
    this.bufferPlay = handle;
    return handle;
  }

  /** Stop playBuffer (a short fade, no click). */
  stopBuffer(handle = this.bufferPlay) {
    if (!handle || handle.stopped) return;
    handle.stopped = true;
    const t = this.ctx.currentTime;
    handle.gain.gain.setValueAtTime(1, t);
    handle.gain.gain.linearRampToValueAtTime(0, t + 0.01);
    try { handle.src.stop(t + 0.015); } catch { /* ended */ }
  }

  /** Playlist audio clips play through this bus into the master insert (a tap point for render stems). */
  clipBus() {
    if (!this.clipBusNode) {
      this.clipBusNode = this.ctx.createGain();
      this.clipBusNode.connect(this.inserts[0].input);
    }
    return this.clipBusNode;
  }

  /**
   * Play (part of) an audio clip from `time`: `intoTicks` into the clip, stopping at `maxTicks` (loop end).
   * Applies the clip's gain, fades (plus a few ms anti-click ramp at every edge) and playback rate (repitch).
   */
  playAudioClip(clip, time, intoTicks = 0, maxTicks = Infinity) {
    const buf = this.samples.get(clip.refId);
    if (!buf) return;
    const ticksPerSec = (this.bpm / 60) * PPQ;
    const speed = clip.rate > 0 ? clip.rate : 1;
    const offset = ((clip.offset + intoTicks) / ticksPerSec) * speed; // position in the sample (s)
    const endTick = Math.min(clip.length, maxTicks);
    const dur = (endTick - intoTicks) / ticksPerSec; // timeline seconds
    if (offset >= buf.duration || dur <= 0) return;
    const playable = Math.min(dur, (buf.duration - offset) / speed);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = speed;
    const v = new Voice(this.ctx, this.clipBus(), time);
    v.add(src);
    const g = this.ctx.createGain();
    src.connect(g).connect(v.out);
    // gain envelope (timeline seconds): fades clamped to the clip, plus 3 ms anti-click ramps at whatever edges
    // actually play (clip start/end, the loop end, the end of the sample, a start in the middle of the clip)
    const level = clip.gain ?? 1;
    const tps = ticksPerSec;
    const at = (tick) => time + (tick - intoTicks) / tps;
    const fadeIn = Math.min(clip.fadeIn || 0, clip.length);
    const fadeOut = Math.min(clip.fadeOut || 0, clip.length - fadeIn);
    const valueAt = (t) => {
      const fin = fadeIn ? Math.min(1, Math.max(0, (t - at(0)) / (fadeIn / tps))) : 1;
      const fout = fadeOut ? Math.min(1, Math.max(0, (at(clip.length) - t) / (fadeOut / tps))) : 1;
      return level * fin * fout;
    };
    const end = time + playable;
    const edge = Math.min(0.003, playable / 3);
    const gain = g.gain;
    gain.setValueAtTime(0, time);
    // the envelope is piecewise linear between these points, so linear ramps through them reproduce it exactly
    const points = [time + edge, at(fadeIn), at(clip.length - fadeOut), end - edge]
      .filter((t) => t >= time + edge && t <= end - edge)
      .sort((a, b) => a - b);
    for (const t of points) gain.linearRampToValueAtTime(valueAt(t), t);
    gain.linearRampToValueAtTime(0, end);
    src.start(time, offset, playable * speed);
    v.end = time + playable;
    v.channelId = '__audio';
    this.voices.add(v);
    v.onDone = () => this.voices.delete(v);
  }

  /**
   * Disconnect voices that finished before `time`. Offline renders call this between chunks: there,
   * `onended` events arrive late, and finished-but-connected voices keep costing render time.
   */
  reapVoices(time) {
    for (const v of this.voices) if (!v.done && v.end < time - 0.05) v.cleanup();
  }

  killAll(time = this.ctx.currentTime) {
    for (const v of this.voices) v.kill(time);
    this.monoLast.clear();
  }

  click(time, accent) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = accent ? 1760 : 1100;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(1, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    o.connect(g).connect(this.clickOut);
    o.start(time);
    o.stop(time + 0.06);
    return o; // the recorder's count-in stops its clicks when the take is cancelled
  }

  // ------------------------------------------------------------------ automation

  /** Resolve an automation target to { params: AudioParam[], map(v) } or a special handler. */
  resolveTarget(target) {
    if (target.type === 'channel') {
      const s = this.strips.get(target.id);
      const c = getChannel(this.project, target.id);
      if (!s || !c) return null;
      const nyq = this.ctx.sampleRate / 2 - 100;
      // rest(): the value without automation (the channel's own setting)
      switch (target.param) {
        case 'volume': return { key: `channel:${target.id}:volume`, params: [s.vol.gain], map: (v) => (s.audible ? v * 1.25 : 0), rest: () => (s.audible ? c.volume : 0) };
        case 'pan': return { key: `channel:${target.id}:pan`, params: [s.pan.pan], map: (v) => v * 2 - 1, rest: () => c.pan };
        case 'filterCutoff': return { key: `channel:${target.id}:filterCutoff`, params: [s.filter.frequency], map: (v) => Math.min(nyq, 20 * Math.pow(1000, v)), rest: () => Math.min(nyq, c.filterCutoff) };
        case 'filterRes': return { key: `channel:${target.id}:filterRes`, params: [s.filter.Q], map: (v) => 0.1 * Math.pow(200, v), rest: () => c.filterRes };
        case 'pitch': return null; // applied per note in Transport.scheduleRange
        default: return null;
      }
    }
    if (target.type === 'mixer' || target.type === 'master') {
      const idx = target.type === 'master' ? 0 : target.index;
      const ins = this.inserts[idx];
      if (!ins) return null;
      const key = target.type === 'master' ? `master:${target.param}` : `mixer:${idx}:${target.param}`;
      const m = this.project.mixer[idx];
      if (target.param === 'volume') return { key, params: [ins.fader.gain], map: (v) => v * 1.25, rest: () => m.volume };
      if (target.param === 'pan') {
        // a 3D object ignores its pan knob (its x pans it in stereo; 3D rendering pans it in space)
        if (isSpatialObject(this.project, idx)) return null;
        return { key, params: [ins.panner.pan], map: (v) => v * 2 - 1, rest: () => m.pan };
      }
      const sp = SPATIAL_PARAMS[target.param];
      if (sp && idx > 0) {
        if (!isSpatialObject(this.project, idx)) return null;
        const map = (v) => spatialFromNorm(target.param, v);
        const rest = () => m.spatial[sp.axis];
        if (this.rig.routesObjects) return { key, params: this.rig.axisParams(idx, sp.axis), map, rest };
        // stereo monitoring: only left/right is audible, as the pan position
        return sp.axis === 'x' ? { key, params: [ins.panner.pan], map, rest } : null;
      }
      return null;
    }
    if (target.type === 'effect') {
      const ins = this.inserts[target.index];
      const fx = ins?.fx.find((f) => f.id === target.effectId);
      if (!fx) return null;
      const ap = fx.node.automation?.[target.param];
      const def = (fx.type === 'plugin' ? pluginParamDefs(fx.plugin) : EFFECTS[fx.type].params).find((x) => x.key === target.param);
      if (!ap || !def) return null;
      const tf = fx.node.transform?.[target.param];
      const own = () => this.project.mixer[target.index]?.effects.find((e) => e.id === target.effectId)?.params[target.param] ?? def.default;
      return {
        key: `effect:${target.effectId}:${target.param}`, params: Array.isArray(ap) ? ap : [ap],
        map: (v) => { const raw = denormalize(v, def); return tf ? tf(raw) : raw; },
        rest: () => (tf ? tf(own()) : own())
      };
    }
    return null;
  }

  applyAutomation(target, value, time, first) {
    const r = this.resolveTarget(target);
    if (!r) return;
    this.automated.add(r.key);
    const val = r.map(value);
    for (const prm of r.params) {
      if (first) {
        prm.cancelScheduledValues(time);
        prm.setValueAtTime(val, time);
      } else {
        prm.linearRampToValueAtTime(val, time);
      }
    }
  }

  /** Put an automated parameter back to its own (non-automated) value at `time`. */
  restoreStatic(target, time) {
    const r = this.resolveTarget(target);
    if (!r?.rest) return;
    const val = r.rest();
    for (const prm of r.params) {
      prm.cancelScheduledValues(time);
      prm.setValueAtTime(val, time);
    }
    this.automated.delete(r.key);
  }

  endAutomation() {
    if (!this.automated.size) return;
    this.automated.clear();
    // re-apply static values
    for (const s of this.strips.values()) s.channel = null;
    this.soloSig = null;
    for (const ins of this.inserts) {
      ins.anySolo = null;
      for (const f of ins.fx) f.params = null;
    }
    const p = this.project;
    this.project = null;
    this.setProject(p);
  }

  // ------------------------------------------------------------------ meters

  /** Peak level per mixer insert (0..~1.5). */
  getLevels() {
    const buf = this.meterBuf;
    return this.inserts.map((ins) => {
      ins.meter.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
      }
      return peak;
    });
  }

  forEachPump(fn) {
    for (const ins of this.inserts) for (const f of ins.fx) if (f.type === 'pump' && f.enabled) fn(f.node);
  }
}

// ====================================================================== Transport

export class Transport {
  constructor(engine) {
    this.engine = engine;
    this.playing = false;
    this.mode = 'pattern';
    this.patternId = null;
    this.loopRegion = null; // { start, end } ticks (song mode)
    this.anchor = null;
    this.segments = [];
    this.cursorTick = 0;
    this.cursorTime = 0;
    this.timer = null;
    this.onLoop = null;
    this.autoFirst = true;
    this.endTime = null; // offline renders: stop (don't wrap) when reaching this time
    this.finished = false;
  }

  get ctx() { return this.engine.ctx; }
  get project() { return this.engine.project; }
  rate() { return (this.engine.bpm / 60) * PPQ; }

  loopRange() {
    const p = this.project;
    if (this.mode === 'pattern') {
      const pat = p.patterns.find((x) => x.id === this.patternId) || p.patterns[0];
      return { start: 0, end: patternLength(p, pat) };
    }
    if (this.loopRegion && this.loopRegion.end > this.loopRegion.start) return this.loopRegion;
    return { start: 0, end: Math.max(songLength(p), ticksPerBar(p)) };
  }

  timeAt(tick) {
    return this.anchor.time + (tick - this.anchor.tick) / this.anchor.rate;
  }

  syncPoint() {
    const time = this.ctx.currentTime + 0.01;
    return { time, tick: this.positionAt(time), bpm: this.engine.bpm };
  }

  /** at: context time to start at (later than now: the recorder's count-in), default as soon as possible. */
  play({ mode = 'pattern', patternId = null, position = 0, at = 0 } = {}) {
    if (this.playing) this.stop();
    this.mode = mode;
    this.patternId = patternId;
    const t0 = Math.max(this.ctx.currentTime + 0.06, at);
    const { start, end } = this.loopRange();
    const pos = position >= end || position < start ? start : position;
    this.anchor = { time: t0, tick: pos, rate: this.rate() };
    this.segments = [this.anchor];
    this.cursorTick = pos;
    this.cursorTime = t0;
    this.playing = true;
    this.autoFirst = true;
    this.endTime = null;
    this.finished = false;
    if (mode === 'song') {
      const loopEnd = this.loopRange().end;
      for (const clip of songAudioCovering(this.project, pos)) this.engine.playAudioClip(clip, t0, pos - clip.start, loopEnd - clip.start);
    }
    this.engine.forEachPump((n) => n.sync({ time: t0, tick: pos, bpm: this.engine.bpm }));
    this.schedule();
    if (this.engine.realtime) {
      // background tabs throttle timers to ~1s, so look further ahead while hidden
      this.timer = setInterval(() => this.schedule(this.ctx.currentTime + (globalThis.document?.hidden ? 1.5 : LOOKAHEAD)), INTERVAL);
    }
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    this.timer = null;
    this.engine.killAll();
    this.engine.forEachPump((n) => n.stopSync());
    this.engine.endAutomation();
  }

  onTempoChange() {
    if (!this.playing) return;
    // re-anchor at the scheduling cursor so already-queued events stay valid
    this.anchor = { time: this.cursorTime, tick: this.cursorTick, rate: this.rate() };
    this.segments.push(this.anchor);
    const sp = { time: this.cursorTime, tick: this.cursorTick, bpm: this.engine.bpm };
    this.engine.forEachPump((n) => n.sync(sp));
  }

  /** Current song/pattern position in ticks for the UI. */
  positionAt(time = this.ctx.currentTime) {
    if (!this.playing || !this.segments.length) return null;
    let seg = this.segments[0];
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (this.segments[i].time <= time) { seg = this.segments[i]; break; }
    }
    // drop segments that are long past
    while (this.segments.length > 2 && this.segments[1].time < time - 1) this.segments.shift();
    return Math.max(seg.tick, seg.tick + (time - seg.time) * seg.rate);
  }

  schedule(horizon = this.ctx.currentTime + LOOKAHEAD) {
    if (!this.playing || !this.project || this.finished) return;
    for (let guard = 0; guard < 256; guard++) {
      const { start, end } = this.loopRange();
      if (this.cursorTick >= end || this.cursorTick < start) {
        // pattern got shorter (or loop moved) under the cursor: wrap now
        this.wrap(start, this.cursorTime);
        continue;
      }
      const horizonTick = this.anchor.tick + (horizon - this.anchor.time) * this.anchor.rate;
      const toTick = Math.min(horizonTick, end);
      if (toTick > this.cursorTick) this.scheduleRange(this.cursorTick, toTick);
      if (horizonTick >= end) {
        const wrapTime = this.timeAt(end);
        if (this.endTime !== null && wrapTime >= this.endTime - 1e-4) {
          // offline render reached its end: don't loop back (would retrigger audio clips in the tail)
          this.cursorTick = end;
          this.cursorTime = wrapTime;
          this.finished = true;
          return;
        }
        this.wrap(start, wrapTime);
      } else {
        // never move the cursor backwards (e.g. when the lookahead shrinks after a hidden tab becomes visible)
        if (toTick > this.cursorTick) {
          this.cursorTick = toTick;
          this.cursorTime = horizon;
        }
        return;
      }
    }
  }

  wrap(startTick, time) {
    // audio clips that run past the loop end must stop at the wrap point
    for (const v of this.engine.voices) if (v.channelId === '__audio') v.kill(time);
    this.anchor = { time, tick: startTick, rate: this.rate() };
    this.segments.push(this.anchor);
    this.cursorTick = startTick;
    this.cursorTime = time;
    this.autoFirst = true;
    this.engine.forEachPump((n) => n.sync({ time, tick: startTick, bpm: this.engine.bpm }));
    if (this.mode === 'song') {
      const loopEnd = this.loopRange().end;
      for (const clip of songAudioCovering(this.project, startTick)) this.engine.playAudioClip(clip, time, startTick - clip.start, loopEnd - clip.start);
    }
    this.onLoop?.(time);
  }

  scheduleRange(from, to) {
    const p = this.project;
    const eng = this.engine;
    const now = this.ctx.currentTime;
    const swing = p.swing;
    let notes;
    if (this.mode === 'pattern') {
      const pat = p.patterns.find((x) => x.id === this.patternId) || p.patterns[0];
      notes = pat ? patternNotesInRange(pat, from, to) : [];
    } else {
      notes = songNotesInRange(p, from, to);
    }
    notes.sort((a, b) => a.start - b.start);
    // automation first so notes see the right volume/filter
    const pitchAutos = [];
    if (this.mode === 'song' && this.autoFirst) this.chaseAutomation(from, now);
    if (this.mode === 'song') {
      for (const { clip, automation } of songAutomationInRange(p, from, to)) {
        if (automation.target.type === 'channel' && automation.target.param === 'pitch') {
          pitchAutos.push({ clip, automation });
          continue;
        }
        const a0 = Math.max(from, clip.start);
        const a1 = Math.min(to, clip.start + clip.length);
        // a clip that begins inside this range starts fresh (jump to its first value, don't ramp into it)
        let first = this.autoFirst || from <= clip.start;
        // sample the curve on a fixed 1/32 grid inside the clip (end exclusive: the value at the end
        // of a looping clip would wrap back to its first point)
        let t = clip.start + Math.ceil((a0 - clip.start) / AUTOMATION_STEP) * AUTOMATION_STEP;
        if (first || t > a0) {
          eng.applyAutomation(automation.target, automationValueAt(automation, a0 - clip.start + clip.offset), Math.max(now, this.timeAt(a0)), first);
          first = false;
        }
        for (; t < a1; t += AUTOMATION_STEP) {
          eng.applyAutomation(automation.target, automationValueAt(automation, t - clip.start + clip.offset), Math.max(now, this.timeAt(t)), first);
          first = false;
        }
      }
      this.autoFirst = false;
      const loopEnd = this.loopRange().end;
      for (const clip of songAudioInRange(p, from, to)) eng.playAudioClip(clip, Math.max(now, this.timeAt(clip.start)), 0, loopEnd - clip.start);
    }
    const chans = new Map(p.channels.map((c) => [c.id, c]));
    for (const n of notes) {
      const ch = chans.get(n.channelId);
      // groove: the channel's share of the project swing, then its nudge (ms early/late)
      const swung = this.timeAt(n.start + swingTicks(n.local ?? n.start, swing * (ch?.swingMix ?? 1)));
      const time = swung + (ch?.nudge || 0) / 1000;
      if (time < now - 0.005 - Math.max(0, -(ch?.nudge || 0)) / 1000) continue;
      let pitch = 0;
      for (const { clip, automation } of pitchAutos) {
        if (automation.target.id === n.channelId && n.start >= clip.start && n.start < clip.start + clip.length) {
          pitch = Math.round(automationValueAt(automation, n.start - clip.start + clip.offset) * 48 - 24);
        }
      }
      eng.triggerNote(n.channelId, n.key, n.velocity, Math.max(time, now), n.length / this.anchor.rate, { pan: n.pan, pitch });
    }
    if (eng.metronome && this.engine.realtime) {
      const firstBeat = Math.ceil(from / PPQ) * PPQ;
      const bar = ticksPerBar(p);
      for (let b = firstBeat; b < to; b += PPQ) {
        const time = this.timeAt(b);
        if (time >= now) eng.click(time, b % bar === 0);
      }
    }
  }

  /**
   * On play/loop: every automated parameter not covered by a clip at `from` takes the value the most recent clip
   * left it at — or its own setting when no clip came before — so what you hear doesn't depend on where you started.
   */
  chaseAutomation(from, now) {
    const p = this.project;
    const byTarget = new Map();
    for (const clip of p.playlist.clips) {
      if (clip.kind !== 'automation' || clip.mute || p.playlist.tracks[clip.track]?.mute) continue;
      const a = p.automations.find((x) => x.id === clip.refId);
      if (!a || (a.target.type === 'channel' && a.target.param === 'pitch')) continue;
      const key = JSON.stringify(a.target);
      if (!byTarget.has(key)) byTarget.set(key, []);
      byTarget.get(key).push({ clip, a });
    }
    const time = Math.max(now, this.timeAt(from));
    for (const list of byTarget.values()) {
      if (list.some(({ clip }) => clip.start <= from && clip.start + clip.length > from)) continue; // scheduled below
      let last = null;
      for (const x of list) if (x.clip.start + x.clip.length <= from && (!last || x.clip.start + x.clip.length > last.clip.start + last.clip.length)) last = x;
      if (last) this.engine.applyAutomation(last.a.target, automationValueAt(last.a, last.clip.length - 1 + last.clip.offset), time, true);
      else this.engine.restoreStatic(list[0].a.target, time);
    }
  }

  /** Offline: prepare to render `totalTicks` worth of playback from 0 (with looping). Returns the end time. */
  startOffline(mode, patternId, totalTicks, startTime = 0.02) {
    this.mode = mode;
    this.patternId = patternId;
    this.playing = true;
    this.finished = false;
    this.anchor = { time: startTime, tick: 0, rate: this.rate() };
    this.segments = [this.anchor];
    this.cursorTick = 0;
    this.cursorTime = startTime;
    this.autoFirst = true;
    this.engine.forEachPump((n) => n.sync({ time: startTime, tick: 0, bpm: this.engine.bpm }));
    this.endTime = startTime + totalTicks / this.anchor.rate;
    return this.endTime;
  }

  /** Offline: schedule everything up front (fallback when OfflineAudioContext.suspend is unavailable). */
  scheduleAll(mode, patternId, totalTicks, startTime = 0.02) {
    const endTime = this.startOffline(mode, patternId, totalTicks, startTime);
    for (let h = startTime; h < endTime + 1; h += 1) this.schedule(Math.min(h + 1, endTime));
    this.playing = false;
    return endTime;
  }
}

