// Jobs the server asks the browser to run with its audio engine:
//   render          offline mixdown (+ per-channel stems) with loudness/spectrum analysis (MCP render_mix)
//   analyze-sample  decode + analyse an uploaded sample (formats the server can't decode)
//   sound           render one note of one channel and measure it (MCP analyze_sound)
//   export-stems    render every channel on its own and upload each as a WAV (MCP export_stems, File menu)
//   spatial         binaural / 5.1 / 7.1 / 7.1.4 / object stems / ADM BWF renders of the 3D mix (lib/spatialExport.js)
//   generator       run a generator plugin in the sandboxed iframe and return its notes (MCP run_generator)
import { analyzeAudio, envelopeTimes, encodeWav, ticksPerBar, PPQ, STEP, songNotesInRange, songLength, INSTRUMENTS } from '@greanteadawy/core';
import { renderProject } from '../audio/render.js';
import { preparePlugins } from '../audio/plugins.js';
import { AudioEngine, sampleFileUrl, sampleRev } from '../audio/engine.js';
import { getEngine } from '../audio/index.js';
import { api } from '../state/api.js';
import { useStore } from '../state/store.js';
import { exportSpatial } from './spatialExport.js';
import { runInSandbox } from './sandbox.js';
import { runSampleEditJob } from './audioEdit.js';

const MAX_STEMS = 24;

export async function runJob(jobId, job, sync) {
  const st = useStore.getState();
  try {
    if (job.kind === 'render') {
      useStore.setState({ busy: 'Claude is rendering the mix…' });
      await renderJob(jobId, job, sync);
    } else if (job.kind === 'sound') {
      const fd = new FormData();
      fd.append('result', JSON.stringify(await soundJob(job)));
      await api.jobResult(jobId, fd);
    } else if (job.kind === 'export-stems') {
      useStore.setState({ busy: 'Exporting stems…' });
      await exportStems(job, { jobId, sync });
    } else if (job.kind === 'spatial') {
      useStore.setState({ busy: `Rendering the spatial mix (${job.format})…` });
      const r = await exportSpatial(job, { jobId, sync });
      st.toast(`Spatial export (${job.format}): ${r.files.length} file(s) in Projects → Exports`, 'claude');
    } else if (job.kind === 'generator') {
      const code = await api.pluginCode(job.plugin);
      const r = await runInSandbox(code, job.input, { timeoutMs: 2000 });
      const fd = new FormData();
      fd.append('result', JSON.stringify({ ok: r.ok, error: r.error || null, notes: r.ok ? r.notes : null }));
      await api.jobResult(jobId, fd);
      if (r.ok) st.toast(`Claude ran the ${job.plugin} generator`, 'claude', 1800);
    } else if (job.kind === 'sample-edit') {
      const fd = new FormData();
      fd.append('result', JSON.stringify(await runSampleEditJob(job)));
      await api.jobResult(jobId, fd);
    } else if (job.kind === 'analyze-sample') {
      await st.refreshSamples(); // current revisions: the sample may have just been replaced
      const analysis = await analyzeSampleInBrowser(job.sampleId);
      const fd = new FormData();
      fd.append('result', JSON.stringify({ analysis }));
      await api.jobResult(jobId, fd);
    } else {
      throw new Error(`Unknown job "${job.kind}"`);
    }
  } catch (e) {
    console.error('job failed', e);
    sync.send({ type: 'job-error', jobId, message: e.message || String(e) });
    st.toast(`Render/analysis failed: ${e.message}`, 'error');
  } finally {
    if (job.kind === 'render' || job.kind === 'export-stems' || job.kind === 'spatial') useStore.setState({ busy: null });
  }
}

/** Channels that actually produce notes in what is being rendered. */
function activeChannels(project, mode, patternId) {
  const ids = new Set();
  if (mode === 'song' && songLength(project) > 0) {
    for (const n of songNotesInRange(project, 0, songLength(project) + 1)) ids.add(n.channelId);
  } else {
    const pat = project.patterns.find((p) => p.id === patternId) || project.patterns[0];
    for (const [cid, list] of Object.entries(pat?.notes || {})) if (list.length) ids.add(cid);
  }
  return project.channels.filter((c) => ids.has(c.id) && !c.mute);
}

