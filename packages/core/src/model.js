import {
  PPQ, STEP, DEFAULT_BPM, DEFAULT_TRACK_COUNT, DEFAULT_INSERT_COUNT, COLORS, MIN_BPM, MAX_BPM,
  ticksPerBar, clamp, num, MAX_TRACKS, MAX_PATTERN_BARS
} from './constants.js';
import { SCALES } from './music.js';
import { uid } from './ids.js';
import { INSTRUMENTS, makeInstrument } from './instruments.js';
import { createEffect, EFFECTS } from './effects.js';
import { normalizeInsertSpatial, normalizeProjectSpatial, SPATIAL_PARAMS } from './spatial.js';

export const PROJECT_FORMAT = 'greanteadawy-project';
export const PROJECT_VERSION = 1;

export const MAX_NUDGE_MS = 50;

export function createChannel(opts = {}) {
  const kind = opts.kind || opts.instrument?.kind || 'kick';
  const def = INSTRUMENTS[kind];
  if (!def) throw new Error(`Unknown instrument "${kind}"`);
  const plugin = opts.instrument?.plugin ?? opts.plugin ?? null;
  const instrument = opts.instrument?.params
    ? makeInstrument(kind, opts.instrument.preset, opts.instrument.params, { plugin })
    : makeInstrument(kind, opts.preset, opts.params, { plugin });
  return {
    id: opts.id || uid('ch'),
    name: String(opts.name || def.label).slice(0, 64),
    color: opts.color || def.color,
    instrument,
    volume: num(opts.volume, 0.78, 0, 1.25),
    pan: num(opts.pan, 0, -1, 1),
    pitch: num(opts.pitch, 0, -24, 24),
    mute: !!opts.mute,
    solo: !!opts.solo,
    mixerTrack: Math.round(num(opts.mixerTrack, 0, 0, 999)),
    chokeGroup: Math.round(num(opts.chokeGroup, 0, 0, 8)),
    rootKey: Math.round(num(opts.rootKey, def.defaultKey, 0, 127)),
    filterCutoff: num(opts.filterCutoff, 20000, 20, 20000),
    filterRes: num(opts.filterRes, 0.7, 0.1, 20),
    // groove: play this channel early/late (ms, e.g. a lazy snare +12) and with this share of the project swing
    nudge: num(opts.nudge, 0, -MAX_NUDGE_MS, MAX_NUDGE_MS),
    swingMix: num(opts.swingMix, 1, 0, 1)
  };
}


export function createPattern(opts = {}) {
  return {
    id: opts.id || uid('pat'),
    name: String(opts.name || 'Pattern').slice(0, 64),
    color: opts.color || COLORS[Math.floor(Math.random() * COLORS.length)],
    // absolute cap here (32 beats × 64 bars); ops clamp to 64 bars of the project's own time signature
    length: Math.max(STEP, Math.round(num(opts.length, PPQ * 4, STEP, PPQ * 32 * 64))),
    notes: opts.notes ? { ...opts.notes } : {}
  };
}

export function createTrack(i, opts = {}) {
  return { id: opts.id || uid('trk'), name: opts.name || `Track ${i + 1}`, color: opts.color || null, mute: !!opts.mute };
}

export function createMixerInsert(i, opts = {}) {
  return {
    id: opts.id || uid('mx'),
    name: opts.name || (i === 0 ? 'Master' : `Insert ${i}`),
    color: opts.color || null,
    // the master fader sits after the master limiter: at 0 dB its ceiling is the real output ceiling
    volume: num(opts.volume, i === 0 ? 1 : 0.8, 0, 1.25),
    pan: num(opts.pan, 0, -1, 1),
    mute: !!opts.mute,
    solo: !!opts.solo,
    output: 0,
    sends: [],
    effects: Array.isArray(opts.effects) ? opts.effects : [],
    // 3D object placement (used when the project's spatial mix is on): see spatial.js
    spatial: normalizeInsertSpatial(i === 0 ? null : opts.spatial, num(opts.pan, 0, -1, 1))
  };
}

