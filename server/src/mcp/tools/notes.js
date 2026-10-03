// Patterns and notes: step sequencing, piano-roll notes, chords, basslines, melodies, rolls, editing.
import {
  STEP, ticksPerBar, uid, parseNote, noteName, findChannel, findPattern, patternLength, parseStepString, toTicks,
  chordProgressionNotes, bassFromChords, bassLineFromChords, VOICINGS, melodyFromString, melodyLength, quantizeNotes, humanizeNotes, legatoNotes, rollNotes,
  toStepString, isStepLike, CHORD_TYPES, COLORS, maxPatternLength, MAX_PATTERN_BARS, stepsPerBeat
} from '@greanteadawy/core';
import { z, ok, projectIdArg, unitArg, annotations as A, normVelocity, growPatternOp, assertFitsPattern, resolveChords, steps, barsOf, uniqueName, assertNameFree } from '../util.js';

const RATE_TICKS = { '1/8': 48, '1/12': 32, '1/16': 24, '1/24': 16, '1/32': 12, '1/48': 8, '1/64': 6 };
const velocityArg = z.number().min(0).max(127).optional().describe('0..1 (1 = full), or MIDI 2..127');
const replaceArg = z.boolean().optional().describe("Default true: first clear this channel's notes inside the range being written (the rest of the pattern is kept). false = add on top.");

/** Notes of a channel outside [lo, hi) — kept when a range is rewritten. */
const outside = (pt, channelId, lo, hi) => (pt.notes[channelId] || []).filter((n) => n.start < lo || n.start >= hi);

