// Production helpers that do in one call what a producer does by hand: transitions (risers, swells, impacts,
// snare builds), drum fills and groove/feel presets. They only build ordinary channels, patterns, clips and
// automation, so everything they make can be edited afterwards like anything else.
import {
  STEP, PPQ, ticksPerBar, uid, findPattern, patternLength, parsePitchClass, MAX_TRACKS, maxPatternLength, SCALES
} from '@greanteadawy/core';
import { z, ok, projectIdArg, annotations as A, uniqueName } from '../util.js';

// ------------------------------------------------------------------ channel roles

/** What a channel does in a beat, from its instrument and name (samplers have only their name to go on). */
export function roleOf(ch) {
  const kind = ch.instrument.kind;
  // the instrument decides; names only matter for samplers and synths
  if (kind === 'kick') return 'kick';
  if (['snare', 'clap', 'rim'].includes(kind)) return 'snare';
  if (kind === 'hat' || kind === 'shaker') return 'hat';
  if (kind === 'cymbal') return 'cymbal';
  if (['perc', 'tom', 'cowbell'].includes(kind)) return 'perc';
  if (kind === 'bass808' || kind === 'bass') return 'bass';
  // names like "Snare_Tight", "HH_Closed", "OpenHat_03", "808_Sub": split into letter/number words, so "Phat Bass"
  // isn't a hat and "Primary" isn't a rim
  const name = ch.name.toLowerCase();
  const words = name.split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/).filter(Boolean);
  const has = (...xs) => words.some((w) => xs.includes(w));
  if (has('kick', 'kicks', 'bd', 'kik') || /bass ?drum/.test(name)) return 'kick';
  if (has('snare', 'snares', 'snr', 'clap', 'claps', 'clp', 'rim', 'rimshot')) return 'snare';
  if (has('hh', 'hihat', 'hihats', 'hats', 'hat', 'openhat', 'closedhat', 'openhats', 'closedhats', 'ophat', 'clhat', 'pedalhat', 'shaker', 'ride')
    || /^(oh|ch)$/.test(words.join(''))) return 'hat';
  if (has('crash', 'cymbal', 'splash')) return 'cymbal';
  if (has('perc', 'percs', 'percussion', 'tom', 'toms', 'conga', 'bongo', 'tamb', 'tambourine', 'cowbell', 'shaker')) return 'perc';
  if (has('808', 'bass', 'sub', 'reese')) return 'bass';
  return 'other';
}

const DRUM_ROLES = new Set(['kick', 'snare', 'hat', 'cymbal', 'perc']);

/** The channel of a role that plays most in a pattern (or in the project), preferring `kinds` in that order. */
function channelFor(p, pattern, role, kinds = []) {
  const candidates = p.channels.filter((c) => roleOf(c) === role);
  const pref = (c) => { const i = kinds.indexOf(c.instrument.kind); return i < 0 ? 0 : kinds.length - i; };
  const score = (c) => (pattern?.notes[c.id]?.length || 0) * 10 + pref(c);
  return candidates.sort((a, b) => score(b) - score(a))[0] || null;
}

// ------------------------------------------------------------------ playlist helpers

/** A track named `name` (reused), or the first empty track (renamed). Returns { index, ops }. */
function namedTrack(p, name, claimed = new Set(), trackCount = p.playlist.tracks.length) {
  const existing = p.playlist.tracks.findIndex((t) => t.name === name);
  if (existing >= 0 && !claimed.has(existing)) return { index: existing, ops: [] };
  const used = new Set([...p.playlist.clips.map((c) => c.track), ...claimed]);
  let i = 0;
  while (used.has(i) && i < MAX_TRACKS - 1) i++;
  const ops = [];
  // trackCount: tracks that will exist by the time these ops run (earlier ops in the batch may add some)
  if (i >= trackCount) ops.push({ type: 'track/add', count: i - trackCount + 1 });
  ops.push({ type: 'track/update', index: i, patch: { name } });
  return { index: i, ops };
}

