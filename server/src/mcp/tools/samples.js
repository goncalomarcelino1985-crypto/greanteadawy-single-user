// The user's sample library: metadata (bitrate, sample rate...), analysis and placement.
import { PPQ, STEP, ticksPerBar, uid, MAX_TRACKS, EDIT_OPS, SCALES, parsePitchClass } from '@greanteadawy/core';
import { z, ok, projectIdArg, annotations as A, pickTrack } from '../util.js';
import { describeUsage, cleanName, nameKey } from '../../samples.js';

function line(s) {
  const m = s.metadata || {};
  const a = s.analysis;
  const bits = [
    s.duration ? `${s.duration}s` : null,
    m.sampleRate ? `${m.sampleRate / 1000} kHz` : null,
    m.bitsPerSample ? `${m.bitsPerSample}-bit` : null,
    m.bitrateKbps ? `${m.bitrateKbps} kbps` : null,
    m.channels ? (m.channels === 1 ? 'mono' : 'stereo') : null,
    m.codec || m.container || null
  ].filter(Boolean).join(', ');
  const ana = a
    ? [a.character, a.pitch && a.kind === 'one-shot' ? `pitch ${a.pitch.note}` : null, a.tempo && a.tempo.confidence >= 0.35 ? `${a.tempo.bpm} BPM` : null, a.key && a.key.confidence > 0.5 ? `${a.key.key} ${a.key.scale}` : null, Number.isFinite(a.lufs) ? `${a.lufs} LUFS` : null].filter(Boolean).join(', ')
    : 'not analysed yet';
  return `${s.name} [${s.id}] — ${bits} — ${ana}`;
}

/** Everything a search can match: name, folder, tags and the analysis words (character, pitch, key, tempo). */
function haystack(s, folder) {
  const a = s.analysis || {};
  const tags = Object.values(s.metadata?.tags || {}).join(' ');
  return [s.name, folder, tags, a.character, a.kind, a.pitch?.note, a.key ? `${a.key.key} ${a.key.scale}` : '', a.tempo ? `${a.tempo.bpm} bpm` : ''].join(' ').toLowerCase();
}

const UNFILED = /^(unfiled|none|no folder|-)$/i;
// what a folder id looks like: a reference like this that matches no folder is a stale id, never a new folder's name
const FOLDER_ID = /^fld_[0-9a-z]{10}$/;

/**
 * Resolve a folder reference (id or name) to a folder, null for "unfiled"; throws with the folder list otherwise. A
 * real folder wins over the "unfiled" aliases (a user may well have a folder called "None").
 */
function resolveFolder(folders, ref) {
  if (ref === null || ref === undefined) return null;
  // compared the way names are stored (NFC, single spaces, no invisible characters) and told apart (case, joiners)
  const r = nameKey(cleanName(String(ref), Infinity));
  const f = folders.find((x) => x.id === ref) || (r ? folders.find((x) => nameKey(x.name) === r) : undefined);
  if (f) return f;
  if (UNFILED.test(r)) return null;
  throw new Error(`No folder "${ref}". Folders: ${folders.length ? folders.map((x) => `${x.name} [${x.id}]`).join(', ') : 'none yet'} (or "unfiled").`);
}