async function renderJob(jobId, job, sync) {
  const st = useStore.getState();
  const current = st.project?.id === job.projectId ? st.project : await api.getProject(job.projectId);
  // Claude hears the whole mix: a solo the user left on in the studio would silence everything else
  const project = {
    ...current,
    channels: current.channels.map((c) => (c.solo ? { ...c, solo: false } : c)),
    mixer: current.mixer.map((m) => (m.solo ? { ...m, solo: false } : m))
  };
  const mode = job.mode === 'song' && songLength(project) > 0 ? 'song' : 'pattern';
  const samples = getEngine()?.samples || new Map();
  const opts = { mode, patternId: job.patternId, loops: job.loops || 2, tail: 1.5, samples, encode: false, meterLimiter: true };
  st.toast('Claude is rendering and analysing the mix…', 'claude', 2500);

  const wanted = [];
  if (job.stems) {
    for (const ch of activeChannels(project, mode, job.patternId).slice(0, MAX_STEMS)) wanted.push({ channelId: ch.id, name: ch.name, mixerTrack: ch.mixerTrack });
    if (mode === 'song' && project.playlist.clips.some((c) => c.kind === 'audio')) wanted.push({ name: 'Audio clips', audioClips: true });
  }
  const progress = (p) => sync.send({ type: 'job-progress', jobId, progress: Math.round(p * 100) / 100 });
  const { buffer, stems: metered, limiter } = await renderProject(project, { ...opts, stems: wanted, onProgress: (p) => progress(p * 0.85) });
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const barSec = (ticksPerBar(project) / PPQ) * (60 / project.bpm);
  const segBars = job.segmentBars || 4;
  const mix = analyzeAudio({ channels, sampleRate: buffer.sampleRate }, { segmentSeconds: barSec * segBars, segmentLabel: `${segBars} bars` });
  progress(0.95);
  const stems = metered || (wanted.length ? await soloStems(project, wanted, opts) : []);

  const fd = new FormData();
  fd.append('result', JSON.stringify({ mix, stems: stems.map(stemSummary), limiter, renderedSeconds: buffer.duration, mode, bpm: project.bpm }));
  fd.append('name', project.name);
  if (job.save) fd.append('file', new Blob([encodeWav(channels, buffer.sampleRate, { bitDepth: job.bitDepth === 16 ? 16 : 24 })], { type: 'audio/wav' }), 'mix.wav');
  await api.jobResult(jobId, fd);
  if (job.save) useStore.setState((s) => ({ exportsRev: s.exportsRev + 1 }));
  st.toast(`Mix analysed: ${mix.lufs} LUFS, peak ${mix.peakDb} dBFS`, 'claude');
}

function stemSummary(s) {
  return {
    channelId: s.channelId, name: s.name, mixerTrack: s.mixerTrack, tap: s.tap,
    lufs: s.lufs, peakDb: s.peakDb, rmsDb: s.rmsDb, crestDb: s.crestDb, centroidHz: s.centroidHz,
    bandsPercent: s.bandsPercent, stereoWidth: s.stereoWidth ?? null,
    lowPeakHz: s.lowPeakHz ?? null, lowPeakNote: s.lowPeakNote ?? null, lowWidth: s.lowWidth ?? null
  };
}

/** Fallback for browsers that can't meter during an offline render: render each stem on its own. */
async function soloStems(project, wanted, opts) {
  const out = [];
  const analyse = (b) => analyzeAudio({ channels: Array.from({ length: b.numberOfChannels }, (_, k) => b.getChannelData(k)), sampleRate: b.sampleRate }, { lite: true });
  for (const w of wanted) {
    const unsoloed = { ...project, mixer: project.mixer.map((m) => ({ ...m, solo: false })) };
    const solo = w.audioClips
      ? { ...unsoloed, channels: project.channels.map((c) => ({ ...c, mute: true, solo: false })) }
      : {
          ...unsoloed,
          channels: project.channels.map((c) => ({ ...c, solo: false, mute: c.id !== w.channelId })),
          playlist: { ...project.playlist, clips: project.playlist.clips.filter((c) => c.kind !== 'audio') }
        };
    const { buffer } = await renderProject(solo, { ...opts, tail: 1, meterLimiter: false });
    const a = analyse(buffer);
    out.push({
      ...w, tap: 'solo render', lufs: a.lufs, peakDb: a.peakDb, rmsDb: a.rmsDb, crestDb: a.crestDb, centroidHz: a.spectrum.centroidHz,
      bandsPercent: a.spectrum.bandsPercent, stereoWidth: a.stereo?.width ?? null,
      lowPeakHz: a.spectrum.lowPeakHz, lowPeakNote: a.spectrum.lowPeakNote, lowWidth: a.stereo?.lowWidth ?? null
    });
  }
  return out;
}