/** Reuse a channel with this name and instrument, or create it (returns { channel, ops, created }). */
function ensureChannel(p, { name, kind, preset, params, volume }) {
  const found = p.channels.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.instrument.kind === kind);
  if (found) {
    // keep its sound, but make length-dependent params (a swell's attack) match this use
    const ops = params ? [{ type: 'channel/update', id: found.id, patch: { instrument: { params } } }] : [];
    return { channel: found, ops, created: false };
  }
  const id = uid('ch');
  const channel = { id, name: uniqueName(p.channels, name), kind, preset, params, volume, mixerTrack: 'auto' };
  return { channel: { ...channel, instrument: { kind, preset } }, ops: [{ type: 'channel/add', nameInsert: true, channel }], created: true };
}

/** Reuse a pattern by exact name, or create it with `notes` ({ channelId: [...] }). */
function ensurePattern(p, name, length, notes) {
  const found = p.patterns.find((x) => x.name === name);
  if (found) {
    return { pattern: found, ops: Object.entries(notes).map(([channelId, list]) => ({ type: 'notes/set', patternId: found.id, channelId, notes: list })) };
  }
  const id = uid('pat');
  return { pattern: { id, name }, ops: [{ type: 'pattern/add', pattern: { id, name, length, notes } }] };
}

const n = (key, start, length, velocity) => ({ id: uid('n'), key, start: Math.round(start), length: Math.max(1, Math.round(length)), velocity: Math.min(1, Math.max(0.05, velocity)) });

/** Root of the project key as a MIDI note in `octave` (C4 = 60). */
const keyRoot = (p, octave) => (octave + 1) * 12 + (parsePitchClass(p.key) ?? 0);

// ------------------------------------------------------------------ transitions

const TRANSITIONS = {
  riser: { bars: 4, before: true, label: 'noise riser with a filter + volume sweep into the section' },
  downlifter: { bars: 2, before: false, label: 'falling noise sweep out of the hit' },
  reverse_swell: { bars: 1, before: true, label: 'reversed-style chord swell sucking into the downbeat' },
  snare_build: { bars: 2, before: true, label: 'accelerating, rising snare roll (8ths → 16ths → 32nds)' },
  crash: { bars: 1, before: false, label: 'crash cymbal on the downbeat' },
  sub_drop: { bars: 1, before: false, label: '808 sub drop (pitch dive) on the downbeat' },
  impact: { bars: 1, before: false, label: 'crash + sub drop together: the classic drop impact' }
};

// ------------------------------------------------------------------ groove presets

/**
 * Feel presets. swing = project swing (0.5 ≈ MPC 62%); nudge (ms) and swingMix per role — the consistent push/pull
 * that IS the feel; accents = velocity factor per 16th inside each beat (1, e, &, a), never below 0.75 (0.6 × 0.8 on
 * the squared velocity curve is already 8 dB down); humanize = small random timing (ms) and velocity variation on top.
 */
