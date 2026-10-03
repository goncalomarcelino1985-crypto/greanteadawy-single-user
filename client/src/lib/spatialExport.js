// Spatial deliverables rendered in the browser (MCP export_spatial and File → Export spatial…):
//   binaural · 5.1 · 7.1 · 7.1.4  one WAV
//   objects                       the stereo bed + one mono WAV per object, and their positions over time (JSON)
//   adm                           one WAV: bed (2 tracks) + objects, with ADM (ITU-R BS.2076) axml/chna + bext chunks
import {
  SPATIAL_EXPORTS, SPEAKER_LAYOUTS, MAX_SPATIAL_OBJECTS, PPQ, spatialObjects, objectBlocks, songLength, patternLength,
  encodeWav, buildAdmXml, admChna, bextChunk, analyzeAudio, createTruePeakMeter
} from '@greanteadawy/core';
import { renderProject } from '../audio/render.js';
import { getEngine } from '../audio/index.js';
import { api } from '../state/api.js';
import { useStore } from '../state/store.js';

const SAMPLE_RATE = 48000;
const enc = new TextEncoder();
const dbfs = (x) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -120);
const peakOf = (d) => { let m = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; } return m; };

/** job: { projectId, format, mode, patternId, loops, name }; with { jobId, sync } it runs for the MCP, else from the UI. */
export async function exportSpatial(job, { jobId, sync } = {}) {
  const st = useStore.getState();
  const spec = SPATIAL_EXPORTS[job.format];
  if (!spec) throw new Error(`Unknown spatial format "${job.format}"`);
  const current = st.project?.id === job.projectId ? st.project : await api.getProject(job.projectId);
  // a spatial export renders the objects even when the studio is monitoring in plain stereo; solos don't apply
  const project = {
    ...current,
    spatial: { ...current.spatial, enabled: true },
    channels: current.channels.map((c) => (c.solo ? { ...c, solo: false } : c)),
    mixer: current.mixer.map((m) => (m.solo ? { ...m, solo: false } : m))
  };
  const objects = spatialObjects(project);
  if (!objects.length) throw new Error('No 3D objects: enable 3D on at least one mixer insert that goes to the master (Spatial window or place_object)');
  if (spec.mode === 'objects' && objects.length > MAX_SPATIAL_OBJECTS) throw new Error(`At most ${MAX_SPATIAL_OBJECTS} objects can be exported as object tracks (this mix has ${objects.length})`);
  const song = job.mode !== 'pattern' && songLength(project) > 0;
  const pattern = project.patterns.find((p) => p.id === job.patternId) || project.patterns[0];
  const loops = job.loops || 2;
  const ticks = song ? songLength(project) : patternLength(project, pattern) * loops;
  // one WAV can't exceed 4 GB (RIFF): check before spending minutes on a render that can't be saved
  const estSeconds = (ticks / PPQ) * (60 / project.bpm) + 2;
  const wavChannels = spec.mode === 'binaural' ? 2 : spec.mode === 'speakers' ? SPEAKER_LAYOUTS[spec.layout].speakers.length : job.format === 'adm' ? 2 + objects.length : 2;
  const estBytes = estSeconds * SAMPLE_RATE * 3 * wavChannels;
  if (estBytes > 4.2e9) {
    throw new Error(`A ${job.format} file of ${Math.round(estSeconds)} s with ${wavChannels} channels would be ${(estBytes / 1e9).toFixed(1)} GB — over the 4 GB WAV limit. Render a shorter part (mode=pattern, or shorten the song)${job.format === 'adm' ? ' or use fewer objects' : ''}.`);
  }
  const progress = (p) => (jobId ? sync?.send({ type: 'job-progress', jobId, progress: Math.round(p * 100) / 100 }) : null);
  const base = (job.name || project.name).slice(0, 40);
  const samples = getEngine()?.samples || new Map();
  const spatial = { mode: spec.mode, layout: spec.layout, objectOrder: objects };
  const { buffer, seconds } = await renderProject(project, {
    mode: song ? 'song' : 'pattern', patternId: pattern?.id, loops, tail: 2, samples, sampleRate: SAMPLE_RATE, bitDepth: 24,
    encode: false, spatial, onProgress: (p) => progress(p * 0.8)
  });
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const upload = async (name, bytes) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('file', new Blob([bytes], { type: 'audio/wav' }), 'spatial.wav');
    return (jobId ? await api.jobFile(jobId, fd) : await api.uploadExport(fd)).export;
  };
  const objectInfo = objects.map((i) => ({ insert: i, name: project.mixer[i].name, blocks: objectBlocks(project, i, { song, ticks }) }));
  const files = [];
  let summary;

  if (spec.mode === 'binaural' || spec.mode === 'speakers') {
    const layout = spec.layout ? SPEAKER_LAYOUTS[spec.layout] : null;
    const bytes = encodeWav(channels, SAMPLE_RATE, { bitDepth: 24, ...(layout ? { channelMask: layout.mask } : {}) });
    files.push(await upload(`${base}-${job.format === 'binaural' ? 'binaural' : job.format.replace(/\./g, '_')}`, bytes));
    const names = layout ? layout.speakers.map(([id]) => id) : ['L', 'R'];
    summary = { channels: names.map((id, i) => ({ id, peakDb: dbfs(peakOf(channels[i])) })) };
    if (!layout) {
      const a = analyzeAudio({ channels, sampleRate: SAMPLE_RATE }, { lite: true });
      const tp = createTruePeakMeter(); // the lite analysis skips true peak
      tp.push(channels);
      const peak = tp.peak();
      Object.assign(summary, { lufs: a.lufs, truePeakDb: peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : null });
    }
  } else if (job.format === 'adm') {
    const xml = buildAdmXml({ title: project.name, duration: buffer.duration, sampleRate: SAMPLE_RATE, bitDepth: 24, objects: objectInfo });
    const bytes = encodeWav(channels, SAMPLE_RATE, {
      bitDepth: 24, channelMask: 0,
      chunks: [
        { id: 'bext', data: bextChunk({ description: `${project.name} — GreanTeaDawy spatial mix (bed + ${objects.length} objects)` }) },
        { id: 'chna', data: admChna(objects.length) },
        { id: 'axml', data: enc.encode(xml) }
      ]
    });
    files.push(await upload(`${base}-adm`, bytes));
    summary = { tracks: 2 + objects.length, channels: [{ id: 'Bed L', peakDb: dbfs(peakOf(channels[0])) }, { id: 'Bed R', peakDb: dbfs(peakOf(channels[1])) }, ...objectInfo.map((o, k) => ({ id: o.name, peakDb: dbfs(peakOf(channels[2 + k])) }))] };
  } else {
    files.push(await upload(`${base}-bed`, encodeWav([channels[0], channels[1]], SAMPLE_RATE, { bitDepth: 24 })));
    for (const [k, o] of objectInfo.entries()) {
      files.push(await upload(`${base}-obj${String(k + 1).padStart(2, '0')}-${o.name.slice(0, 24)}`, encodeWav([channels[2 + k]], SAMPLE_RATE, { bitDepth: 24 })));
      progress(0.8 + (0.18 * (k + 1)) / objectInfo.length);
    }
    summary = { tracks: 1 + objects.length };
  }
  const positions = { title: project.name, sampleRate: SAMPLE_RATE, seconds: Math.round(buffer.duration * 1000) / 1000, coordinates: 'x -1 left…1 right, y -1 back…1 front, z 0 ear…1 ceiling (ADM Cartesian)', blocks: 'times in seconds; an object glides from the previous block\'s position to a block\'s position over its duration (ADM); jump: true = at that position for the whole block', objects: objectInfo, bed: 'stereo (L/R)' };
  const result = { format: job.format, files, objects: objectInfo.map((o) => ({ name: o.name, insert: o.insert, moves: o.blocks.length > 1, start: o.blocks[0] })), seconds: Math.round(seconds * 10) / 10, sampleRate: SAMPLE_RATE, bitDepth: 24, ...summary };
  if (jobId) {
    const fd = new FormData();
    fd.append('result', JSON.stringify({ ...result, positions: spec.mode === 'objects' ? positions : null }));
    fd.append('name', base);
    await api.jobResult(jobId, fd);
  }
  useStore.setState((s) => ({ exportsRev: s.exportsRev + 1 }));
  return { ...result, positions };
}