/**
 * Render one note of one channel offline and measure it: pitch, level, spectrum, low-end note, envelope.
 * through = 'channel' (instrument + channel strip, the default) or 'insert' (also its mixer insert and effects).
 */
async function soundJob(job) {
  const st = useStore.getState();
  const project = st.project?.id === job.projectId ? st.project : await api.getProject(job.projectId);
  const ch = project.channels.find((c) => c.id === job.channelId);
  if (!ch) throw new Error('Channel not found');
  const viaInsert = job.through === 'insert' && ch.mixerTrack > 0;
  const master = { ...project.mixer[0], effects: [], volume: 1, pan: 0, mute: false, solo: false };
  const solo = {
    ...project,
    channels: [{ ...ch, mute: false, solo: false, mixerTrack: viaInsert ? ch.mixerTrack : 0 }],
    // insert solo would mute everything else in the engine: clear it everywhere
    mixer: project.mixer.map((m, i) => (i === 0 ? master : i === ch.mixerTrack && viaInsert ? { ...m, output: 0, sends: [], mute: false, solo: false } : { ...m, effects: [], sends: [], solo: false })),
    playlist: { ...project.playlist, clips: [] },
    automations: []
  };
  const sr = 44100;
  const seconds = Math.min(10, Math.max(0.5, job.seconds || 3));
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const eng = new AudioEngine(ctx, { realtime: false });
  eng.samples = getEngine()?.samples || new Map();
  eng.setProject(solo);
  // the same preparation as a full render: samples, physical-model notes, plugin modules/samples in this context
  await Promise.all([eng.loadNeededSamples(solo), eng.prewarmModels(solo), preparePlugins(ctx, solo)]);
  const melodic = INSTRUMENTS[ch.instrument.kind]?.melodic;
  const key = job.key ?? (melodic ? ch.rootKey : 60);
  const noteSeconds = ((job.lengthSteps ?? (melodic ? 8 : 1)) * STEP / PPQ) * (60 / project.bpm);
  eng.triggerNote(ch.id, key, job.velocity ?? 0.8, 0.01, noteSeconds, { force: true });
  const buffer = await ctx.startRendering();
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  // analyse the sound itself, not the silence after it (a 1 s 808 in a 3 s render would pass for a "loop")
  let last = 0;
  for (const d of channels) for (let i = d.length - 1; i > last; i--) if (Math.abs(d[i]) > 1e-3) { last = i; break; }
  const audible = Math.min(buffer.length, last + Math.round(buffer.sampleRate * 0.05));
  const a = analyzeAudio({ channels: channels.map((d) => d.subarray(0, Math.max(audible, 128))), sampleRate: buffer.sampleRate });
  return {
    channel: ch.name, key, velocity: job.velocity ?? 0.8, noteSeconds: Math.round(noteSeconds * 1000) / 1000, through: viaInsert ? 'insert' : 'channel',
    analysis: {
      lufs: a.lufs, peakDb: a.peakDb, truePeakDb: a.truePeakDb, crestDb: a.crestDb,
      pitch: a.pitch, lowPeakHz: a.spectrum.lowPeakHz, lowPeakNote: a.spectrum.lowPeakNote,
      centroidHz: a.spectrum.centroidHz, brightness: a.spectrum.brightness, tonality: a.spectrum.tonality,
      bandsPercent: a.spectrum.bandsPercent, stereoWidth: a.stereo?.width ?? null, character: a.character
    },
    envelope: envelopeTimes({ channels, sampleRate: buffer.sampleRate })
  };
}