export const GROOVES = {
  straight: { label: 'quantized, no swing', swing: 0, nudge: {}, swingMix: {}, accents: {}, humanize: null },
  'boom-bap': { label: 'swung 16ths, lazy snare (90s hip-hop)', swing: 0.55, nudge: { snare: 14, hat: 4 }, swingMix: { kick: 0.7 }, accents: { hat: [1.1, 0.75, 0.9, 0.78] }, humanize: { timingMs: 4, velocity: 0.06 } },
  dilla: { label: 'drunk, behind-the-beat (Dilla / neo-soul)', swing: 0.4, nudge: { snare: 22, kick: -6, hat: 8, perc: 6 }, swingMix: { hat: 0.6 }, accents: { hat: [1.05, 0.75, 0.85, 0.75] }, humanize: { timingMs: 8, velocity: 0.08 } },
  'lo-fi': { label: 'heavy swing, everything relaxed (lo-fi / chillhop)', swing: 0.6, nudge: { snare: 18, hat: 6, bass: 10, other: 12 }, swingMix: {}, accents: { hat: [1.0, 0.75, 0.85, 0.75] }, humanize: { timingMs: 6, velocity: 0.08 } },
  trap: { label: 'straight, pushed hats with accents (trap)', swing: 0, nudge: { hat: -3, snare: 2 }, swingMix: {}, accents: { hat: [1.1, 0.78, 0.92, 0.78] }, humanize: { timingMs: 0, velocity: 0.05 } },
  drill: { label: 'straight, tight, hard accents (UK/NY drill)', swing: 0, nudge: { snare: 4, hat: -2 }, swingMix: {}, accents: { hat: [1.1, 0.8, 0.95, 0.8] }, humanize: { timingMs: 0, velocity: 0.05 } },
  house: { label: 'slight 16th swing, off-beat hat lift (house)', swing: 0.22, nudge: { snare: 4, hat: -2 }, swingMix: { kick: 0 }, accents: { hat: [0.8, 0.75, 1.1, 0.75] }, humanize: { timingMs: 3, velocity: 0.04 } },
  afrobeats: { label: 'rolling swing, forward percussion (afrobeats / amapiano)', swing: 0.35, nudge: { snare: 6, perc: -4 }, swingMix: {}, accents: { hat: [1.05, 0.78, 0.95, 0.8], perc: [1, 0.78, 0.9, 0.82] }, humanize: { timingMs: 4, velocity: 0.06 } }
};