export function createClip(opts) {
  if (!['pattern', 'audio', 'automation'].includes(opts.kind)) throw new Error(`Invalid clip kind "${opts.kind}"`);
  const clip = {
    id: opts.id || uid('clip'),
    kind: opts.kind,
    refId: String(opts.refId),
    track: Math.max(0, Math.round(num(opts.track, 0))),
    start: Math.max(0, Math.round(num(opts.start, 0))),
    length: Math.max(1, Math.round(num(opts.length, PPQ * 4))),
    offset: Math.max(0, Math.round(num(opts.offset, 0))),
    mute: !!opts.mute
  };
  if (clip.kind === 'audio') Object.assign(clip, audioClipFields(opts));
  return clip;
}

export const AUDIO_CLIP_LIMITS = { gain: [0, 4], rate: [0.25, 4] };

/**
 * Audio clip settings: gain (linear, 1 = as recorded), fadeIn/fadeOut (ticks), rate (playback speed: 1 = original,
 * project bpm / loop bpm "repitches" a loop to the project tempo, like turntable speed).
 */
export function audioClipFields(o = {}, base = { gain: 1, fadeIn: 0, fadeOut: 0, rate: 1 }) {
  return {
    gain: num(o.gain, base.gain, ...AUDIO_CLIP_LIMITS.gain),
    fadeIn: Math.max(0, Math.round(num(o.fadeIn, base.fadeIn))),
    fadeOut: Math.max(0, Math.round(num(o.fadeOut, base.fadeOut))),
    rate: Math.round(num(o.rate, base.rate, ...AUDIO_CLIP_LIMITS.rate) * 10000) / 10000
  };
}

export const MAX_MARKERS = 256;

/** A named position in the song (section start such as "Hook"), shown above the playlist. */
export function createMarker(opts = {}) {
  return {
    id: opts.id || uid('mk'),
    tick: Math.max(0, Math.round(num(opts.tick, 0))),
    name: String(opts.name || 'Marker').slice(0, 64)
  };
}

export function createAutomation(opts = {}) {
  const length = Math.max(STEP, Math.round(num(opts.length, PPQ * 16)));
  const points = (opts.points?.length ? opts.points : [{ t: 0, v: 0.5 }, { t: length, v: 0.5 }])
    .map((p) => ({ t: clamp(Math.round(num(p.t, 0)), 0, length), v: num(p.v, 0.5, 0, 1) }))
    .sort((a, b) => a.t - b.t);
  return {
    id: opts.id || uid('auto'),
    name: String(opts.name || 'Automation').slice(0, 64),
    color: opts.color || '#7fd1b9',
    target: opts.target || { type: 'master', param: 'volume' },
    length,
    points
  };
}

export function createEmptyProject(opts = {}) {
  const mixer = [];
  for (let i = 0; i <= (opts.inserts ?? DEFAULT_INSERT_COUNT); i++) mixer.push(createMixerInsert(i));
  mixer[0].effects = [createEffect('limiter')];
  const tracks = [];
  for (let i = 0; i < (opts.tracks ?? DEFAULT_TRACK_COUNT); i++) tracks.push(createTrack(i));
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: opts.id || uid('prj'),
    name: String(opts.name || 'Untitled').slice(0, 100),
    bpm: num(opts.bpm, DEFAULT_BPM, MIN_BPM, MAX_BPM),
    timeSig: [4, 4],
    swing: 0,
    key: opts.key || 'C',
    scale: opts.scale || 'minor',
    channels: [],
    patterns: [],
    playlist: { tracks, clips: [] },
    markers: [],
    automations: [],
    mixer,
    spatial: normalizeProjectSpatial(opts.spatial),
    createdAt: now,
    updatedAt: now,
    rev: 0
  };
}

/** The default new project: 4 drum channels and one empty pattern. */
export function createDefaultProject(opts = {}) {
  const p = createEmptyProject(opts);
  const chans = [
    createChannel({ name: 'Kick', kind: 'kick', mixerTrack: 1 }),
    createChannel({ name: 'Clap', kind: 'clap', mixerTrack: 2 }),
    createChannel({ name: 'Hat', kind: 'hat', mixerTrack: 3, chokeGroup: 1 }),
    createChannel({ name: 'Snare', kind: 'snare', mixerTrack: 4 })
  ];
  p.channels = chans;
  chans.forEach((c, i) => { p.mixer[i + 1].name = c.name; });
  p.patterns = [createPattern({ name: 'Pattern 1', color: COLORS[6] })];
  return p;
}

