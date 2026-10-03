// Instruments, channels, sound preview and music theory helpers.
import {
  INSTRUMENTS, INSTRUMENT_KINDS, INSTRUMENT_CATEGORIES, makeInstrument, describeInstruments, describeEffects, uid, noteName,
  findChannel, parseNote, SCALES, scaleNotes, chordNotes, diatonicChords, romanToChord, isRomanNumeral, CHORD_TYPES, scaleSpelling, spelledNoteName,
  sanitizeParams, MAX_NUDGE_MS, sanitizePluginValues
} from '@greanteadawy/core';
import { z, ok, projectIdArg, annotations as A, uniqueName, assertNameFree, normVelocity } from '../util.js';
import { requirePlugin, pluginValues } from './plugins.js';

export function registerSoundTools({ tool, backend, load }) {
  tool('list_instruments', {
    title: 'List instruments',
    description: 'All instrument kinds, grouped by collection (drums, bass, keys, guitar, strings, synths, flutes, beatbox, Indian, East Asian, sampler, plugins), with presets and parameters (ranges/defaults). Use before add_channel / update_channel when you need specific sound design.',
    inputSchema: {
      kind: z.enum(INSTRUMENT_KINDS).optional().describe('Only show this instrument (full parameter list)'),
      category: z.enum(INSTRUMENT_CATEGORIES.map(([c]) => c)).optional().describe('Only show one collection, e.g. "indian" (ignored with kind)')
    },
    annotations: A.readOnly
  }, async ({ kind, category }) => {
    // a kind is one instrument whatever its collection: category only narrows the full listing
    if (kind) return ok(`Instrument ${kind}`, describeInstruments().find((i) => i.kind === kind));
    const all = describeInstruments().filter((i) => !category || i.category === category);
    const sections = INSTRUMENT_CATEGORIES
      .map(([cat, label]) => [label, all.filter((i) => i.category === cat)])
      .filter(([, list]) => list.length)
      .map(([label, list]) => `## ${label}\n${list.map((i) => `${i.kind} (${i.label}, ${i.melodic ? 'melodic' : 'drum'}): presets ${i.presets.join(', ')}. ${i.description}`).join('\n')}`);
    return ok(sections.join('\n\n') + '\n\nCall list_instruments with kind for full parameter details.');
  });

  tool('list_effects', {
    title: 'List effects',
    description: 'All mixer effect types with parameters (ranges/defaults, which are automatable).',
    inputSchema: {},
    annotations: A.readOnly
  }, async () => ok('Effects', describeEffects()));

  tool('add_channel', {
    title: 'Add channel',
    description: "Add an instrument channel to the Channel Rack. By default it gets its own mixer insert (named after the channel). For instrument=sampler pass sampleId (see list_samples); the sampler's root key is set from the sample's detected pitch unless you give params.rootKey.",
    inputSchema: {
      projectId: projectIdArg,
      name: z.string().min(1).max(64).describe('Channel name, e.g. "Kick", "808", "Keys"'),
      instrument: z.enum(INSTRUMENT_KINDS).describe('Instrument kind'),
      preset: z.string().optional().describe('Preset name (see list_instruments)'),
      params: z.record(z.string(), z.any()).optional().describe('Instrument parameter overrides, e.g. {"decay":0.8}'),
      volume: z.number().min(0).max(1.25).optional().describe('0..1.25, default 0.78'),
      pan: z.number().min(-1).max(1).optional(),
      pitch: z.number().min(-24).max(24).optional().describe('Channel pitch in semitones'),
      chokeGroup: z.number().int().min(0).max(8).optional().describe('Channels in the same group (1-8) cut each other off (open/closed hats)'),
      mixerTrack: z.number().int().min(0).optional().describe('Mixer insert to route to. Default: next free insert'),
      sampleId: z.string().optional().describe('For instrument "sampler": sample id from list_samples'),
      plugin: z.string().optional().describe('For instrument "plugin": the plugin id (list_plugins)'),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    let params = { ...(a.params || {}) };
    let note = '';
    let pluginId = null;
    let rootKey;
    if (a.instrument === 'plugin') {
      const m = await requirePlugin(backend, a.plugin, 'instrument');
      params = pluginValues(m, a.preset, params);
      pluginId = m.id;
      rootKey = m.defaultKey;
      a.preset = a.preset || Object.keys(m.presets)[0]; // the first preset is the plugin's default
      a.color = a.color || m.color;
    } else if (a.plugin) {
      throw new Error('plugin only works with instrument "plugin"');
    }
    if (a.sampleId) {
      if (a.instrument !== 'sampler') throw new Error('sampleId only works with instrument "sampler"');
      const s = await backend.getSample(a.sampleId);
      params.sampleId = s.id;
      const pitch = s.analysis?.pitch;
      if (params.rootKey === undefined && pitch?.midi !== undefined && s.analysis?.kind === 'one-shot') {
        params.rootKey = pitch.midi;
        note = ` Root key set to the detected pitch ${pitch.note}.`;
      }
    }
    if (!pluginId) makeInstrument(a.instrument, a.preset, params, { strict: true }); // validate with helpful errors
    if (a.mixerTrack !== undefined && a.mixerTrack >= p.mixer.length) {
      throw new Error(`Mixer insert ${a.mixerTrack} does not exist (0..${p.mixer.length - 1}). Create it with set_mixer first, or leave mixerTrack out to get a free insert.`);
    }
    const id = uid('ch');
    const name = uniqueName(p.channels, a.name); // names are how tools find channels: keep them unique
    if (name !== a.name) note += ` A channel named "${a.name}" already existed, so this one is "${name}".`;
    const after = await backend.applyOps(p.id, [{
      type: 'channel/add',
      nameInsert: true,
      channel: { id, name, kind: a.instrument, preset: a.preset, params, plugin: pluginId, rootKey, volume: a.volume, pan: a.pan, pitch: a.pitch, chokeGroup: a.chokeGroup, mixerTrack: a.mixerTrack ?? 'auto', color: a.color }
    }]);
    const ch = after.channels.find((c) => c.id === id);
    return ok(`Added channel "${ch.name}" [${ch.id}] (${ch.instrument.kind}${pluginId ? ` ${pluginId}` : ''}/${ch.instrument.preset}) → mixer insert ${ch.mixerTrack}. Step-sequencer note: ${noteName(ch.rootKey)}.${note}`);
  });

  tool('update_channel', {
    title: 'Update channel',
    description: 'Change a channel: name, color, volume, pan, pitch, mute/solo, routing, choke group, channel filter (cutoff/resonance), groove (nudge, swingMix), step note, instrument kind/preset or individual instrument params.',
    inputSchema: {
      projectId: projectIdArg,
      channel: z.string().describe('Channel id or name'),
      name: z.string().min(1).max(64).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      volume: z.number().min(0).max(1.25).optional(),
      pan: z.number().min(-1).max(1).optional(),
      pitch: z.number().min(-24).max(24).optional(),
      mute: z.boolean().optional(),
      solo: z.boolean().optional(),
      mixerTrack: z.number().int().min(0).optional(),
      chokeGroup: z.number().int().min(0).max(8).optional(),
      filterCutoff: z.number().min(20).max(20000).optional().describe('Channel low-pass cutoff in Hz (20000 = open)'),
      filterRes: z.number().min(0.1).max(20).optional(),
      nudge: z.number().min(-MAX_NUDGE_MS).max(MAX_NUDGE_MS).optional().describe('Play this channel early (-) or late (+) in ms: e.g. snare/clap +8..+20 for a lazy, laid-back backbeat, hats -3..-6 to push'),
      swingMix: z.number().min(0).max(1).optional().describe('Share of the project swing this channel gets (1 = all, 0 = straight), e.g. swung hats over a straight kick'),
      stepNote: z.union([z.string(), z.number()]).optional().describe('Note the step sequencer writes for this channel'),
      instrument: z.enum(INSTRUMENT_KINDS).optional().describe('Switch to a different instrument kind (resets params)'),
      plugin: z.string().optional().describe('For instrument "plugin": switch to this plugin (list_plugins)'),
      preset: z.string().optional().describe('Load a preset (resets params to the preset, then applies params)'),
      params: z.record(z.string(), z.any()).optional().describe('Instrument params to change, e.g. {"cutoff":1200,"release":0.5}')
    },
    annotations: A.edit
  }, async (a) => {
    const p = await load(a.projectId);
    const ch = findChannel(p, a.channel);
    if (a.name) assertNameFree(p.channels, a.name, 'channel', ch);
    if (a.mixerTrack !== undefined && a.mixerTrack >= p.mixer.length) throw new Error(`Mixer insert ${a.mixerTrack} does not exist (0..${p.mixer.length - 1}); create it with set_mixer first`);
    const patch = {};
    for (const k of ['name', 'color', 'volume', 'pan', 'pitch', 'mute', 'solo', 'mixerTrack', 'chokeGroup', 'filterCutoff', 'filterRes', 'nudge', 'swingMix']) if (a[k] !== undefined) patch[k] = a[k];
    if (a.stepNote !== undefined) patch.rootKey = parseNote(a.stepNote);
    if (a.instrument || a.preset || a.params || a.plugin) {
      const kind = a.instrument || ch.instrument.kind;
      if (kind === 'plugin') {
        const m = await requirePlugin(backend, a.plugin || ch.instrument.plugin, 'instrument');
        const reset = a.preset || a.plugin || a.instrument;
        // strict validation first (clear errors), then the values as the plugin will see them (stepped values rounded)
        const params = reset ? pluginValues(m, a.preset, a.params) : (pluginValues(m, null, a.params), a.params && sanitizePluginValues(m.params, a.params));
        patch.instrument = { kind: 'plugin', plugin: m.id, ...(reset && { preset: a.preset || Object.keys(m.presets)[0] }), ...(params && { params }) };
        // switching to another plugin: its own step note (unless one was given)
        if ((ch.instrument.kind !== 'plugin' || ch.instrument.plugin !== m.id) && patch.rootKey === undefined) patch.rootKey = m.defaultKey;
      } else {
        if (a.plugin) throw new Error('plugin only works with instrument "plugin"');
        if (a.preset && !Object.hasOwn(INSTRUMENTS[kind].presets, a.preset)) throw new Error(`Unknown preset "${a.preset}" for ${kind}. Available: ${Object.keys(INSTRUMENTS[kind].presets).join(', ')}`);
        if (a.params) sanitizeParams(INSTRUMENTS[kind].params, a.params, { strict: true }); // unknown keys, out-of-range values
        patch.instrument = { ...(a.instrument && { kind: a.instrument }), ...(a.preset && { preset: a.preset }), ...(a.params && { params: a.params }) };
      }
    }
    if (!Object.keys(patch).length) throw new Error('Nothing to change');
    const after = await backend.applyOps(p.id, [{ type: 'channel/update', id: ch.id, patch }]);
    const c = after.channels.find((x) => x.id === ch.id);
    return ok(`Updated "${c.name}": ${c.instrument.kind}/${c.instrument.preset}, vol ${c.volume}, pan ${c.pan}, insert ${c.mixerTrack}${c.nudge ? `, nudge ${c.nudge > 0 ? '+' : ''}${c.nudge} ms` : ''}${c.swingMix !== 1 ? `, swing ×${c.swingMix}` : ''}${c.mute ? ', muted' : ''}${c.solo ? ', solo' : ''}.`);
  });

  tool('remove_channel', {
    title: 'Remove channel',
    description: 'Delete a channel and all its notes.',
    inputSchema: { projectId: projectIdArg, channel: z.string() },
    annotations: A.destructive
  }, async ({ projectId, channel }) => {
    const p = await load(projectId);
    const ch = findChannel(p, channel);
    const triggers = p.mixer.flatMap((m, i) => m.effects.filter((e) => e.params.source === ch.id).map(() => i));
    await backend.applyOps(p.id, [{ type: 'channel/remove', id: ch.id }]);
    return ok(`Removed channel "${ch.name}".${triggers.length ? ` It triggered the sidechain pump on insert ${triggers.join(', ')}: that pump now has no source (set a new one with update_effect, or it pumps on the grid).` : ''}`);
  });

  tool('clone_channel', {
    title: 'Clone channel',
    description: 'Duplicate a channel (same instrument settings) — e.g. to layer a second clap or build a variation. Optionally copies its notes in every pattern.',
    inputSchema: {
      projectId: projectIdArg,
      channel: z.string(),
      name: z.string().min(1).max(64).optional(),
      withNotes: z.boolean().optional().describe('Also copy the notes in all patterns (default false)'),
      ownInsert: z.boolean().optional().describe('Route the clone to a new free mixer insert (default true)')
    },
    annotations: A.edit
  }, async ({ projectId, channel, name, withNotes = false, ownInsert = true }) => {
    const p = await load(projectId);
    const src = findChannel(p, channel);
    if (name) assertNameFree(p.channels, name, 'channel');
    const id = uid('ch');
    const ops = [{
      type: 'channel/add',
      index: p.channels.indexOf(src) + 1,
      nameInsert: ownInsert,
      channel: { ...JSON.parse(JSON.stringify(src)), id, name: name || uniqueName(p.channels, `${src.name} 2`), mixerTrack: ownInsert ? 'auto' : src.mixerTrack }
    }];
    if (withNotes) {
      for (const pt of p.patterns) {
        const list = pt.notes[src.id];
        if (list?.length) ops.push({ type: 'notes/set', patternId: pt.id, channelId: id, notes: list.map((n) => ({ ...n, id: uid('n') })) });
      }
    }
    const after = await backend.applyOps(p.id, ops);
    const c = after.channels.find((x) => x.id === id);
    return ok(`Cloned "${src.name}" as "${c.name}" [${c.id}] → insert ${c.mixerTrack}${withNotes ? ', with notes' : ''}.`);
  });

  tool('move_channel', {
    title: 'Move channel',
    description: 'Reorder a channel in the Channel Rack (0 = top).',
    inputSchema: { projectId: projectIdArg, channel: z.string(), position: z.number().int().min(0) },
    annotations: A.edit
  }, async ({ projectId, channel, position }) => {
    const p = await load(projectId);
    const ch = findChannel(p, channel);
    await backend.applyOps(p.id, [{ type: 'channel/move', id: ch.id, index: position }]);
    return ok(`Moved "${ch.name}" to position ${position}.`);
  });

  tool('preview_sound', {
    title: 'Preview a channel sound',
    description: "Play one note of a channel in the user's browser (to audition a sound while designing it).",
    inputSchema: {
      projectId: projectIdArg,
      channel: z.string(),
      note: z.union([z.string(), z.number()]).optional().describe('Default: the channel step note'),
      velocity: z.number().min(0).max(127).optional().describe('0..1 (1 = full), or MIDI 2..127 (default 0.85)'),
      seconds: z.number().min(0.05).max(8).optional()
    },
    annotations: A.readOnly
  }, async ({ projectId, channel, note, velocity, seconds = 0.6 }) => {
    const p = await load(projectId);
    const ch = findChannel(p, channel);
    const key = note !== undefined ? parseNote(note) : ch.rootKey;
    const v = normVelocity(velocity, 0.85);
    if (v <= 0) throw new Error('Velocity 0 is silent: use 0.05–1 (or MIDI 2–127) to hear the sound');
    const n = await backend.transport(p.id, { action: 'audition', channelId: ch.id, key, velocity: v, duration: seconds });
    return ok(n ? `Played ${noteName(key)} on "${ch.name}" in the browser.` : 'No browser has this project open, so nothing was played.');
  });

  tool('analyze_sound', {
    title: 'Analyse a channel sound',
    description: "Render one note of a channel offline in the user's browser and measure it, like soloing a sound on a meter: detected pitch (with cents), strongest low frequency (the note an 808 or kick really sounds), loudness, peak, spectrum, brightness and envelope (attack, time to -20/-40/-60 dB). Use it to tune 808s and kicks to the key, keep kick and 808 fundamentals apart, check that a tail doesn't run into the next hit, and compare sounds before mixing. Needs the studio open in a browser.",
    inputSchema: {
      projectId: projectIdArg,
      channel: z.string(),
      note: z.union([z.string(), z.number()]).optional().describe('Default: the channel step note (drums: C4)'),
      velocity: z.number().min(0).max(127).optional().describe('0..1 or MIDI 2..127 (default 0.8)'),
      lengthSteps: z.number().min(0.25).max(64).optional().describe('Note length in steps (default 1 for drums, 8 for melodic)'),
      through: z.enum(['channel', 'insert']).optional().describe('channel = instrument + channel strip (default); insert = also its mixer insert effects'),
      seconds: z.number().min(0.5).max(10).optional().describe('How long to render (default 3)')
    },
    annotations: A.readOnly
  }, async (a) => {
    const p = await load(a.projectId);
    const ch = findChannel(p, a.channel);
    const key = a.note !== undefined ? parseNote(a.note) : undefined;
    const v = a.velocity === undefined ? undefined : a.velocity > 1 ? a.velocity / 127 : a.velocity;
    const r = await backend.requestJob(
      { kind: 'sound', projectId: p.id, channelId: ch.id, key, velocity: v, lengthSteps: a.lengthSteps, through: a.through, seconds: a.seconds },
      { projectId: p.id, timeoutMs: 60000 }
    );
    return ok(formatSoundReport(r), r);
  });

  tool('music_theory', {
    title: 'Music theory helper',
    description: 'Exact notes for scales and chords, diatonic chords of a key, or roman-numeral progressions converted to chord symbols (e.g. "i VI III VII" in A minor → Am F C G). Defaults to the project key/scale.',
    inputSchema: {
      projectId: projectIdArg,
      action: z.enum(['scale', 'chord', 'diatonic_chords', 'progression']),
      key: z.string().optional().describe('Root, e.g. "A", "F#" (default: project key)'),
      scale: z.enum(Object.keys(SCALES)).optional().describe('Default: project scale'),
      chord: z.string().optional().describe('For action=chord, e.g. "Cmaj9", "F#m7b5"'),
      progression: z.string().optional().describe('For action=progression: roman numerals separated by spaces or dashes, e.g. "i-VI-III-VII" or "I V vi IV"'),
      octave: z.number().int().min(0).max(8).optional(),
      sevenths: z.boolean().optional().describe('For diatonic_chords: 7th chords instead of triads')
    },
    annotations: A.readOnly
  }, async (a) => {
    let key = a.key;
    let scale = a.scale;
    if (!key || !scale) {
      try {
        const p = await load(a.projectId);
        key = key || p.key || 'C';
        scale = scale || p.scale || 'minor';
      } catch {
        key = key || 'C';
        scale = scale || 'major';
      }
    }
    const octave = a.octave ?? 4;
    const spell = scaleSpelling(key, scale);
    const names = (notes) => notes.map((n) => spelledNoteName(n, spell)).join(' ');
    switch (a.action) {
      case 'scale': {
        const notes = scaleNotes(key, scale, octave, 1);
        return ok(`${key} ${scale}: ${names(notes)} (MIDI ${notes.join(' ')})`);
      }
      case 'chord': {
        if (!a.chord) throw new Error('chord is required');
        const notes = chordNotes(a.chord, octave);
        return ok(`${a.chord}: ${names(notes)} (MIDI ${notes.join(' ')})`);
      }
      case 'diatonic_chords': {
        const list = diatonicChords(key, scale, { sevenths: !!a.sevenths });
        return ok(`Diatonic ${a.sevenths ? 'seventh chords' : 'triads'} of ${key} ${scale}:\n${list.map((c) => `${c.numeral.padEnd(5)} ${c.chord.padEnd(7)} ${c.notes.join(' ')}`).join('\n')}`);
      }
      case 'progression': {
        if (!a.progression) throw new Error('progression is required');
        const tokens = a.progression.split(/[\s,–-]+/).filter(Boolean);
        const chords = tokens.map((t) => {
          if (!isRomanNumeral(t)) throw new Error(`"${t}" is not a roman numeral`);
          return romanToChord(t, key, scale);
        });
        return ok(`${a.progression} in ${key} ${scale} = ${chords.join(' – ')}\nChord qualities you can use: ${Object.keys(CHORD_TYPES).filter(Boolean).join(' ')}`);
      }
      default:
        throw new Error('Unknown action');
    }
  });
}

/** Plain-text report of an analyze_sound job. */
export function formatSoundReport(r) {
  const a = r.analysis || {};
  const e = r.envelope || {};
  const lines = [`SOUND — "${r.channel}" note ${noteName(r.key)} velocity ${Math.round((r.velocity ?? 0.8) * 100) / 100}, ${r.noteSeconds}s note, through the ${r.through}`];
  lines.push(`Level: ${a.lufs} LUFS, peak ${a.peakDb} dBFS${a.truePeakDb !== null && a.truePeakDb !== undefined ? ` (true peak ${a.truePeakDb} dBTP)` : ''}, crest ${a.crestDb} dB`);
  if (a.pitch) lines.push(`Pitch: ${a.pitch.note} (${a.pitch.hz} Hz, ${a.pitch.cents > 0 ? '+' : ''}${a.pitch.cents} cents, confidence ${a.pitch.confidence})`);
  else lines.push('Pitch: no clear single pitch (noisy, chordal or very short)');
  if (a.lowPeakHz) lines.push(`Low end: strongest frequency ${a.lowPeakHz} Hz ≈ ${a.lowPeakNote}`);
  const b = a.bandsPercent || {};
  lines.push(`Spectrum: ${a.brightness}, ${a.tonality} (centroid ${a.centroidHz} Hz); sub ${b.sub}% · low ${b.low}% · low-mid ${b.lowMid}% · mid ${b.mid}% · high-mid ${b.highMid}% · high ${b.high}%`);
  const t = (x) => (x === null || x === undefined ? 'longer than the render' : `${x} ms`);
  lines.push(`Envelope: attack ${t(e.attackMs)}, -20 dB after ${t(e.decay20Ms)}, -40 dB after ${t(e.decay40Ms)}, -60 dB after ${t(e.decay60Ms)}`);
  if (a.character) lines.push(`Sounds like: ${a.character}`);
  return lines.join('\n');
}
