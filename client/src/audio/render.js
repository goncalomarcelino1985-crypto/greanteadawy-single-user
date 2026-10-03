// Offline (faster than realtime) rendering of the song or a pattern, optionally metering stems in the same pass.
import { patternLength, songLength, ticksPerBar, PPQ, encodeWav, createLevelMeter, SPEAKER_LAYOUTS } from '@greanteadawy/core';
import { AudioEngine } from './engine.js';
import { LIMITER_HEADROOM } from './effects.js';
import { preparePlugins } from './plugins.js';

const TAP_SIZE = 32768; // AnalyserNode history (max fftSize) — must exceed one chunk

/**
 * opts: {
 *   mode: 'song' | 'pattern', patternId, loops (pattern mode), tail (s), sampleRate, samples (Map of decoded buffers),
 *   bitDepth, encode (default true), onProgress(0..1),
 *   stems: [{ channelId, name } | { name, audioClips: true }]   meter these in the same pass (see below)
 * }
 * Returns { blob, seconds, buffer, stems, limiter }. `stems` holds level/loudness/spectrum stats per requested stem, or
 * null when stems weren't requested or the browser can't meter during an offline render (no OfflineAudioContext.suspend).
 * `limiter` ({ avgDb, maxDb, activePercent }, with opts.meterLimiter) is the master limiter's gain reduction: peaks
 * after vs before it, compared in latency-aligned ~90 ms windows across the whole render; null when not measured.
 *
 * Stems are measured after the channel's own mixer insert (its FX, fader and pan) when the channel is the only
 * thing feeding that insert, otherwise right after the channel strip (volume/pan) — always before the master bus.
 */
export async function renderProject(project, opts = {}) {
  const { mode = 'song', patternId, loops = 4, tail = 2, sampleRate = 44100, samples = new Map(), bitDepth = 16, ditherSeed = 0, onProgress, encode = true } = opts;
  const songMode = mode === 'song' && songLength(project) > 0;
  let ticks;
  if (songMode) {
    ticks = songLength(project);
  } else {
    const pat = project.patterns.find((p) => p.id === patternId) || project.patterns[0];
    ticks = patternLength(project, pat) * loops;
  }
  ticks = Math.max(ticks, ticksPerBar(project));
  const seconds = (ticks / PPQ) * (60 / project.bpm) + tail;
  // spatial renders: binaural stereo, a speaker layout (5.1/7.1/7.1.4) or bed + one channel per object
  const sp = opts.spatial || null;
  const outChannels = !sp || sp.mode === 'binaural' ? 2 : sp.mode === 'speakers' ? SPEAKER_LAYOUTS[sp.layout].speakers.length : 2 + sp.objectOrder.length;
  const ctx = new OfflineAudioContext(outChannels, Math.ceil(seconds * sampleRate), sampleRate);
  const eng = new AudioEngine(ctx, { realtime: false, spatial: sp });
  eng.samples = samples;
  eng.setProject(project);
  await Promise.all([eng.loadNeededSamples(project), eng.prewarmModels(project), preparePlugins(ctx, project)]);
  const transport = eng.transport;
  const playMode = songMode ? 'song' : 'pattern';
  const chunked = typeof ctx.suspend === 'function';
  const taps = chunked && opts.stems?.length ? attachStemTaps(eng, ctx, opts.stems) : null;
  let collect = () => {};
  // how hard the master limiter works: tells Claude whether the loudness came from squashing
  const limiterFx = eng.inserts[0]?.fx.find((f) => f.type === 'limiter' && f.enabled);
  const grMeter = chunked && opts.meterLimiter && limiterFx ? attachLimiterMeter(ctx, limiterFx.node, limiterFx.params?.ceiling ?? -1) : null;

  if (chunked) {
    // Schedule a little ahead, then pause the render every `chunk` seconds to drop finished voices, read the
    // stem taps and schedule more. Keeps the audio graph small, so long songs render several times faster
    // than with every note scheduled up front.
    const chunk = taps || grMeter ? Math.min(0.5, (0.7 * TAP_SIZE) / sampleRate) : 1;
    collect = taps ? stemCollector(taps) : collect;
    const endTime = transport.startOffline(playMode, patternId, ticks);
    transport.schedule(Math.min(endTime, chunk * 2));
    let lastReport = 0;
    for (let t = chunk; t < seconds - 0.05; t += chunk) {
      ctx.suspend(t).then(() => {
        collect(Math.round(ctx.currentTime * sampleRate));
        grMeter?.collect(Math.round(ctx.currentTime * sampleRate));
        eng.reapVoices(t);
        transport.schedule(Math.min(endTime, t + chunk * 2));
        if (t / seconds - lastReport >= 0.05) {
          lastReport = t / seconds;
          onProgress?.(Math.min(0.95, lastReport));
        }
        return ctx.resume();
      }).catch((e) => {
        console.error('render chunk failed', e);
        ctx.resume().catch(() => {});
      });
    }
  } else {
    transport.scheduleAll(playMode, patternId, ticks);
  }
  onProgress?.(0.02);
  const buffer = await ctx.startRendering();
  transport.playing = false;
  collect(buffer.length, true);
  grMeter?.collect(buffer.length, true);
  onProgress?.(1);
  const stems = taps ? taps.map(({ an: _an, meter, ...stem }) => ({ ...stem, ...meter.result() })) : null;
  const limiter = grMeter ? grMeter.result() : null;
  if (!encode) return { blob: null, seconds, buffer, stems, limiter };
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const mask = sp?.mode === 'speakers' ? SPEAKER_LAYOUTS[sp.layout].mask : undefined;
  const blob = new Blob([encodeWav(channels, buffer.sampleRate, { bitDepth, seed: ditherSeed, channelMask: mask })], { type: 'audio/wav' });
  return { blob, seconds, buffer, stems, limiter };
}