export function registerSampleTools({ tool, backend, load }) {
  tool('list_samples', {
    title: 'List samples',
    description: "The user's uploaded audio samples, grouped by folder, with key facts: duration, sample rate, bit depth, bitrate, channels, codec, and analysis (what it sounds like, pitch, tempo, key, loudness). Search and/or pick one folder. Use get_sample_info for full details.",
    inputSchema: {
      query: z.string().max(200).optional().describe('Search words, all of which must match the name, folder, tags or analysis (e.g. "kick", "vocal 140 bpm", "dark pad A minor")'),
      folder: z.string().max(400).optional().describe('Only this folder (name or id); "unfiled" = samples not in any folder')
    },
    annotations: A.readOnly
  }, async ({ query, folder }) => {
    const [all, folders] = await Promise.all([backend.listSamples(), backend.listSampleFolders()]);
    if (!all.length) return ok('No samples uploaded yet. The user can upload or record audio in the Browser panel (Samples tab).');
    const byId = new Map(folders.map((f) => [f.id, f]));
    const nameOf = (s) => byId.get(s.folderId)?.name || '';
    let list = all;
    let where = '';
    if (folder !== undefined) {
      const f = resolveFolder(folders, folder);
      where = f ? `"${f.name}"` : 'Unfiled';
      list = list.filter((s) => (f ? s.folderId === f.id : !byId.has(s.folderId)));
    }
    const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) list = list.filter((s) => { const h = haystack(s, nameOf(s)); return words.every((w) => h.includes(w)); });
    const unfiled = all.filter((s) => !byId.has(s.folderId)).length;
    const summary = `Folders: ${[...folders.map((f) => `${f.name} (${f.count})`), `Unfiled (${unfiled})`].join(', ')}`;
    if (!list.length) return ok(`No samples match${query ? ` "${query}"` : ''}${where ? ` in ${where}` : ''}.\n${summary}`);
    const groups = [...folders.map((f) => [`${f.name} [${f.id}]`, list.filter((s) => s.folderId === f.id)]), ['Unfiled', list.filter((s) => !byId.has(s.folderId))]]
      .filter(([, items]) => items.length);
    const body = groups.map(([title, items]) => `## ${title}\n${items.map(line).join('\n')}`).join('\n\n');
    return ok(`${summary}\n${list.length < all.length ? `Showing ${list.length} of ${all.length} samples.\n` : ''}\n${body}`);
  });

  tool('get_sample_info', {
    title: 'Sample metadata & analysis',
    description: 'Full technical metadata of an uploaded sample (folder, format/container, codec, lossless, sample rate, bits per sample, channels, bitrate, duration, size, embedded tags such as title/artist/bpm/key) and its audio analysis (LUFS, peak, RMS, crest, clipping, silence, stereo width, spectral balance, onsets, tempo, key, pitch, one-shot vs loop, character).',
    inputSchema: { sampleId: z.string() },
    annotations: A.readOnly
  }, async ({ sampleId }) => {
    const s = await backend.getSample(sampleId);
    const folder = s.folderId ? (await backend.listSampleFolders()).find((f) => f.id === s.folderId)?.name || null : null;
    const info = backend.describeSample(s, folder);
    return ok(`${line(s)}\nFolder: ${folder || 'Unfiled'}${s.analysis?.summary ? `\n${s.analysis.summary}` : ''}`, info);
  });

  tool('analyze_sample', {
    title: 'Analyse sample',
    description: "(Re)analyse a sample in the user's browser (needed for formats the server can't decode, e.g. MP3/M4A/OGG, or to refresh). Returns the analysis.",
    inputSchema: { sampleId: z.string() },
    annotations: A.edit
  }, async ({ sampleId }) => {
    const s = await backend.getSample(sampleId);
    await backend.requestJob({ kind: 'analyze-sample', sampleId: s.id }, { timeoutMs: 90000 });
    const fresh = await backend.getSample(sampleId);
    const folder = fresh.folderId ? (await backend.listSampleFolders()).find((f) => f.id === fresh.folderId)?.name || null : null;
    return ok(`${line(fresh)}${fresh.analysis?.summary ? `\n${fresh.analysis.summary}` : ''}`, backend.describeSample(fresh, folder));
  });

  tool('rename_sample', {
    title: 'Rename sample',
    description: 'Rename an uploaded sample.',
    inputSchema: { sampleId: z.string(), name: z.string().min(1).max(800).describe('≤ 80 characters') },
    annotations: A.edit
  }, async ({ sampleId, name }) => {
    const s = await backend.updateSample(sampleId, { name });
    return ok(`Renamed to "${s.name}".`);
  });

  tool('sample_folders', {
    title: 'Sample folders',
    description: 'List, create, rename or delete the folders that organise the user\'s samples (each sample is in one folder, or Unfiled). Deleting a folder keeps its samples: they become unfiled. Use move_samples to file samples.',
    inputSchema: {
      action: z.enum(['list', 'create', 'rename', 'delete']).optional().describe('Default list'),
      folder: z.string().max(400).optional().describe('create: the new folder\'s name (≤ 40 characters, not "Unfiled"); rename/delete: the folder (name or id)'),
      newName: z.string().max(400).optional().describe('rename: the new name (≤ 40 characters)')
    },
    annotations: A.edit
  }, async ({ action = 'list', folder, newName }) => {
    const folders = await backend.listSampleFolders();
    if (action === 'list') {
      const unfiled = (await backend.listSamples()).filter((s) => !folders.some((f) => f.id === s.folderId)).length;
      return ok(folders.length ? `${folders.map((f) => `${f.name} [${f.id}] — ${f.count} sample${f.count === 1 ? '' : 's'}`).join('\n')}\nUnfiled — ${unfiled}` : `No folders yet (${unfiled} unfiled samples). Create one with action "create".`);
    }
    if (!folder) throw new Error(`${action} needs "folder"`);
    if (action === 'create') {
      const f = await backend.createSampleFolder(folder);
      return ok(`Created folder "${f.name}" [${f.id}].`);
    }
    const f = resolveFolder(folders, folder);
    if (!f) throw new Error('"Unfiled" is not a folder: it is where samples without a folder are listed');
    if (action === 'rename') {
      if (!newName) throw new Error('rename needs "newName"');
      const r = await backend.renameSampleFolder(f.id, newName);
      return ok(`Renamed folder "${f.name}" to "${r.name}" [${f.id}].`);
    }
    const n = await backend.deleteSampleFolder(f.id);
    return ok(`Deleted folder "${f.name}"${n ? `; its ${n} sample${n === 1 ? ' is' : 's are'} now unfiled` : ''}.`);
  });

  tool('move_samples', {
    title: 'Move samples to a folder',
    description: 'File samples into a folder (by name or id; a folder with a new name is created). "unfiled" takes them out of their folder. Each sample is in one folder at a time.',
    inputSchema: {
      sampleIds: z.array(z.string()).min(1).max(500),
      folder: z.string().min(1).max(400).describe('Folder name or id (≤ 40 characters), or "unfiled"')
    },
    annotations: A.edit
  }, async ({ sampleIds, folder }) => {
    // every sample first: a typo in one id must not leave a new, empty folder behind
    await Promise.all([...new Set(sampleIds)].map((id) => backend.getSample(id)));
    const folders = await backend.listSampleFolders();
    let f;
    let created = false;
    try {
      f = resolveFolder(folders, folder);
    } catch (e) {
      if (FOLDER_ID.test(folder.trim())) throw e; // a folder id that no longer exists: don't create a folder named after it
      f = await backend.createSampleFolder(folder);
      created = true;
    }
    const n = await backend.moveSamples(sampleIds, f ? f.id : null);
    return ok(`Moved ${n} sample${n === 1 ? '' : 's'} to ${f ? `"${f.name}" [${f.id}]${created ? ' (new folder)' : ''}` : 'Unfiled'}.`);
  });

  tool('delete_sample', {
    title: 'Delete samples',
    description: 'Permanently delete uploaded samples. Only when the user explicitly asks. Sampler channels and audio clips that use them go silent — the reply says which projects were affected.',
    inputSchema: {
      sampleId: z.string().optional(),
      sampleIds: z.array(z.string()).min(1).max(500).optional().describe('Several at once (instead of sampleId)')
    },
    annotations: A.destructive
  }, async ({ sampleId, sampleIds }) => {
    const ids = [...new Set([...(sampleIds || []), ...(sampleId ? [sampleId] : [])])];
    if (!ids.length) throw new Error('Pass sampleId or sampleIds');
    const named = await Promise.all(ids.map((id) => backend.getSample(id)));
    const usage = await backend.sampleUsage(ids);
    if (ids.length === 1) await backend.deleteSample(ids[0]);
    else await backend.deleteSamples(ids);
    const used = named.map((s) => [s, describeUsage(usage[s.id])]).filter(([, u]) => u);
    return ok(`Deleted ${named.map((s) => `"${s.name}" [${s.id}]`).join(', ')}.${used.length ? ` Now silent: ${used.map(([s, u]) => `"${s.name}" was ${u}`).join('; ')}.` : ''}`);
  });

  tool('edit_sample', {
    title: 'Edit sample (wave editor)',
    description: `Edit an uploaded sample the way the studio's wave editor does (it runs in the user's browser) and save the result as a NEW sample (default, the original stays) or over the original. Operations run in order; start/end are seconds (omit both for the whole sample): ${Object.entries(EDIT_OPS).map(([k, v]) => `${k}: ${v}`).join('; ')}. pitch_correct is auto-tune for a solo voice or instrument: key + scale (default C chromatic), amount 0-1 (1), speed ms (50; 0 = robotic), flatten 0-1 (0). saveAs "replace" changes every project that uses the sample: only when the user asks for it.`,
    inputSchema: {
      sampleId: z.string(),
      ops: z.array(z.object({
        op: z.enum(Object.keys(EDIT_OPS)),
        start: z.number().min(0).optional().describe('Seconds'),
        end: z.number().min(0).optional().describe('Seconds'),
        db: z.number().min(-48).max(48).optional().describe('gain'),
        peakDb: z.number().min(-60).max(0).optional().describe('normalize target'),
        curve: z.enum(['linear', 'exp', 'log', 'scurve']).optional().describe('fade_in / fade_out'),
        rate: z.number().min(0.25).max(4).optional().describe('speed / stretch'),
        semitones: z.number().min(-24).max(24).optional().describe('pitch_shift'),
        thresholdDb: z.number().min(-90).max(-10).optional().describe('trim_silence (relative to the peak)'),
        key: z.string().max(3).optional().describe('pitch_correct: e.g. "A", "F#", "Bb"'),
        scale: z.string().max(20).optional().describe('pitch_correct: chromatic, major, minor, dorian, … (see music_theory)'),
        amount: z.number().min(0).max(1).optional(),
        speed: z.number().min(0).max(500).optional().describe('pitch_correct: ms to reach the target'),
        flatten: z.number().min(0).max(1).optional()
      })).min(1).max(20),
      saveAs: z.enum(['new', 'replace']).optional().describe('new (default) or replace the original'),
      name: z.string().min(1).max(800).optional().describe('Name of the new sample, ≤ 80 characters (default "<original> edit")'),
      folder: z.string().max(400).optional().describe('Folder for the new sample: name or id, or "unfiled" (default: the original\'s folder)')
    },
    annotations: A.edit
  }, async ({ sampleId, ops, saveAs = 'new', name, folder }) => {
    const s = await backend.getSample(sampleId);
    ops.forEach((o, i) => {
      if (o.op === 'pitch_correct') {
        if (o.scale !== undefined && o.scale !== 'chromatic' && !Object.hasOwn(SCALES, o.scale)) throw new Error(`Unknown scale "${o.scale}". Use chromatic or one of: ${Object.keys(SCALES).join(', ')}`);
        if (o.key !== undefined && parsePitchClass(o.key) === null) throw new Error(`Invalid key "${o.key}" (use e.g. C, F#, Bb)`);
      }
      if ((o.op === 'speed' || o.op === 'stretch') && o.rate === undefined) throw new Error(`${o.op} needs rate`);
      if (o.op === 'pitch_shift' && !o.semitones) throw new Error('pitch_shift needs semitones');
      if (o.op === 'gain' && o.db === undefined) throw new Error('gain needs db');
      if (Number.isFinite(o.start) && Number.isFinite(o.end) && o.end <= o.start) throw new Error(`${o.op}: end must be after start`);
      // only the first operation sees the sample's own length (a speed or trim changes it for the next ones)
      if (i === 0 && s.duration && Number.isFinite(o.start) && o.start >= s.duration) throw new Error(`${o.op}: start ${o.start}s is past the end of the sample (${s.duration}s)`);
      if (o.op === 'delete' && !Number.isFinite(o.start) && !Number.isFinite(o.end)) throw new Error('delete needs start and/or end (deleting everything would leave the sample empty)');
    });
    let folderId;
    if (saveAs === 'new' && folder !== undefined) folderId = resolveFolder(await backend.listSampleFolders(), folder)?.id ?? null;
    if (name !== undefined && !cleanName(name, 80)) throw new Error('name needs visible characters');
    if (saveAs === 'replace' && (name || folder !== undefined)) throw new Error('name and folder are for saveAs "new" (replace keeps the sample\'s name and folder)');
    const usage = saveAs === 'replace' ? (await backend.sampleUsage([s.id]))[s.id] : null;
    const r = await backend.requestJob({ kind: 'sample-edit', sampleId: s.id, ops, saveAs, name: cleanName(name || '', 80) || `${cleanName(s.name, 75)} edit`, folderId }, { timeoutMs: 240000 });
    const out = await backend.getSample(String(r?.sampleId || ''));
    const notes = Array.isArray(r?.notes) && r.notes.length ? ` ${r.notes.map(String).join('; ')}.` : '';
    const facts = `${out.duration ?? '?'} s${out.metadata?.channels ? `, ${out.metadata.channels === 1 ? 'mono' : 'stereo'}` : ''}`;
    if (saveAs === 'replace') {
      const used = describeUsage(usage);
      return ok(`Replaced the audio of "${out.name}" [${out.id}] (${facts}).${notes}${used ? ` It is ${used}: they all play the edited audio now.` : ''}`);
    }
    return ok(`Saved "${out.name}" [${out.id}] (${facts}) — the original "${s.name}" is unchanged.${notes}`);
  });

  tool('add_audio_clip', {
    title: 'Add audio clip',
    description: 'Place an uploaded sample (loop, vocal, fx, full recording) directly in the playlist as an audio clip, with optional gain and fades. fit="repitch" plays a loop at the project tempo by changing its speed (and pitch, like a turntable — classic for boom bap / lo-fi); otherwise audio is not time-stretched, so match the project BPM to the loop (get_sample_info shows its tempo).',
    inputSchema: {
      projectId: projectIdArg,
      sampleId: z.string(),
      startBar: z.number().min(1),
      track: z.number().int().min(1).max(MAX_TRACKS).optional(),
      bars: z.number().positive().optional().describe('Clip length in bars (default: sample length at the project tempo)'),
      repeat: z.number().int().min(1).max(64).optional().describe('Consecutive copies (default 1)'),
      gainDb: z.number().min(-60).max(12).optional().describe('Clip gain in dB (default 0)'),
      fadeInSteps: z.number().min(0).optional().describe('Fade-in length in steps (16ths)'),
      fadeOutSteps: z.number().min(0).optional().describe('Fade-out length in steps'),
      fit: z.enum(['none', 'repitch']).optional().describe('repitch = speed the loop to the project tempo (needs a detected or given sampleBpm)'),
      sampleBpm: z.number().min(40).max(300).optional().describe('Tempo of the loop when fit=repitch (default: detected)')
    },
    annotations: A.edit
  }, async ({ projectId, sampleId, startBar, track, bars, repeat = 1, gainDb, fadeInSteps, fadeOutSteps, fit = 'none', sampleBpm }) => {
    const p = await load(projectId);
    const sample = await backend.getSample(sampleId);
    const bar = ticksPerBar(p);
    const tempo = sample.analysis?.tempo;
    let rate = 1;
    let fitNote = '';
    if (fit === 'repitch') {
      let src = sampleBpm ?? (tempo && tempo.confidence >= 0.2 ? tempo.bpm : null);
      if (!src) throw new Error('fit=repitch needs the loop tempo: no tempo was detected, so pass sampleBpm');
      // a half/double-time detection would make a silly speed change: pick the octave of the tempo nearest the project's
      while (src * 1.5 < p.bpm) src *= 2;
      while (src / 1.5 > p.bpm) src /= 2;
      rate = Math.round((p.bpm / src) * 10000) / 10000;
      if (rate < 0.25 || rate > 4) throw new Error(`The loop (${src} BPM) is too far from ${p.bpm} BPM to repitch`);
      const semis = Math.round(12 * Math.log2(rate) * 10) / 10;
      fitNote = ` Repitched ${src} → ${p.bpm} BPM (speed ×${rate}, ${semis > 0 ? '+' : ''}${semis} semitones).`;
    }
    const length = bars ? Math.round(bars * bar) : sample.duration ? Math.max(1, Math.round((sample.duration / rate) * (p.bpm / 60) * PPQ)) : bar;
    const audio = {
      ...(gainDb !== undefined && { gain: Math.pow(10, gainDb / 20) }),
      ...(fadeInSteps !== undefined && { fadeIn: Math.round(fadeInSteps * STEP) }),
      ...(fadeOutSteps !== undefined && { fadeOut: Math.round(fadeOutSteps * STEP) }),
      ...(rate !== 1 && { rate })
    };
    const t = track ? track - 1 : pickTrack(p, sampleId);
    const start = Math.round((startBar - 1) * bar);
    const ops = [];
    if (t >= p.playlist.tracks.length) ops.push({ type: 'track/add', count: t - p.playlist.tracks.length + 1 });
    const clips = Array.from({ length: repeat }, (_, i) => ({ id: uid('clip'), kind: 'audio', refId: sample.id, track: t, start: start + i * length, length, ...audio }));
    ops.push({ type: 'clip/add', clips });
    await backend.applyOps(p.id, ops);
    const warn = fit !== 'repitch' && tempo && tempo.confidence >= 0.35 && Math.abs(tempo.bpm - p.bpm) / p.bpm > 0.03 && Math.abs(tempo.bpm * 2 - p.bpm) / p.bpm > 0.03 && Math.abs(tempo.bpm / 2 - p.bpm) / p.bpm > 0.03
      ? ` Note: the sample is ~${tempo.bpm} BPM but the project is ${p.bpm} BPM, so it will drift (no time-stretch) — use fit="repitch" or change the project tempo.`
      : '';
    return ok(`Placed sample "${sample.name}" on track ${t + 1} at bar ${startBar}${repeat > 1 ? ` ×${repeat}` : ''} [${clips.map((c) => c.id).join(', ')}].${fitNote}${warn}`);
  });
}