/** Fill in defaults / repair a project loaded from disk, an import or an undo snapshot. */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Project must be an object');
  const base = createEmptyProject({ id: typeof raw.id === 'string' ? raw.id : undefined, name: typeof raw.name === 'string' ? raw.name : undefined, bpm: raw.bpm, inserts: 0, tracks: 0 });
  const p = { ...base, ...raw };
  p.format = PROJECT_FORMAT;
  p.version = PROJECT_VERSION;
  p.id = base.id;
  p.name = base.name;
  p.bpm = num(p.bpm, DEFAULT_BPM, MIN_BPM, MAX_BPM);
  p.swing = num(p.swing, 0, 0, 1);
  const [tsNum, tsDen] = Array.isArray(raw.timeSig) ? raw.timeSig.map((x) => Math.round(num(x, 4))) : [4, 4];
  p.timeSig = tsNum >= 1 && tsNum <= 32 && [2, 4, 8, 16].includes(tsDen) ? [tsNum, tsDen] : [4, 4];
  p.key = normalizeKey(raw.key) || 'C';
  p.scale = typeof raw.scale === 'string' && SCALES[raw.scale] ? raw.scale : 'minor';
  const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);

  p.mixer = (Array.isArray(raw.mixer) && raw.mixer.length ? raw.mixer : [createMixerInsert(0, { effects: [createEffect('limiter')] })])
    .slice(0, 65)
    .map((m, i) => {
      const base = createMixerInsert(i);
      const effects = (Array.isArray(m?.effects) ? m.effects : [])
        .filter((e) => e && EFFECTS[e.type])
        .slice(0, 10)
        .map((e) => createEffect(e.type, e.params || {}, { id: e.id ? String(e.id) : undefined, enabled: e.enabled !== false, plugin: e.plugin }));
      return {
        ...base,
        id: m?.id ? String(m.id) : base.id,
        name: m?.name ? String(m.name).slice(0, 64) : base.name,
        color: m?.color || null,
        volume: num(m?.volume, base.volume, 0, 1.25),
        pan: num(m?.pan, 0, -1, 1),
        mute: !!m?.mute,
        solo: !!m?.solo,
        output: Math.round(num(m?.output, 0, 0, 999)),
        sends: Array.isArray(m?.sends) ? m.sends.map((s) => ({ to: Math.round(num(s?.to, -1)), amount: num(s?.amount, 0.5, 0, 1) })) : [],
        effects,
        spatial: i === 0 ? normalizeInsertSpatial(null) : normalizeInsertSpatial(m?.spatial, num(m?.pan, 0, -1, 1))
      };
    });
  while (p.mixer.length < 2) p.mixer.push(createMixerInsert(p.mixer.length));
  repairRouting(p.mixer);

  const seenChannels = new Set();
  p.channels = (Array.isArray(raw.channels) ? raw.channels : []).filter(obj).map((c) => {
    let ch;
    try {
      // createChannel validates/clamps every field and fills instrument params from defaults + preset
      ch = createChannel({ ...c, id: c.id, kind: c.instrument?.kind, instrument: c.instrument });
    } catch {
      ch = createChannel({ name: c?.name, id: c?.id });
    }
    if (ch.mixerTrack >= p.mixer.length) ch.mixerTrack = 0;
    if (seenChannels.has(ch.id)) ch.id = uid('ch'); // duplicate ids would make edits ambiguous
    seenChannels.add(ch.id);
    return ch;
  });
  const channelIds = new Set(p.channels.map((c) => c.id));
  for (const m of p.mixer) {
    for (const fx of m.effects) {
      for (const def of EFFECTS[fx.type].params) if (def.type === 'channel' && fx.params[def.key] && !channelIds.has(fx.params[def.key])) fx.params[def.key] = null;
    }
  }

  const seenPatterns = new Set();
  p.patterns = (Array.isArray(raw.patterns) ? raw.patterns : []).filter(obj).map((pt) => {
    const fresh = createPattern({ ...pt, id: typeof pt.id === 'string' && !seenPatterns.has(pt.id) ? pt.id : undefined, name: typeof pt.name === 'string' ? pt.name : undefined });
    seenPatterns.add(fresh.id);
    fresh.length = Math.min(fresh.length, ticksPerBar(p) * MAX_PATTERN_BARS);
    const notes = {};
    for (const [cid, list] of Object.entries(obj(pt.notes) ? pt.notes : {})) {
      if (channelIds.has(cid) && Array.isArray(list)) notes[cid] = list.filter(obj).map(sanitizeNote);
    }
    return { ...fresh, notes };
  });
  if (!p.patterns.length) p.patterns.push(createPattern({ name: 'Pattern 1' }));

  const tracks = (Array.isArray(raw.playlist?.tracks) ? raw.playlist.tracks : []).filter(obj).slice(0, MAX_TRACKS);
  p.playlist = {
    tracks: tracks.length
      ? tracks.map((t, i) => {
        const tr = createTrack(i, { id: typeof t.id === 'string' ? t.id : undefined, name: typeof t.name === 'string' ? t.name.slice(0, 64) : undefined, color: typeof t.color === 'string' ? t.color.slice(0, 16) : null, mute: t.mute });
        return tr;
      })
      : Array.from({ length: DEFAULT_TRACK_COUNT }, (_, i) => createTrack(i)),
    clips: (Array.isArray(raw.playlist?.clips) ? raw.playlist.clips : []).filter(obj).flatMap((c) => {
      try { return [createClip(c)]; } catch { return []; }
    })
  };
  p.automations = (Array.isArray(raw.automations) ? raw.automations : []).filter(obj).map((a) => createAutomation(a))
    .filter((a) => validAutomationTarget(p, a.target));
  p.markers = (Array.isArray(raw.markers) ? raw.markers : []).filter(obj).slice(0, MAX_MARKERS).map((m) => createMarker({
    id: typeof m.id === 'string' ? m.id : undefined, tick: m.tick, name: typeof m.name === 'string' ? m.name : undefined
  })).sort((a, b) => a.tick - b.tick);
  // duplicate ids would make edits hit the wrong item: give repeats fresh ids
  uniqueIds(p.playlist.tracks, 'trk');
  uniqueIds(p.playlist.clips, 'clip');
  uniqueIds(p.automations, 'auto');
  uniqueIds(p.markers, 'mk');
  uniqueIds(p.mixer, 'mx');
  for (const m of p.mixer) uniqueIds(m.effects, 'fx');
  for (const pt of p.patterns) for (const list of Object.values(pt.notes)) uniqueIds(list, 'n');
  const patternIds = new Set(p.patterns.map((x) => x.id));
  const autoIds = new Set(p.automations.map((x) => x.id));
  p.playlist.clips = p.playlist.clips.filter((c) => (c.kind === 'pattern' ? patternIds.has(c.refId) : c.kind === 'automation' ? autoIds.has(c.refId) : true)
    && c.track < p.playlist.tracks.length);
  p.spatial = normalizeProjectSpatial(raw.spatial);
  p.rev = Math.max(0, Math.round(num(raw.rev, 0)));
  return p;
}