/**
 * Gain reduction of a limiter: peak level after vs before it in 4096-sample windows, the "after" side shifted by the
 * compressor's look-ahead. Windows quieter than its threshold (ceiling - LIMITER_HEADROOM) can't be limited and are
 * skipped; "max" is the 2nd percentile (the deepest reduction that isn't a one-window artifact).
 */
function attachLimiterMeter(ctx, node, ceilingDb) {
  // left and right separately: the compressor's detector is linked (max of both sides), a mono sum would hide
  // one-sided peaks
  const tap = (src) => {
    const split = ctx.createChannelSplitter(2);
    src.connect(split);
    return [0, 1].map((i) => {
      const a = ctx.createAnalyser();
      a.fftSize = TAP_SIZE;
      a.smoothingTimeConstant = 0;
      split.connect(a, i);
      return a;
    });
  };
  const pre = tap(node.input); // after the limiter's input gain
  const post = tap(node.output);
  const lat = Math.floor(0.006 * ctx.sampleRate); // the browsers truncate the look-ahead to whole frames
  const W = 4096;
  const [AL, AR, BL, BR] = [0, 1, 2, 3].map(() => new Float32Array(TAP_SIZE));
  const threshold = Math.pow(10, (ceilingDb - LIMITER_HEADROOM) / 20);
  const reductions = [];
  const quiet = []; // gain of windows well below the threshold: the limiter's static gain, subtracted as a baseline
  let windows = 0;
  let next = 0; // absolute frame where the next window starts
  return {
    collect(frame, final = false) {
      // the analysers hold the TAP_SIZE frames ending at the last rendered quantum
      const end = final ? Math.ceil(frame / 128) * 128 : frame;
      pre[0].getFloatTimeDomainData(AL);
      pre[1].getFloatTimeDomainData(AR);
      post[0].getFloatTimeDomainData(BL);
      post[1].getFloatTimeDomainData(BR);
      for (; next + lat + W + 128 <= frame; next += W) {
        const k = next - (end - TAP_SIZE);
        if (k < 0) continue; // fell out of the analyser history (shouldn't happen with ≤ 0.7·TAP_SIZE chunks)
        let pk = 0;
        let qk = 0;
        for (let i = 0; i < W; i++) {
          const a = Math.max(Math.abs(AL[k + i]), Math.abs(AR[k + i]));
          if (a > pk) pk = a;
        }
        // the output window is widened a little: a transient right at a window edge must not look like 20 dB of
        // reduction just because the look-ahead moved it into the next window
        const slack = 128;
        for (let i = Math.max(0, k + lat - slack); i < Math.min(TAP_SIZE, k + lat + W + slack); i++) {
          const b = Math.max(Math.abs(BL[i]), Math.abs(BR[i]));
          if (b > qk) qk = b;
        }
        windows++;
        const db = 20 * Math.log10(Math.max(qk, 1e-9) / Math.max(pk, 1e-9));
        if (pk >= threshold) reductions.push(db);
        else if (pk >= threshold / 4 && pk < threshold / 2) quiet.push(db);
      }
    },
    result() {
      if (!windows) return null;
      const sorted = [...quiet].sort((a, b) => a - b);
      // without enough quiet windows, the least-reduced loud window is the best estimate of the static gain
      const base = sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)]
        : reductions.length ? Math.max(-1, Math.min(0, Math.max(...reductions))) : 0;
      const gr = reductions.map((g) => Math.min(0, g - base));
      const active = gr.filter((g) => g < -0.2);
      const r1 = (x) => Math.round(x * 10) / 10;
      // "max" = the 2nd percentile: the deepest reduction that isn't a one-window measuring artifact
      const deepest = [...gr].sort((a, b) => a - b)[Math.floor(gr.length * 0.02)] ?? 0;
      return {
        avgDb: active.length ? r1(active.reduce((a, b) => a + b, 0) / active.length) : 0,
        maxDb: r1(Math.min(0, deepest)),
        activePercent: Math.round((active.length / windows) * 100)
      };
    }
  };
}