export function registerProductionTools({ tool, backend, load }) {
  tool('add_transition', {
    title: 'Add a transition',
    description: `Build a transition into or out of a section in one call: ${Object.entries(TRANSITIONS).map(([k, t]) => `${k} (${t.label})`).join('; ')}. atBar is the 1-based bar where the new section starts (the downbeat): risers/swells/builds end exactly there, hits land on it. Creates (or reuses) the sound's channel, a pattern and its playlist clip on a "Transitions" track, plus filter/volume automation for sweeps. Typical: riser 4–8 bars + impact into a drop; snare_build 2 bars into a hook; reverse_swell 1 bar into a verse; downlifter after a drop.`,
    inputSchema: {
      projectId: projectIdArg,
      type: z.enum(Object.keys(TRANSITIONS)),
      atBar: z.number().int().min(1).describe('Bar where the section starts / the hit lands'),
      bars: z.number().positive().max(16).optional().describe('Length of sweeps/swells/builds (default: riser 4, downlifter 2, snare_build 2, reverse_swell 1)'),
      track: z.number().int().min(1).max(MAX_TRACKS).optional().describe('1-based playlist track (default: a track named "Transitions")')
    },
    annotations: A.edit
  }, async ({ projectId, type, atBar, bars, track }) => {
    const p = await load(projectId);
    const bar = ticksPerBar(p);
    const def = TRANSITIONS[type];
    const len = Math.round((bars ?? def.bars) * bar);
    const at = (atBar - 1) * bar;
    const start = def.before ? at - len : at;
    if (start < 0) throw new Error(`A ${bars ?? def.bars}-bar ${type} has to start before bar 1 to end at bar ${atBar}: use a later atBar or fewer bars`);
    if (len > maxPatternLength(p)) throw new Error('That transition is longer than a pattern can be');
    const ops = [];
    const made = [];
    const notes = {};
    const autos = [];

    const useChannel = (spec) => {
      const r = ensureChannel(p, spec);
      ops.push(...r.ops);
      if (r.created) made.push(`channel "${r.channel.name}" [${r.channel.id}]`);
      return r.channel;
    };

    switch (type) {
      case 'riser':
      case 'downlifter': {
        const ch = useChannel({ name: 'Riser', kind: 'synth', preset: 'Riser Noise', volume: 0.55 });
        notes[ch.id] = [n(72, 0, len, 0.8)];
        const up = type === 'riser';
        // cutoff 0.3 ≈ 160 Hz … 0.95 ≈ 14 kHz (log scale); the curve opens slowly then fast, like a real sweep
        const cutoff = up ? [{ t: 0, v: 0.3 }, { t: Math.round(len * 0.7), v: 0.62 }, { t: len, v: 0.95 }] : [{ t: 0, v: 0.95 }, { t: Math.round(len * 0.3), v: 0.62 }, { t: len, v: 0.25 }];
        // channel volume automation maps 0..1 to 0..1.25 (0.62 ≈ the default channel volume): the build ends ~3 dB
        // under unity, the noise is loud enough at that
        const volume = up ? [{ t: 0, v: 0.15 }, { t: len, v: 0.55 }] : [{ t: 0, v: 0.55 }, { t: len, v: 0.1 }];
        autos.push({ name: `${up ? 'Riser' : 'Downlifter'} sweep ${bars ?? def.bars} bars`, target: { type: 'channel', id: ch.id, param: 'filterCutoff' }, points: cutoff });
        autos.push({ name: `${up ? 'Riser' : 'Downlifter'} level ${bars ?? def.bars} bars`, target: { type: 'channel', id: ch.id, param: 'volume' }, points: volume });
        break;
      }
      case 'reverse_swell': {
        // the swell is shaped by volume automation (not the synth's attack), so swells of different lengths can
        // share the channel without changing each other's sound
        const ch = useChannel({ name: 'Swell', kind: 'synth', preset: 'Reverse Swell', volume: 0.6, params: { attack: 0.02 } });
        const root = keyRoot(p, 4);
        // the tonic chord of the project's scale: minor or major third, else sus2/sus4 (yo, in-sen); a perfect fifth,
        // else the scale's own (locrian, iwato)
        const steps = SCALES[p.scale] || SCALES.minor;
        const third = steps.includes(3) && !steps.includes(4) ? 3 : steps.includes(4) ? 4 : steps.includes(2) ? 2 : 5;
        const fifth = steps.includes(7) ? 7 : steps.includes(6) ? 6 : 8;
        notes[ch.id] = [root, root + third, root + fifth].map((k) => n(k, 0, len, 0.75));
        autos.push({ name: `Swell ${bars ?? def.bars} bar${(bars ?? def.bars) === 1 ? '' : 's'}`, target: { type: 'channel', id: ch.id, param: 'volume' }, points: [{ t: 0, v: 0 }, { t: Math.round(len * 0.6), v: 0.15 }, { t: Math.round(len * 0.9), v: 0.4 }, { t: len, v: 0.6 }] });
        break;
      }
      case 'snare_build': {
        const pt0 = p.patterns[0];
        const existing = channelFor(p, pt0, 'snare', ['snare', 'clap', 'rim']);
        const ch = existing || useChannel({ name: 'Build Snare', kind: 'snare', preset: 'Tight', volume: 0.7 });
        const list = [];
        const quarter = len / 4;
        // 8ths, then 16ths, then 32nds in the last quarter; velocity and pitch rise towards the drop
        const grid = (from, to, step) => { for (let t = from; t < to - 1; t += step) list.push(t); };
        grid(0, quarter * 2, STEP * 2);
        grid(quarter * 2, quarter * 3.5, STEP);
        grid(quarter * 3.5, len, STEP / 2);
        notes[ch.id] = list.map((t) => n(60 + Math.round((t / len) * 7), t, STEP / 2, 0.35 + 0.65 * (t / len)));
        break;
      }
      case 'crash': {
        const ch = useChannel({ name: 'Crash', kind: 'cymbal', preset: 'Crash', volume: 0.55 });
        notes[ch.id] = [n(60, 0, bar, 0.9)];
        break;
      }
      case 'sub_drop': {
        const ch = useChannel({ name: 'Sub Drop', kind: 'bass808', preset: 'Sub Drop', volume: 0.45 });
        notes[ch.id] = [n(keyRoot(p, 1), 0, bar, 0.8)]; // dives two octaves from C3 to the sub (C1 ≈ 33 Hz in C)
        break;
      }
      case 'impact': {
        const crash = useChannel({ name: 'Crash', kind: 'cymbal', preset: 'Crash', volume: 0.55 });
        const drop = useChannel({ name: 'Sub Drop', kind: 'bass808', preset: 'Sub Drop', volume: 0.45 });
        notes[crash.id] = [n(60, 0, bar, 0.95)];
        notes[drop.id] = [n(keyRoot(p, 1), 0, bar, 0.8)];
        break;
      }
      default:
        throw new Error(`Unknown transition ${type}`);
    }

    const label = { riser: 'Riser', downlifter: 'Downlifter', reverse_swell: 'Swell', snare_build: 'Snare Build', crash: 'Crash', sub_drop: 'Sub Drop', impact: 'Impact' }[type];
    const patName = def.before || type === 'downlifter' ? `${label} ${bars ?? def.bars} bar${(bars ?? def.bars) === 1 ? '' : 's'}` : label;
    const pat = ensurePattern(p, patName, Math.max(len, bar), notes);
    ops.push(...pat.ops);

    const claimed = new Set();
    let t = track ? track - 1 : null;
    if (t === null) {
      const r = namedTrack(p, 'Transitions');
      ops.push(...r.ops);
      t = r.index;
    } else if (t >= p.playlist.tracks.length) {
      ops.push({ type: 'track/add', count: t - p.playlist.tracks.length + 1 });
    }
    claimed.add(t); // the automation track must be a different one
    const trackCount = Math.max(p.playlist.tracks.length, t + 1);
    const clipId = uid('clip');
    ops.push({ type: 'clip/add', clips: [{ id: clipId, kind: 'pattern', refId: pat.pattern.id, track: t, start, length: len }] });

    if (autos.length) {
      const r = namedTrack(p, 'Transition FX', claimed, trackCount);
      ops.push(...r.ops);
      for (const a of autos) {
        const found = p.automations.find((x) => x.name === a.name && x.target.type === 'channel' && x.target.id === a.target.id && x.target.param === a.target.param);
        const id = found?.id || uid('auto');
        if (!found) ops.push({ type: 'automation/add', automation: { id, name: a.name, target: a.target, length: len, points: a.points } });
        ops.push({ type: 'clip/add', clips: [{ id: uid('clip'), kind: 'automation', refId: id, track: r.index, start, length: len }] });
      }
    }
    await backend.applyOps(p.id, ops);
    const where = def.before ? `bars ${Math.round((start / bar + 1) * 100) / 100}–${atBar} (ends on the downbeat of bar ${atBar})` : `bar ${atBar}`;
    return ok(`Added ${type.replace('_', ' ')} at ${where}: pattern "${patName}" [${pat.pattern.id}] on track ${t + 1}${autos.length ? `, with ${autos.length} automation clips` : ''}.${made.length ? ` Created ${made.join(', ')}.` : ''} Balance it on its mixer insert with set_mixer${autos.some((a) => a.target.param === 'volume') ? ' (its channel volume is automated, so update_channel volume has no effect)' : ''}; render_mix to check.`);
  });

  tool('add_fill', {
    title: 'Add a drum fill',
    description: 'Make a fill version of a drum pattern: copies the pattern (or edits it in place) and rewrites its last beats. Styles: snare_roll (16ths into 32nds, crescendo), tom_run (descending toms; creates a tom channel if needed), hat_roll (trap triplet/32nd hat rolls), stutter (kick+snare repeating 16ths), dropout (kick, bass and snares drop out — the gap before a drop), kick_build (EDM kick in 8ths then 16ths). Place the fill pattern at the last bar of a section (e.g. every 4th or 8th bar) instead of the main one.',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string().describe('The drum pattern to make a fill from'),
      style: z.enum(['snare_roll', 'tom_run', 'hat_roll', 'stutter', 'dropout', 'kick_build']),
      beats: z.number().min(0.5).max(8).optional().describe('How many beats at the end (default 1; 2 for tom_run and kick_build)'),
      name: z.string().min(1).max(64).optional().describe('Name of the new pattern (default "<pattern> Fill")'),
      inPlace: z.boolean().optional().describe('Rewrite the pattern itself instead of a copy (default false)')
    },
    annotations: A.edit
  }, async ({ projectId, pattern, style, beats, name, inPlace = false }) => {
    const p = await load(projectId);
    const src = findPattern(p, pattern);
    const P = patternLength(p, src);
    const span = Math.min(P, Math.round((beats ?? (['tom_run', 'kick_build'].includes(style) ? 2 : 1)) * PPQ));
    const lo = P - span;
    const ops = [];
    const created = [];
    const notes = Object.fromEntries(Object.entries(src.notes).map(([cid, list]) => [cid, list.map((x) => ({ ...x }))]));
    const clear = (chId) => { notes[chId] = (notes[chId] || []).filter((x) => x.start < lo); };
    const add = (chId, list) => { notes[chId] = [...(notes[chId] || []), ...list]; };
    const ramp = (i, count, from, to) => from + (to - from) * (count > 1 ? i / (count - 1) : 1);
    const need = (role, kinds, what) => {
      const ch = channelFor(p, src, role, kinds);
      if (!ch) throw new Error(`A ${style.replace('_', ' ')} needs a ${what} channel (none found by instrument or name)`);
      return ch;
    };
    const kick = channelFor(p, src, 'kick', ['kick']);
    switch (style) {
      case 'snare_roll': {
        const sn = need('snare', ['snare', 'clap', 'rim'], 'snare or clap');
        clear(sn.id);
        const times = [];
        const split = lo + Math.max(span - PPQ, span / 2);
        for (let t = lo; t < split; t += STEP) times.push(t);
        for (let t = split; t < P; t += STEP / 2) times.push(t);
        add(sn.id, times.map((t, i) => n(sn.rootKey ?? 60, t, STEP / 2, ramp(i, times.length, 0.45, 1))));
        break;
      }
      case 'tom_run': {
        let tom = p.channels.find((c) => c.instrument.kind === 'tom');
        if (!tom) {
          const id = uid('ch');
          ops.push({ type: 'channel/add', nameInsert: true, channel: { id, name: uniqueName(p.channels, 'Toms'), kind: 'tom', preset: 'Mid', mixerTrack: 'auto', volume: 0.7 } });
          tom = { id, name: 'Toms' };
          created.push(`channel "Toms" [${id}]`);
        }
        const sn = channelFor(p, src, 'snare', ['snare', 'clap']);
        if (sn) clear(sn.id);
        clear(tom.id);
        const keys = [67, 65, 62, 60, 57, 55, 53, 50];
        const times = [];
        for (let t = lo; t < P; t += STEP) times.push(t);
        add(tom.id, times.map((t, i) => n(keys[Math.floor((i / times.length) * keys.length)], t, STEP, ramp(i, times.length, 0.75, 0.95))));
        break;
      }
      case 'hat_roll': {
        const hat = need('hat', ['hat', 'shaker'], 'hi-hat');
        clear(hat.id);
        const list = [];
        for (let b = lo; b < P; b += PPQ) {
          const last = b + PPQ >= P;
          const step = last ? STEP / 2 : PPQ / 6; // 32nds on the last beat, 16th triplets before it
          for (let t = b; t < Math.min(P, b + PPQ); t += step) list.push(t);
        }
        add(hat.id, list.map((t, i) => n(hat.rootKey ?? 60, t, STEP / 2, ramp(i, list.length, 0.5, 0.95))));
        break;
      }
      case 'stutter': {
        const sn = channelFor(p, src, 'snare', ['snare', 'clap']);
        if (!kick && !sn) throw new Error('A stutter needs a kick or snare channel');
        const hat = channelFor(p, src, 'hat', ['hat']);
        if (hat) clear(hat.id);
        const times = [];
        for (let t = lo; t < P; t += STEP) times.push(t);
        for (const ch of [kick, sn].filter(Boolean)) {
          clear(ch.id);
          add(ch.id, times.map((t, i) => n(ch.rootKey ?? 60, t, STEP, ramp(i, times.length, 0.6, 1))));
        }
        break;
      }
      case 'dropout': {
        const gone = p.channels.filter((c) => ['kick', 'snare', 'bass'].includes(roleOf(c)) && notes[c.id]?.length);
        if (!gone.length) throw new Error('Nothing to drop out: no kick, snare or bass notes in this pattern');
        for (const c of gone) clear(c.id);
        break;
      }
      case 'kick_build': {
        if (!kick) throw new Error('A kick build needs a kick channel');
        clear(kick.id);
        const times = [];
        const half = lo + span / 2;
        for (let t = lo; t < half; t += STEP * 2) times.push(t);
        for (let t = half; t < P; t += STEP) times.push(t);
        add(kick.id, times.map((t, i) => n(kick.rootKey ?? 60, t, STEP, ramp(i, times.length, 0.7, 1))));
        break;
      }
      default:
        throw new Error(`Unknown fill style ${style}`);
    }
    for (const list of Object.values(notes)) list.sort((a, b) => a.start - b.start || a.key - b.key);
    let target = src;
    if (inPlace) {
      for (const [cid, list] of Object.entries(notes)) ops.push({ type: 'notes/set', patternId: src.id, channelId: cid, notes: list });
    } else {
      const newName = name || uniqueName(p.patterns, `${src.name} Fill`);
      if (p.patterns.some((x) => x.name.toLowerCase() === newName.toLowerCase())) throw new Error(`A pattern named "${newName}" already exists`);
      const id = uid('pat');
      target = { id, name: newName };
      ops.push({ type: 'pattern/add', index: p.patterns.indexOf(src) + 1, pattern: { id, name: newName, color: src.color, length: src.length, notes: Object.fromEntries(Object.entries(notes).map(([cid, list]) => [cid, list.map((x) => ({ ...x, id: uid('n') }))])) } });
    }
    await backend.applyOps(p.id, ops);
    const beatsTxt = Math.round((span / PPQ) * 100) / 100;
    return ok(`${inPlace ? 'Rewrote' : 'Created'} "${target.name}" [${target.id}]: ${style.replace('_', ' ')} over the last ${beatsTxt} beat${beatsTxt === 1 ? '' : 's'}.${created.length ? ` Created ${created.join(', ')}.` : ''}${inPlace ? '' : ` Use it on the last bar of a section in place of "${src.name}" (place_pattern / arrange_song).`}`);
  });

  tool('apply_groove', {
    title: 'Apply a groove / feel',
    description: `Give the beat a human feel in one call: sets the project swing, each channel's nudge (ms early/late) and swing share by role (kick, snare/clap, hats, percussion, bass, other), shapes hi-hat velocities with an accent pattern per beat and adds subtle humanizing (timing on drum hits, velocity on accented parts). Presets: ${Object.entries(GROOVES).map(([k, g]) => `${k} (${g.label})`).join('; ')}. amount scales the whole effect (0..1). Running it again re-applies cleanly (accents, velocity and timing are not stacked; triplets and rolls are left alone); "straight" re-quantizes.`,
    inputSchema: {
      projectId: projectIdArg,
      preset: z.enum(Object.keys(GROOVES)),
      amount: z.number().min(0).max(1).optional().describe('Strength (default 1)'),
      patterns: z.array(z.string()).optional().describe('Patterns whose notes get accents/humanizing (default: all). Swing and nudges are per channel and apply everywhere.'),
      humanize: z.boolean().optional().describe('Add timing/velocity variation (default true)'),
      ghostNotes: z.boolean().optional().describe('Also add quiet ghost snares on the classic off-beat 16ths where the snare is silent (default false)')
    },
    annotations: A.edit
  }, async ({ projectId, preset, amount = 1, patterns, humanize = true, ghostNotes = false }) => {
    const p = await load(projectId);
    const g = GROOVES[preset];
    const ops = [{ type: 'project/update', patch: { swing: Math.round(g.swing * amount * 100) / 100 } }];
    const changed = [];
    for (const c of p.channels) {
      const role = roleOf(c);
      const nudge = Math.round((g.nudge[role] ?? 0) * amount * 10) / 10;
      const swingMix = Math.round((1 - (1 - (g.swingMix[role] ?? 1)) * amount) * 100) / 100;
      if (nudge !== (c.nudge ?? 0) || swingMix !== (c.swingMix ?? 1)) {
        ops.push({ type: 'channel/update', id: c.id, patch: { nudge, swingMix } });
        if (nudge || swingMix !== 1) changed.push(`${c.name} ${nudge > 0 ? '+' : ''}${nudge}ms${swingMix !== 1 ? ` swing×${swingMix}` : ''}`);
      }
    }
    const targets = patterns?.length ? patterns.map((x) => findPattern(p, x)) : p.patterns;
    const jitter = (x) => (Math.random() * 2 - 1) * x;
    let touched = 0;
    for (const pt of targets) {
      for (const c of p.channels) {
        const list = pt.notes[c.id];
        const role = roleOf(c);
        if (!list?.length || !DRUM_ROLES.has(role) && role !== 'bass') continue;
        const accents = g.accents[role];
        const h = humanize && g.humanize && DRUM_ROLES.has(role) ? g.humanize : null;
        if (!accents && !h && preset !== 'straight') continue;
        const next = list.map((x) => {
          // "on the grid" = within 5 ticks (the largest humanize offset): 16th triplets (8 off), 1/64 rolls (6 off)
          // and 32nds stay put
          const onGrid = Math.abs(x.start - Math.round(x.start / STEP) * STEP) <= 5;
          const grid = Math.round(x.start / STEP) * STEP;
          let velocity = x.velocity;
          // accents shape "normal" hits from a fixed base level (so re-running doesn't stack); programmed accents
          // (≥ 0.95) and ghosts (< 0.6) keep their level and get no velocity jitter
          const shaped = accents && onGrid && x.velocity >= 0.6 && x.velocity < 0.95;
          if (shaped) {
            const f = accents[(grid / STEP) % 4];
            velocity = 0.8 * (1 + (f - 1) * amount);
          }
          let start = x.start;
          if (h) {
            if (shaped) velocity += jitter(h.velocity * amount);
            // jitter (ms → ticks at this tempo) around the grid position, so running it again doesn't drift notes
            const ticks = ((h.timingMs || 0) * amount * p.bpm * PPQ) / 60000;
            // whole ticks only (notes live on ticks): round stochastically, so a 4 ms jitter at ~7 ms per tick still
            // moves some notes by one tick instead of none; a preset without timing jitter re-quantizes
            if (onGrid && ticks > 0) start = Math.max(0, grid + Math.max(-5, Math.min(5, Math.floor(jitter(ticks) + Math.random()))));
            else if (onGrid) start = grid;
          } else if (preset === 'straight' && onGrid) {
            start = grid; // a straight feel re-quantizes earlier humanizing
          }
          // shaped hits stay "normal" (≥ 0.6), so a later preset can shape them again
          const floor = shaped ? 0.6 : 0.05;
          return { ...x, start, velocity: Math.round(Math.min(shaped ? 0.94 : 1, Math.max(floor, velocity)) * 1000) / 1000 };
        });
        if (ghostNotes && role === 'snare' && ['boom-bap', 'dilla', 'lo-fi', 'afrobeats'].includes(preset)) {
          const len = patternLength(p, pt);
          const barSteps = ticksPerBar(p) / STEP;
          for (let s = 0; s * STEP < len; s++) {
            if (![7, 9, 15].includes(s % barSteps)) continue;
            const t = s * STEP;
            if (next.some((x) => Math.abs(x.start - t) < STEP)) continue;
            next.push(n(c.rootKey ?? 60, t, STEP, 0.4 + jitter(0.05)));
          }
          next.sort((a, b) => a.start - b.start || a.key - b.key);
        }
        ops.push({ type: 'notes/set', patternId: pt.id, channelId: c.id, notes: next });
        touched++;
      }
    }
    await backend.applyOps(p.id, ops);
    return ok(`Applied the "${preset}" groove (${g.label}) at ${Math.round(amount * 100)}%: swing ${Math.round(g.swing * amount * 100)}%${changed.length ? `; ${changed.join(', ')}` : ''}; reshaped ${touched} drum/bass part(s) in ${targets.length} pattern(s)${ghostNotes ? ' with ghost snares' : ''}.`);
  });
}