function uniqueIds(list, prefix) {
  const seen = new Set();
  for (const item of list) {
    if (!item.id || seen.has(item.id)) item.id = uid(prefix);
    seen.add(item.id);
  }
}

/** "c#", "Bb", "F#" -> canonical key name; null if invalid. */
export function normalizeKey(k) {
  const m = /^\s*([A-Ga-g])([#b♯♭]?)\s*$/.exec(String(k ?? ''));
  if (!m) return null;
  return m[1].toUpperCase() + (m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2]);
}

function validAutomationTarget(p, t) {
  if (!t || typeof t !== 'object') return false;
  if (t.type === 'master') return ['volume', 'pan'].includes(t.param);
  if (t.type === 'channel') return p.channels.some((c) => c.id === t.id) && ['volume', 'pan', 'filterCutoff', 'filterRes', 'pitch'].includes(t.param);
  if (t.type === 'mixer') {
    return Number.isInteger(t.index) && t.index >= 0 && t.index < p.mixer.length && (['volume', 'pan'].includes(t.param) || (t.index > 0 && !!SPATIAL_PARAMS[t.param]));
  }
  if (t.type === 'effect') {
    const fx = Number.isInteger(t.index) && p.mixer[t.index]?.effects.find((e) => e.id === t.effectId);
    if (fx?.type === 'plugin') return typeof fx.params[t.param] === 'number';
    return !!fx && !!EFFECTS[fx.type]?.params.find((x) => x.key === t.param && x.automatable);
  }
  return false;
}

/** Fix invalid output/send targets and break any routing cycles (in place). */
export function repairRouting(mixer) {
  mixer[0].output = 0;
  mixer[0].sends = [];
  for (let i = 1; i < mixer.length; i++) {
    const m = mixer[i];
    if (!(m.output >= 0 && m.output < mixer.length) || m.output === i) m.output = 0;
    m.sends = (m.sends || []).filter((s) => s.to >= 0 && s.to < mixer.length && s.to !== i);
  }
  // remove edges that participate in cycles: walk each insert's graph
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (from === 0 || seen.has(from)) return false;
    seen.add(from);
    const m = mixer[from];
    return [m.output, ...m.sends.map((s) => s.to)].some((t) => reaches(t, target, seen));
  };
  for (let i = 1; i < mixer.length; i++) {
    const m = mixer[i];
    if (m.output !== 0 && reaches(m.output, i)) m.output = 0;
    m.sends = m.sends.filter((s) => !reaches(s.to, i));
  }
}