/** Hang a stereo AnalyserNode pair off each stem's tap point. */
function attachStemTaps(eng, ctx, stems) {
  const project = eng.project;
  const channelsPerInsert = new Map();
  for (const c of project.channels) channelsPerInsert.set(c.mixerTrack, (channelsPerInsert.get(c.mixerTrack) || 0) + 1);
  const fedByInserts = new Set();
  project.mixer.forEach((m, i) => {
    if (i === 0) return;
    fedByInserts.add(m.output || 0);
    for (const s of m.sends || []) fedByInserts.add(s.to);
  });
  const taps = [];
  for (const stem of stems) {
    let node = null;
    let tap = 'channel';
    if (stem.audioClips) {
      node = eng.clipBus();
      tap = 'audio clips';
    } else {
      const ch = project.channels.find((c) => c.id === stem.channelId);
      const strip = ch && eng.strips.get(ch.id);
      if (!strip) continue;
      const ins = Math.min(ch.mixerTrack, eng.inserts.length - 1);
      if (ins > 0 && channelsPerInsert.get(ch.mixerTrack) === 1 && !fedByInserts.has(ins)) {
        node = eng.inserts[ins].post;
        tap = 'insert';
      } else {
        node = strip.pan;
      }
    }
    // force stereo so mono sources (e.g. mono samples) land on both analysers
    const up = ctx.createGain();
    up.channelCount = 2;
    up.channelCountMode = 'explicit';
    up.channelInterpretation = 'speakers';
    const split = ctx.createChannelSplitter(2);
    node.connect(up);
    up.connect(split);
    const an = [0, 1].map((i) => {
      const a = ctx.createAnalyser();
      a.fftSize = TAP_SIZE;
      a.smoothingTimeConstant = 0;
      split.connect(a, i);
      return a;
    });
    taps.push({ ...stem, tap, an, meter: createLevelMeter(ctx.sampleRate) });
  }
  return taps;
}

/** Returns collect(frame, final): feeds the samples rendered since the previous call into each stem's meter. */
function stemCollector(taps) {
  const L = new Float32Array(TAP_SIZE);
  const R = new Float32Array(TAP_SIZE);
  let prev = 0;
  return (frame, final = false) => {
    // the last render quantum is always rendered whole, so the analysers may hold a few frames past the end
    const extra = final ? Math.ceil(frame / 128) * 128 - frame : 0;
    const n = Math.min(frame - prev, TAP_SIZE - extra);
    if (n <= 0) return;
    const from = TAP_SIZE - extra - n;
    for (const t of taps) {
      t.an[0].getFloatTimeDomainData(L);
      t.an[1].getFloatTimeDomainData(R);
      t.meter.push([L.subarray(from, from + n), R.subarray(from, from + n)]);
    }
    prev = frame;
  };
}