export function registerNoteTools({ tool, backend, load }) {
  // ---------------------------------------------------------------- patterns
  tool('create_pattern', {
    title: 'Create pattern',
    description: 'Create a new empty pattern (a reusable section of notes for any channels).',
    inputSchema: {
      projectId: projectIdArg,
      name: z.string().min(1).max(64),
      bars: z.number().min(0.25).max(64).optional().describe('Length in bars (default 1)'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
    },
    annotations: A.edit
  }, async ({ projectId, name, bars = 1, color }) => {
    const p = await load(projectId);
    const length = Math.min(Math.round(bars * ticksPerBar(p)), maxPatternLength(p));
    if (p.patterns.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`A pattern named "${name}" already exists`);
    // reuse the untouched default "Pattern 1" of a fresh project instead of leaving an empty pattern behind
    const blank = p.patterns.length === 1 && p.patterns[0].name === 'Pattern 1' && !Object.values(p.patterns[0].notes).some((l) => l.length)
      && !p.playlist.clips.some((c) => c.refId === p.patterns[0].id) ? p.patterns[0] : null;
    if (blank) {
      await backend.applyOps(p.id, [{ type: 'pattern/update', id: blank.id, patch: { name, length, ...(color && { color }) } }]);
      return ok(`Created pattern "${name}" [${blank.id}], ${bars} bar(s) = ${Math.round(length / STEP)} steps.`);
    }
    const id = uid('pat');
    await backend.applyOps(p.id, [{ type: 'pattern/add', pattern: { id, name, length, color: color || COLORS[(p.patterns.length * 5) % COLORS.length] } }]);
    return ok(`Created pattern "${name}" [${id}], ${bars} bar(s) = ${Math.round(length / STEP)} steps.`);
  });

  tool('update_pattern', {
    title: 'Update pattern',
    description: 'Rename, recolor or resize a pattern. Shrinking below existing notes needs trimNotes=true (those notes are deleted).',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string().describe('Pattern id or name'),
      name: z.string().min(1).max(64).optional(),
      bars: z.number().min(0.25).max(64).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      trimNotes: z.boolean().optional().describe('When shrinking: delete notes that start after the new end')
    },
    annotations: A.edit
  }, async ({ projectId, pattern, name, bars, color, trimNotes = false }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    const patch = {};
    const ops = [];
    if (name) {
      assertNameFree(p.patterns, name, 'pattern', pt);
      patch.name = name;
    }
    if (color) patch.color = color;
    if (bars) {
      patch.length = Math.round(bars * ticksPerBar(p));
      const beyond = Object.entries(pt.notes).map(([cid, list]) => [cid, list.filter((n) => n.start >= patch.length)]).filter(([, l]) => l.length);
      const count = beyond.reduce((s, [, l]) => s + l.length, 0);
      if (count && !trimNotes) throw new Error(`${count} note(s) start in bar ${Math.floor(bars) + 1} or later, so the pattern would stay longer. Pass trimNotes=true to delete them, or move them first.`);
      for (const [cid, list] of beyond) ops.push({ type: 'notes/remove', patternId: pt.id, channelId: cid, ids: list.map((n) => n.id) });
    }
    if (!Object.keys(patch).length) throw new Error('Nothing to change');
    ops.push({ type: 'pattern/update', id: pt.id, patch });
    await backend.applyOps(p.id, ops);
    const trimmed = ops.length > 1 ? ` Deleted ${ops.slice(0, -1).reduce((s, o) => s + o.ids.length, 0)} note(s) past the new end.` : '';
    return ok(`Updated pattern "${name || pt.name}"${bars ? ` (${bars} bar${bars === 1 ? '' : 's'})` : ''}.${trimmed}`);
  });

  tool('duplicate_pattern', {
    title: 'Duplicate pattern',
    description: "Copy a pattern (all channels' notes) to a new pattern — for variations (e.g. \"Drums B\" with a fill).",
    inputSchema: { projectId: projectIdArg, pattern: z.string(), name: z.string().min(1).max(64).optional() },
    annotations: A.edit
  }, async ({ projectId, pattern, name }) => {
    const p = await load(projectId);
    const src = findPattern(p, pattern);
    const id = uid('pat');
    const notes = {};
    for (const [cid, list] of Object.entries(src.notes)) notes[cid] = list.map((n) => ({ ...n, id: uid('n') }));
    if (name) assertNameFree(p.patterns, name, 'pattern');
    const newName = name || uniqueName(p.patterns, `${src.name} 2`);
    await backend.applyOps(p.id, [{ type: 'pattern/add', index: p.patterns.indexOf(src) + 1, pattern: { id, name: newName, color: src.color, length: src.length, notes } }]);
    return ok(`Duplicated "${src.name}" as "${newName}" [${id}].`);
  });

  tool('delete_pattern', {
    title: 'Delete pattern',
    description: 'Delete a pattern and its playlist clips.',
    inputSchema: { projectId: projectIdArg, pattern: z.string() },
    annotations: A.destructive
  }, async ({ projectId, pattern }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    await backend.applyOps(p.id, [{ type: 'pattern/remove', id: pt.id }]);
    return ok(`Deleted pattern "${pt.name}".`);
  });

  tool('get_pattern', {
    title: 'Get pattern',
    description: 'Detailed view of one pattern: per channel a step grid (drums) and the full note list with note ids, names, start/length in steps and velocity — use the ids with update_notes / delete_notes.',
    inputSchema: { projectId: projectIdArg, pattern: z.string(), channel: z.string().optional().describe('Only this channel') },
    annotations: A.readOnly
  }, async ({ projectId, pattern, channel }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    const len = patternLength(p, pt);
    const chans = channel ? [findChannel(p, channel)] : p.channels.filter((c) => pt.notes[c.id]?.length);
    const lines = [`Pattern "${pt.name}" [${pt.id}] — ${steps(len)} steps (${Math.round((len / ticksPerBar(p)) * 100) / 100} bars)`];
    for (const c of chans) {
      const list = pt.notes[c.id] || [];
      lines.push(`\n${c.name} [${c.id}] — ${list.length} notes`);
      if (list.length && isStepLike(list)) lines.push(`  steps: ${toStepString(list, Math.round(len / STEP), { barSteps: Math.round(ticksPerBar(p) / STEP), group: stepsPerBeat(p) })}`);
      for (const n of list) lines.push(`  ${n.id}  ${noteName(n.key).padEnd(4)} start ${steps(n.start)}  len ${steps(n.length)}  vel ${Math.round(n.velocity * 100) / 100}${n.pan ? `  pan ${n.pan}` : ''}`);
    }
    return ok(lines.join('\n'));
  });

  // ---------------------------------------------------------------- writing notes
  tool('write_drums', {
    title: 'Write drum steps',
    description: 'Program the step sequencer for one or more channels in a pattern using step strings ("x---x---x---x---"). One character per 16th step: x hit, X accent, o ghost, 1-9 velocity, - or . rest; spaces and | are ignored. Replaces those channels\' notes in the pattern (mode "merge" adds instead). Steps per bar follow the time signature (16 in 4/4, 12 in 3/4 or 6/8); a longer string extends the pattern.',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string().describe('Pattern id or name'),
      tracks: z.record(z.string(), z.string().max(8192)).describe('Map of channel name/id -> step string, e.g. {"Kick":"x---x---x---x---","Snare":"----x-------x---"}'),
      mode: z.enum(['replace', 'merge']).optional(),
      note: z.union([z.string(), z.number()]).optional().describe("Note to trigger (default: each channel's step note). Use other notes to pitch drums.")
    },
    annotations: A.edit
  }, async ({ projectId, pattern, tracks, mode = 'replace', note }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    if (!Object.keys(tracks).length) throw new Error('tracks is empty — pass e.g. {"Kick":"x---x---x---x---","Hat":"x-x-x-x-x-x-x-x-"}');
    const ops = [];
    let maxSteps = 0;
    const report = [];
    const seen = new Map();
    for (const [ref, str] of Object.entries(tracks)) {
      const ch = findChannel(p, ref);
      if (seen.has(ch.id)) throw new Error(`"${ref}" and "${seen.get(ch.id)}" are the same channel — give each channel once`);
      seen.set(ch.id, ref);
      const { hits, steps: count } = parseStepString(str);
      maxSteps = Math.max(maxSteps, count);
      const key = note !== undefined ? parseNote(note) : ch.rootKey;
      const notes = hits.map((h) => ({ id: uid('n'), key, start: h.step * STEP, length: STEP, velocity: h.velocity }));
      ops.push({ type: mode === 'merge' ? 'notes/add' : 'notes/set', patternId: pt.id, channelId: ch.id, notes });
      report.push(`${ch.name}: ${hits.length} hits`);
    }
    const grow = growPatternOp(p, pt, maxSteps * STEP);
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    return ok(`Pattern "${pt.name}": ${report.join(', ')}.`);
  });

  const noteSchema = z.object({
    note: z.union([z.string(), z.number()]).describe('Note name (C4, F#3) or MIDI number'),
    start: z.number().min(0).describe('Start position (default unit: steps from pattern start)'),
    length: z.number().positive().optional().describe('Length (default 1 step)'),
    velocity: velocityArg,
    pan: z.number().min(-1).max(1).optional().describe('Per-note pan')
  });

  tool('add_notes', {
    title: 'Add notes (piano roll)',
    description: 'Write notes into a channel of a pattern (piano roll). Positions/lengths default to 16th-note steps. replace=true clears that channel in the pattern first. Notes past the pattern end extend the pattern.',
    inputSchema: { projectId: projectIdArg, pattern: z.string(), channel: z.string(), notes: z.array(noteSchema).min(1).max(2000), unit: unitArg, replace: z.boolean().optional() },
    annotations: A.edit
  }, async ({ projectId, pattern, channel, notes, unit = 'steps', replace = false }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    const ch = findChannel(p, channel);
    const defLen = { steps: 1, beats: 0.25, bars: 1 / 16, ticks: STEP }[unit];
    const list = notes.map((n) => ({
      id: uid('n'),
      key: parseNote(n.note),
      start: toTicks(n.start, unit, p),
      length: Math.max(1, toTicks(n.length ?? defLen, unit, p)),
      velocity: normVelocity(n.velocity),
      ...(n.pan ? { pan: n.pan } : {})
    }));
    const ops = [{ type: replace ? 'notes/set' : 'notes/add', patternId: pt.id, channelId: ch.id, notes: list }];
    const grow = growPatternOp(p, pt, Math.max(...list.map((n) => n.start + n.length)));
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    return ok(`${replace ? 'Wrote' : 'Added'} ${list.length} notes to "${ch.name}" in "${pt.name}" (${list.slice(0, 8).map((n) => noteName(n.key)).join(' ')}${list.length > 8 ? ' …' : ''}).`);
  });

  tool('write_melody', {
    title: 'Write melody',
    description: 'Write a monophonic line from a compact string: "C5:2 D5:2 Eb5:4 -:2 G5:6" — each token is note:lengthInSteps ("-" rest; suffix "!" = accent, "~" = slide: the note runs into the next one, so mono instruments with glide (808, bass, sitar, bansuri, erhu, shakuhachi…) slide there, e.g. "C4:4~ Db4:2"). Notes are placed back-to-back from `start`.',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      channel: z.string(),
      melody: z.string().min(1).max(20000),
      start: z.number().min(0).optional().describe('Start step (default 0)'),
      velocity: velocityArg,
      gate: z.number().min(0.1).max(1).optional().describe('Note length fraction (default 0.95; lower = staccato)'),
      replace: replaceArg
    },
    annotations: A.edit
  }, async ({ projectId, pattern, channel, melody, start = 0, velocity, gate = 0.95, replace = true }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    const ch = findChannel(p, channel);
    const lo = Math.round(start * STEP);
    const span = melodyLength(melody);
    assertFitsPattern(p, pt, lo + span);
    const notes = melodyFromString(melody, { start: lo, velocity: normVelocity(velocity), gate });
    const end = notes.reduce((m, n) => Math.max(m, n.start + n.length), lo);
    const ops = [replace
      ? { type: 'notes/set', patternId: pt.id, channelId: ch.id, notes: [...outside(pt, ch.id, lo, lo + span), ...notes] }
      : { type: 'notes/add', patternId: pt.id, channelId: ch.id, notes }];
    const grow = growPatternOp(p, pt, end);
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    return ok(`Wrote ${notes.length} notes to "${ch.name}" in "${pt.name}" (ends at step ${Math.round(end / STEP)}).`);
  });

  tool('add_chords', {
    title: 'Add chord progression',
    description: `Write a chord progression into a channel. Chord symbols (Am, F, Cmaj7, G7, Dm9, Esus4, Bdim, C/E) or roman numerals in the project key (i, VI, bVII, V7, ii°); "-" = rest. Qualities: ${Object.keys(CHORD_TYPES).filter(Boolean).join(' ')}. Chords are voice-led smoothly around a register. Styles: block (sustained), rhythm (hit on each x of a step string), arp-up, arp-down, arp-updown, broken. Voicings: close (default), open (wider pads), drop2 (jazz/neo-soul keys), drop3, spread (cinematic: root low, tones opened up), shell (root-3rd-7th: lo-fi/jazz comping), rootless (no root + 9th: modern keys over a bassline).`,
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      channel: z.string(),
      chords: z.array(z.string()).min(1).max(256),
      stepsPerChord: z.number().min(1).max(1024).optional().describe('Default 16 (one bar per chord)'),
      octave: z.number().int().min(0).max(8).optional().describe('Octave of the first chord root (default 4)'),
      style: z.enum(['block', 'rhythm', 'arp-up', 'arp-down', 'arp-updown', 'broken']).optional(),
      voicing: z.enum(VOICINGS).optional().describe('How the chord tones are spread (default close)'),
      inversion: z.number().int().min(0).max(4).optional().describe('Inversion of the first chord (the rest are voice-led from it); default 0'),
      register: z.union([z.string(), z.number()]).optional().describe('Center pitch the voicings stay around, e.g. "E4" for mid keys, "C5" for airy pads (default: the first chord at octave)'),
      rhythm: z.string().max(4096).optional().describe('For style=rhythm: step string restarted every chord, e.g. "x--x--x-"'),
      arpRate: z.number().min(0.25).optional().describe('For arp styles: steps per arp note (default 2 = 8th notes)'),
      velocity: velocityArg,
      gate: z.number().min(0.1).max(1).optional(),
      start: z.number().min(0).optional().describe('Start step (default 0)'),
      replace: replaceArg
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const spc = a.stepsPerChord ?? 16;
    const chords = resolveChords(a.chords, p);
    const lo = Math.round((a.start || 0) * STEP);
    const hi = lo + Math.round(chords.length * spc * STEP);
    assertFitsPattern(p, pt, hi);
    // a rhythm or arp rate implies its style when no style is given
    const style = a.style || (a.rhythm ? 'rhythm' : a.arpRate ? 'arp-up' : 'block');
    const ignored = [a.rhythm && style !== 'rhythm' && 'rhythm', a.arpRate && !style.startsWith('arp') && 'arpRate'].filter(Boolean);
    const notes = chordProgressionNotes(chords, {
      start: lo, chordLength: spc * STEP, octave: a.octave ?? 4, style,
      rhythm: a.rhythm, rate: (a.arpRate ?? 2) * STEP, velocity: normVelocity(a.velocity, 0.75), gate: a.gate ?? (style === 'block' ? 1 : 0.9),
      voicing: a.voicing || 'close', inversion: a.inversion || 0, center: a.register !== undefined ? parseNote(a.register) : null
    });
    const ops = [a.replace === false
      ? { type: 'notes/add', patternId: pt.id, channelId: ch.id, notes }
      : { type: 'notes/set', patternId: pt.id, channelId: ch.id, notes: [...outside(pt, ch.id, lo, hi), ...notes] }];
    const grow = growPatternOp(p, pt, hi);
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    return ok(`Wrote ${chords.join(' – ')} (${notes.length} notes, ${style}${a.voicing && a.voicing !== 'close' ? `, ${a.voicing} voicing` : ''}) to "${ch.name}" in "${pt.name}".${ignored.length ? ` Note: ${ignored.join(' and ')} ignored with style "${style}".` : ''}`);
  });

  tool('add_bassline', {
    title: 'Add bassline from chords',
    description: 'Generate a bassline that follows the chords. Either a rhythm (step string of root hits, restarted each chord) or a line in degrees, restarted each chord: "degree:steps" tokens — R (root / slash bass), 3 5 7 (the chord\'s own), 8 (octave), b7, 9, -5 (fifth below), -8 (root an octave down); "-" rest, "~:2" tie; suffix ! accent, ? ghost, ~ slide into the next note (808 glide). e.g. trap 808 "R:6 R:2~ 8:2 -:2 5:4", house "-:2 R:2 -:2 R:2 -:2 8:2 -:2 R:2", boom bap "R:3 R:3 -:2 5:2 -:2 b7:4". Roots stay in one register. Accepts roman numerals like add_chords.',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      channel: z.string(),
      chords: z.array(z.string()).min(1).max(256),
      stepsPerChord: z.number().min(1).max(1024).optional().describe('Default 16'),
      octave: z.number().int().min(0).max(6).optional().describe('Default 2 (808s often sound best around C1–C2)'),
      rhythm: z.string().max(4096).optional().describe('Root-note rhythm (step string), default "x-------x-------"'),
      line: z.string().max(4096).optional().describe('Degree line instead of rhythm, e.g. "R:3 R:1 -:2 5:2 R:2~ 8:4 b7:2" (see description)'),
      gate: z.number().min(0.1).max(1).optional(),
      velocity: velocityArg,
      start: z.number().min(0).optional().describe('Start step (default 0)'),
      replace: replaceArg
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const spc = a.stepsPerChord ?? 16;
    const chords = resolveChords(a.chords, p);
    const lo = Math.round((a.start || 0) * STEP);
    const hi = lo + Math.round(chords.length * spc * STEP);
    if (a.line && a.rhythm) throw new Error('Give either rhythm or line, not both');
    assertFitsPattern(p, pt, hi);
    const opts = { start: lo, chordLength: spc * STEP, octave: a.octave ?? 2, gate: a.gate ?? 0.9, velocity: normVelocity(a.velocity, 0.85) };
    const notes = a.line ? bassLineFromChords(chords, a.line, opts) : bassFromChords(chords, { ...opts, rhythm: a.rhythm || 'x-------x-------' });
    if (!notes.length) throw new Error(`That ${a.line ? 'line has no notes' : 'rhythm has no hits ("x")'}, so the bassline would be empty`);
    const ops = [a.replace === false
      ? { type: 'notes/add', patternId: pt.id, channelId: ch.id, notes }
      : { type: 'notes/set', patternId: pt.id, channelId: ch.id, notes: [...outside(pt, ch.id, lo, hi), ...notes] }];
    const grow = growPatternOp(p, pt, hi);
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    return ok(`Wrote a ${notes.length}-note bassline for ${chords.join(' – ')} to "${ch.name}" in "${pt.name}".`);
  });

  tool('add_roll', {
    title: 'Add roll / stutter',
    description: 'Add a fast repeated-note roll (trap hi-hat rolls, snare build-ups, stutters) with a velocity ramp. Adds to existing notes.',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      channel: z.string(),
      start: z.number().min(0).describe('Start step'),
      length: z.number().positive().max(2048).describe('Length in steps'),
      rate: z.enum(Object.keys(RATE_TICKS)).optional().describe('Note spacing: 1/32 (default), 1/24 (triplet 16ths), 1/48, 1/64, 1/16, 1/12...'),
      note: z.union([z.string(), z.number()]).optional().describe('Default: the channel step note'),
      velocityFrom: z.number().min(0).max(1).optional().describe('Default 0.45'),
      velocityTo: z.number().min(0).max(1).optional().describe('Default 0.9'),
      pitchRamp: z.number().int().min(-24).max(24).optional().describe('Semitones to glide over the roll (e.g. 12 for a rising snare roll)')
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const pt = findPattern(p, a.pattern);
    const ch = findChannel(p, a.channel);
    const span = Math.round(a.length * STEP);
    assertFitsPattern(p, pt, Math.round(a.start * STEP) + span);
    const dt = RATE_TICKS[a.rate || '1/32'];
    const count = Math.max(1, Math.round(span / dt));
    const key = a.note !== undefined ? parseNote(a.note) : ch.rootKey;
    let notes = rollNotes({ start: Math.round(a.start * STEP), span, count, key, from: a.velocityFrom ?? 0.45, to: a.velocityTo ?? 0.9 });
    if (a.pitchRamp) notes = notes.map((n, i) => ({ ...n, key: Math.max(0, Math.min(127, key + Math.round((a.pitchRamp * i) / Math.max(1, count - 1)))) }));
    const ops = [{ type: 'notes/add', patternId: pt.id, channelId: ch.id, notes }];
    const grow = growPatternOp(p, pt, Math.round(a.start * STEP) + span);
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    return ok(`Added a ${count}-hit ${a.rate || '1/32'} roll to "${ch.name}" at step ${a.start} in "${pt.name}".`);
  });

  tool('copy_notes', {
    title: 'Copy notes',
    description: "Copy a channel's notes from one pattern to another pattern and/or channel (optionally transposed or shifted) — e.g. double a melody on a second synth, or reuse a bassline in a new section.",
    inputSchema: {
      projectId: projectIdArg,
      fromPattern: z.string(),
      fromChannel: z.string(),
      toPattern: z.string().optional().describe('Default: same pattern'),
      toChannel: z.string().optional().describe('Default: same channel'),
      transpose: z.number().int().min(-48).max(48).optional(),
      offsetSteps: z.number().optional(),
      replace: z.boolean().optional().describe('Clear the destination first (default false)')
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const src = findPattern(p, a.fromPattern);
    const sch = findChannel(p, a.fromChannel);
    const dst = a.toPattern ? findPattern(p, a.toPattern) : src;
    const dch = a.toChannel ? findChannel(p, a.toChannel) : sch;
    if (dst.id === src.id && dch.id === sch.id && !a.transpose && !a.offsetSteps) throw new Error('Source and destination are identical');
    const off = Math.round((a.offsetSteps || 0) * STEP);
    const notes = (src.notes[sch.id] || [])
      .map((n) => ({ ...n, id: uid('n'), key: n.key + (a.transpose || 0), start: n.start + off }))
      .filter((n) => n.start >= 0 && n.key >= 0 && n.key <= 127);
    if (!notes.length) throw new Error(`"${sch.name}" has no notes in "${src.name}"`);
    const ops = [{ type: a.replace ? 'notes/set' : 'notes/add', patternId: dst.id, channelId: dch.id, notes }];
    const grow = growPatternOp(p, dst, Math.max(...notes.map((n) => n.start + n.length)));
    if (grow) ops.unshift(grow);
    await backend.applyOps(p.id, ops);
    return ok(`Copied ${notes.length} notes from ${sch.name}/${src.name} to ${dch.name}/${dst.name}.`);
  });

  // ---------------------------------------------------------------- editing notes
  tool('update_notes', {
    title: 'Update notes',
    description: 'Edit individual notes by id (from get_pattern): change pitch, position, length, velocity or pan.',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      channel: z.string(),
      notes: z.array(z.object({
        id: z.string(),
        note: z.union([z.string(), z.number()]).optional(),
        start: z.number().min(0).optional(),
        length: z.number().positive().optional(),
        velocity: z.number().min(0).max(127).optional(),
        pan: z.number().min(-1).max(1).optional()
      })).min(1).max(2000),
      unit: unitArg
    },
    annotations: A.edit
  }, async ({ projectId, pattern, channel, notes, unit = 'steps' }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    const ch = findChannel(p, channel);
    const existing = new Map((pt.notes[ch.id] || []).map((n) => [n.id, n]));
    const missing = notes.filter((n) => !existing.has(n.id)).map((n) => n.id);
    if (missing.length) throw new Error(`Unknown note id(s): ${missing.slice(0, 5).join(', ')} (use get_pattern for ids)`);
    const upd = notes.map((n) => ({
      id: n.id,
      ...(n.note !== undefined && { key: parseNote(n.note) }),
      ...(n.start !== undefined && { start: toTicks(n.start, unit, p) }),
      ...(n.length !== undefined && { length: Math.max(1, toTicks(n.length, unit, p)) }),
      ...(n.velocity !== undefined && { velocity: normVelocity(n.velocity) }),
      ...(n.pan !== undefined && { pan: n.pan })
    }));
    await backend.applyOps(p.id, [{ type: 'notes/update', patternId: pt.id, channelId: ch.id, notes: upd }]);
    return ok(`Updated ${upd.length} note(s) of "${ch.name}" in "${pt.name}".`);
  });

  tool('delete_notes', {
    title: 'Delete notes',
    description: 'Delete notes of a channel in a pattern by id, and/or by a step range and/or pitch.',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      channel: z.string(),
      ids: z.array(z.string()).optional(),
      fromStep: z.number().min(0).optional(),
      toStep: z.number().min(0).optional().describe('Exclusive end step'),
      note: z.union([z.string(), z.number()]).optional()
    },
    annotations: A.destructive
  }, async ({ projectId, pattern, channel, ids, fromStep, toStep, note }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    const ch = findChannel(p, channel);
    const list = pt.notes[ch.id] || [];
    const key = note !== undefined ? parseNote(note) : null;
    const filtered = !ids && fromStep === undefined && toStep === undefined && key === null;
    if (filtered) throw new Error('Give ids, a step range or a note (use clear_notes to remove everything)');
    const idSet = ids ? new Set(ids) : null;
    const lo = fromStep !== undefined ? fromStep * STEP : -Infinity;
    const hi = toStep !== undefined ? toStep * STEP : Infinity;
    const del = list.filter((n) => (!idSet || idSet.has(n.id)) && n.start >= lo && n.start < hi && (key === null || n.key === key)).map((n) => n.id);
    if (!del.length) return ok('No notes matched.');
    await backend.applyOps(p.id, [{ type: 'notes/remove', patternId: pt.id, channelId: ch.id, ids: del }]);
    return ok(`Deleted ${del.length} note(s) from "${ch.name}" in "${pt.name}".`);
  });

  tool('clear_notes', {
    title: 'Clear notes',
    description: 'Remove all notes of one channel (or every channel) from a pattern.',
    inputSchema: { projectId: projectIdArg, pattern: z.string(), channel: z.string().optional().describe('Omit to clear the whole pattern') },
    annotations: A.destructive
  }, async ({ projectId, pattern, channel }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    const chans = channel ? [findChannel(p, channel)] : p.channels.filter((c) => pt.notes[c.id]?.length);
    if (!chans.length) return ok('Nothing to clear.');
    await backend.applyOps(p.id, chans.map((c) => ({ type: 'notes/remove', patternId: pt.id, channelId: c.id })));
    return ok(`Cleared ${chans.map((c) => c.name).join(', ')} in "${pt.name}".`);
  });

  tool('transform_notes', {
    title: 'Transform notes',
    description: 'Piano-roll tools on a channel in a pattern: transpose (amount = semitones, required), shift (amount = steps, negative = earlier; wraps around the pattern), quantize (amount = grid in steps, default 1), humanize (amount 0..1), legato, velocity (set all to amount: 0..1 or MIDI 2..127, required), randomize_velocity (amount 0..1 spread), double (makes the WHOLE pattern twice as long by repeating every channel, so nothing falls silent), reverse, stretch (amount = time factor, e.g. 2 = half speed, 0.5 = double speed; grows the pattern if needed, other channels unchanged), strum (amount = steps between chord notes).',
    inputSchema: {
      projectId: projectIdArg,
      pattern: z.string(),
      channel: z.string(),
      action: z.enum(['transpose', 'shift', 'quantize', 'humanize', 'legato', 'velocity', 'randomize_velocity', 'double', 'reverse', 'stretch', 'strum']),
      amount: z.number().optional()
    },
    annotations: A.edit
  }, async ({ projectId, pattern, channel, action, amount }) => {
    const p = await load(projectId);
    const pt = findPattern(p, pattern);
    const ch = findChannel(p, channel);
    let notes = (pt.notes[ch.id] || []).map((n) => ({ ...n }));
    if (!notes.length) throw new Error(`"${ch.name}" has no notes in "${pt.name}"`);
    const len = patternLength(p, pt);
    const ops = [];
    if ((action === 'transpose' || action === 'velocity') && amount === undefined) throw new Error(`${action} needs an amount`);
    switch (action) {
      case 'transpose': {
        const d = Math.round(amount);
        const keys = notes.map((n) => n.key + d);
        if (Math.min(...keys) < 0 || Math.max(...keys) > 127) throw new Error(`Transposing by ${d} would push notes outside the MIDI range (C-1..G9)`);
        notes = notes.map((n, i) => ({ ...n, key: keys[i] }));
        break;
      }
      case 'shift': {
        const d = Math.round((amount ?? 1) * STEP);
        notes = notes.map((n) => ({ ...n, start: (((n.start + d) % len) + len) % len }));
        break;
      }
      case 'quantize': notes = quantizeNotes(notes, Math.max(1, Math.round((amount ?? 1) * STEP))); break;
      case 'humanize': notes = humanizeNotes(notes, { timing: 6 * (amount ?? 0.5), velocity: 0.2 * (amount ?? 0.5) }); break;
      case 'legato': notes = legatoNotes(notes); break;
      case 'velocity': notes = notes.map((n) => ({ ...n, velocity: normVelocity(amount, 0.8) })); break;
      case 'randomize_velocity': notes = notes.map((n) => ({ ...n, velocity: Math.max(0.05, Math.min(1, n.velocity + (Math.random() * 2 - 1) * (amount ?? 0.15))) })); break;
      case 'double': {
        if (len * 2 > maxPatternLength(p)) throw new Error(`The pattern can't be longer than ${MAX_PATTERN_BARS} bars`);
        ops.push({ type: 'pattern/update', id: pt.id, patch: { length: len * 2 } });
        for (const [cid, list] of Object.entries(pt.notes)) {
          if (cid === ch.id || !list.length) continue;
          ops.push({ type: 'notes/add', patternId: pt.id, channelId: cid, notes: list.map((n) => ({ ...n, id: uid('n'), start: n.start + len })) });
        }
        notes = [...notes, ...notes.map((n) => ({ ...n, id: uid('n'), start: n.start + len }))];
        break;
      }
      case 'reverse': notes = notes.map((n) => ({ ...n, start: Math.max(0, len - n.start - n.length) })); break;
      case 'stretch': {
        const f = amount ?? 2;
        if (!(f > 0.05 && f <= 16)) throw new Error('stretch amount must be between 0.05 and 16');
        notes = notes.map((n) => ({ ...n, start: Math.round(n.start * f), length: Math.max(1, Math.round(n.length * f)) }));
        const grow = growPatternOp(p, pt, Math.max(...notes.map((n) => n.start + n.length)));
        if (grow) ops.push(grow);
        break;
      }
      case 'strum': {
        const gap = Math.round((amount ?? 0.25) * STEP);
        const byStart = new Map();
        for (const n of notes) { if (!byStart.has(n.start)) byStart.set(n.start, []); byStart.get(n.start).push(n); }
        notes = [...byStart.values()].flatMap((group) => group.sort((x, y) => x.key - y.key).map((n, i) => ({ ...n, start: n.start + i * gap, length: Math.max(1, n.length - i * gap) })));
        break;
      }
      default:
    }
    // timing edits stay inside the loop: wrap starts, trim overhangs (a 1-tick overhang would add a silent bar)
    if (['shift', 'quantize', 'humanize', 'legato', 'strum'].includes(action)) {
      notes = notes.map((n) => {
        const start = ((n.start % len) + len) % len;
        return { ...n, start, length: Math.max(1, Math.min(n.length, len - start)) };
      });
    }
    ops.push({ type: 'notes/set', patternId: pt.id, channelId: ch.id, notes });
    await backend.applyOps(p.id, ops);
    const extra = action === 'double' ? ` The pattern is now ${barsOf(p, len * 2)} bars (every channel repeated).` : '';
    return ok(`Applied ${action}${amount !== undefined ? ` (${amount})` : ''} to ${notes.length} notes of "${ch.name}" in "${pt.name}".${extra}`);
  });
}