const STEM_LIMIT = 32;

/**
 * Render each channel that plays (plus the audio clips) on its own and upload it as a WAV into the user's exports.
 * Stems keep their channel strip, mixer insert, effects and sends (e.g. its share of a reverb bus) but not the master
 * bus processing — the usual delivery for mixing/mastering engineers. Summed, they rebuild the pre-master mix.
 * Called for MCP jobs ({ jobId, sync }) and from the File menu (no job: each stem is uploaded straight to exports).
 */
export async function exportStems(job, { jobId, sync } = {}) {
  const st = useStore.getState();
  const project = st.project?.id === job.projectId ? st.project : await api.getProject(job.projectId);
  const mode = job.mode === 'pattern' || songLength(project) === 0 ? 'pattern' : 'song';
  const active = activeChannels(project, mode, job.patternId);
  const wanted = active.slice(0, STEM_LIMIT).map((c) => ({ channelId: c.id, name: c.name }));
  const skipped = active.slice(STEM_LIMIT).map((c) => c.name);
  if (mode === 'song' && project.playlist.clips.some((c) => c.kind === 'audio' && !c.mute)) wanted.push({ name: 'Audio clips', audioClips: true });
  if (!wanted.length) throw new Error('Nothing plays in this song/pattern, so there are no stems to export');
  const bitDepth = job.bitDepth === 16 ? 16 : 24;
  // stems ignore insert solo (it would silence every other insert) and, by default, the master bus effects
  const base = { ...project, mixer: project.mixer.map((m, i) => ({ ...m, solo: false, ...(i === 0 && !job.masterFx ? { effects: [] } : {}) })) };
  const samples = getEngine()?.samples || new Map();
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const files = [];
  for (const [i, w] of wanted.entries()) {
    const solo = w.audioClips
      ? { ...base, channels: base.channels.map((c) => ({ ...c, mute: true, solo: false })) }
      : {
          ...base,
          channels: base.channels.map((c) => ({ ...c, solo: false, mute: c.id !== w.channelId })),
          playlist: { ...base.playlist, clips: base.playlist.clips.filter((c) => c.kind !== 'audio') }
        };
    const { blob } = await renderProject(solo, { mode, patternId: job.patternId, loops: job.loops || 2, tail: 2, samples, bitDepth, ditherSeed: i + 1 });
    const fd = new FormData();
    fd.append('name', `${project.name.slice(0, 20)}-${pad(i + 1)}-${w.name.slice(0, 20)}-${stamp}`);
    fd.append('file', blob, 'stem.wav');
    const res = jobId ? await api.jobFile(jobId, fd) : await api.uploadExport(fd);
    files.push({ stem: w.name, ...res.export });
    if (jobId) sync?.send({ type: 'job-progress', jobId, progress: Math.round(((i + 1) / wanted.length) * 100) / 100 });
    else useStore.setState({ busy: `Exporting stems… ${i + 1}/${wanted.length}` });
  }
  if (jobId) {
    const fd = new FormData();
    fd.append('result', JSON.stringify({ stems: files.map((f) => f.stem), skipped, bitDepth, mode, masterFx: !!job.masterFx }));
    await api.jobResult(jobId, fd);
  }
  useStore.setState((s) => ({ exportsRev: s.exportsRev + 1 }));
  st.toast(`Exported ${files.length} stems to Projects → Exports${skipped.length ? ` (the first ${STEM_LIMIT} channels; skipped ${skipped.join(', ')})` : ''}`, job.fromUi ? 'info' : 'claude');
  return files;
}

/** Decode a sample with the browser's codecs, analyse it and store the result on the server. */
export async function analyzeSampleInBrowser(sampleId) {
  // the revision fetched goes back with the result: the server refuses it if the audio was replaced meanwhile
  const rev = sampleRev(sampleId);
  const res = await fetch(sampleFileUrl(sampleId), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not load sample (${res.status})`);
  const bytes = await res.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const buf = await ctx.decodeAudioData(bytes);
  const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const analysis = analyzeAudio({ channels, sampleRate: buf.sampleRate });
  await api.updateSample(sampleId, { analysis, duration: Math.round(buf.duration * 1000) / 1000, rev });
  return analysis;
}

