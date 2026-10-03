// Microphone capture for the recorder window: an input stream in the studio's audio context, a level meter, optional
// monitoring, and sample-accurate capture through an AudioWorklet (public/recorder-worklet.js).
import { useStore } from '../state/store.js';
import { api } from '../state/api.js';

/** Why recording can't work in this browser/page, or null. */
export function recordingSupport() {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'Recording needs a secure page: open the studio over https:// (or as http://localhost on the computer that runs it). Browsers only allow the microphone there.';
  }
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser cannot record audio.';
  if (typeof AudioWorkletNode === 'undefined') return 'This browser cannot record audio (no AudioWorklet support).';
  return null;
}

/** A readable message for a getUserMedia failure. */
export function micErrorMessage(e) {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was blocked. Allow the microphone for this site (the icon in the address bar), then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Connect one, or pick another input, and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy or unavailable — another app may be using it.';
    default:
      return e?.message || String(e);
  }
}

/** Audio inputs ({ deviceId, label }); labels are empty until the user has allowed the microphone once. */
export async function listInputs() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Input ${i + 1}` }));
  } catch {
    return [];
  }
}

const workletLoaded = new WeakMap();

export class MicSession {
  /** Ask for the microphone and wire it into `ctx`. opts: deviceId, channels (1|2), echoCancellation, noiseSuppression, autoGainControl. */
  static async open(ctx, { deviceId = '', channels = 1, echoCancellation = false, noiseSuppression = false, autoGainControl = false } = {}) {
    const audio = { channelCount: { ideal: channels }, echoCancellation, noiseSuppression, autoGainControl };
    if (deviceId) audio.deviceId = { exact: deviceId };
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    try {
      if (!workletLoaded.has(ctx)) workletLoaded.set(ctx, ctx.audioWorklet.addModule('/recorder-worklet.js'));
      await workletLoaded.get(ctx);
    } catch (e) {
      workletLoaded.delete(ctx);
      for (const t of stream.getTracks()) t.stop();
      throw e;
    }
    return new MicSession(ctx, stream, channels);
  }

  constructor(ctx, stream, channels) {
    this.ctx = ctx;
    this.stream = stream;
    this.channels = channels;
    const track = stream.getAudioTracks()[0];
    this.label = track?.label || 'Microphone';
    this.settings = track?.getSettings?.() || {};
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.meterBuf = new Float32Array(this.analyser.fftSize);
    this.node = new AudioWorkletNode(ctx, 'gtd-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: channels, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    // a silent path to the output keeps the worklet running in every browser
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;
    this.source.connect(this.analyser);
    this.source.connect(this.node);
    this.node.connect(this.sink).connect(ctx.destination);
    this.source.connect(this.monitor).connect(ctx.destination);
    this.chunks = [];
    this.waiting = null;
    this.node.port.onmessage = (e) => {
      if (e.data.done) { this.waiting?.(); this.waiting = null; return; }
      this.chunks.push(e.data);
    };
    this.recording = false;
  }

  /** The browser's estimate of the input latency (seconds), 0 when it doesn't say. */
  get inputLatency() {
    return Number.isFinite(this.settings.latency) ? this.settings.latency : 0;
  }

  /** Hear the input through the speakers/headphones. */
  setMonitor(on) {
    this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  /** Peak level of the last ~40 ms (0..1). */
  peak() {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let p = 0;
    for (const v of this.meterBuf) { const a = Math.abs(v); if (a > p) p = a; }
    return p;
  }

  start() {
    this.chunks = [];
    this.recording = true;
    this.startedAt = this.ctx.currentTime;
    this.node.port.postMessage('start');
  }

  /** Seconds captured so far. */
  get elapsed() {
    return this.recording ? this.ctx.currentTime - this.startedAt : 0;
  }

  /**
   * Stop and return the take: { sampleRate, channels, startTime } — startTime is the audio-context time of its first
   * frame. Blocks are placed by the frame they were captured at, so a dropout becomes silence, not a time shift.
   */
  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    await new Promise((resolve) => {
      this.waiting = resolve;
      this.node.port.postMessage('stop');
      setTimeout(resolve, 1000); // the worklet answers within a block; don't hang if the context was suspended
    });
    const chunks = this.chunks;
    this.chunks = [];
    if (!chunks.length) return null;
    const first = chunks[0].frame;
    const last = chunks[chunks.length - 1];
    const total = last.frame + last.data[0].length - first;
    const nch = Math.max(...chunks.map((c) => c.data.length));
    const out = Array.from({ length: nch }, () => new Float32Array(total));
    for (const c of chunks) for (let ch = 0; ch < nch; ch++) out[ch].set(c.data[Math.min(ch, c.data.length - 1)], c.frame - first);
    return { sampleRate: this.ctx.sampleRate, channels: out, startTime: first / this.ctx.sampleRate };
  }

  close() {
    this.recording = false;
    try { this.node.port.postMessage('close'); } catch { /* already gone */ }
    for (const t of this.stream.getTracks()) t.stop();
    for (const n of [this.source, this.node, this.sink, this.monitor, this.analyser]) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
  }
}

/** The user's "Recordings" folder (created on first use). */
export async function recordingsFolder() {
  const st = useStore.getState();
  const find = () => useStore.getState().sampleFolders.find((f) => f.name.toLowerCase() === 'recordings');
  let f = find();
  if (f) return f;
  try {
    f = await api.createSampleFolder('Recordings');
  } catch (e) {
    if (e.status !== 409) throw e;
  }
  await st.refreshSamples();
  return find() || f;
}

/** A playlist track for an audio clip over [start, end): an empty or audio-only track that is free there, else any free track, else a new one. */
export function freeTrackFor(project, start, end) {
  const { tracks, clips } = project.playlist;
  const busy = (t) => clips.some((c) => c.track === t && c.start < end && c.start + c.length > start);
  const audioOnly = (t) => clips.every((c) => c.track !== t || c.kind === 'audio');
  for (let t = 0; t < tracks.length; t++) if (audioOnly(t) && !busy(t)) return t;
  for (let t = 0; t < tracks.length; t++) if (!busy(t)) return t;
  return tracks.length;
}