export function sanitizeNote(nt) {
  const out = {
    id: nt.id ? String(nt.id) : uid('n'),
    key: Math.round(clamp(num(nt.key, 60), 0, 127)),
    start: Math.max(0, Math.round(num(nt.start, 0))),
    length: Math.max(1, Math.round(num(nt.length, STEP))),
    velocity: num(nt.velocity, 0.8, 0, 1)
  };
  if (nt.pan !== undefined && nt.pan !== 0) out.pan = num(nt.pan, 0, -1, 1);
  return out;
}

// ---------- lookups ----------

/** Resolve a reference: exact id, then name (case-insensitive), then a 0-based index. */
function lookup(list, ref, what) {
  if (ref === undefined || ref === null || ref === '') throw new Error(`Missing ${what}`);
  const s = String(ref).trim();
  const found = list.find((x) => x.id === s)
    || list.find((x) => x.name?.toLowerCase() === s.toLowerCase())
    || (/^\d+$/.test(s) ? list[Number(s)] : undefined);
  if (!found) throw new Error(`${what} "${ref}" not found. Available: ${list.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}`);
  return found;
}

/** Find a channel by id, exact name (case-insensitive) or 0-based index. */
export function findChannel(project, ref) { return lookup(project.channels, ref, 'Channel'); }
/** Find a pattern by id, exact name or 0-based index. */
export function findPattern(project, ref) { return lookup(project.patterns, ref, 'Pattern'); }
export function findAutomation(project, ref) { return lookup(project.automations, ref, 'Automation'); }

export function getPattern(project, id) { return project.patterns.find((p) => p.id === id) || null; }
export function getChannel(project, id) { return project.channels.find((c) => c.id === id) || null; }

/** Effective pattern length in ticks: explicit length, auto-extended to the bar containing the last note. */
export function patternLength(project, pattern) {
  if (!pattern) return ticksPerBar(project);
  const bar = ticksPerBar(project);
  let end = 0;
  for (const list of Object.values(pattern.notes || {})) for (const n of list) end = Math.max(end, n.start + n.length);
  // a note that ends exactly at the boundary shouldn't extend the pattern
  const contentLen = end > 0 ? Math.ceil((end - 1) / bar) * bar : 0;
  return Math.max(pattern.length || bar, contentLen, STEP);
}

export function songLength(project) {
  let end = 0;
  for (const c of project.playlist.clips) end = Math.max(end, c.start + c.length);
  return end;
}

export function nextFreeInsert(project) {
  const used = new Set(project.channels.map((c) => c.mixerTrack));
  for (let i = 1; i < project.mixer.length; i++) if (!used.has(i)) return i;
  return 0;
}
