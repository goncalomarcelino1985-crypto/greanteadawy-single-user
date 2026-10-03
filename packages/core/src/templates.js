// Genre starter templates (also used by the MCP `create_project` tool). Each genre is a file in templates/ that exports
// { label, spec }: spec() describes channels, buses, patterns and the arrangement, and build() turns it into a project.
import { ticksPerBar } from './constants.js';
import { createEmptyProject, createDefaultProject, createChannel, createPattern, createClip, createMarker, normalizeProject, normalizeKey } from './model.js';
import { parsePitchClass } from './music.js';
import { createEffect } from './effects.js';
import { INSTRUMENTS } from './instruments.js';
import trap from './templates/trap.js';
import house from './templates/house.js';
import boombap from './templates/boombap.js';
import lofi from './templates/lofi.js';
import techno from './templates/techno.js';
import band from './templates/band.js';
import indian from './templates/indian.js';
import eastasian from './templates/eastasian.js';
import drill from './templates/drill.js';
import afrobeats from './templates/afrobeats.js';
import reggaeton from './templates/reggaeton.js';
import dnb from './templates/dnb.js';
import synthwave from './templates/synthwave.js';
import disco from './templates/disco.js';
import neosoul from './templates/neosoul.js';
import bossanova from './templates/bossanova.js';
import cinematic from './templates/cinematic.js';
import beatbox from './templates/beatbox.js';

// in the order the template menus list them
const GENRES = { trap, house, boombap, lofi, techno, band, indian, eastasian, drill, afrobeats, reggaeton, dnb, synthwave, disco, neosoul, bossanova, cinematic, beatbox };

export const TEMPLATES = {
  default: { label: 'Default (4 drum channels)', bpm: 130 },
  empty: { label: 'Empty project', bpm: 130 },
  ...Object.fromEntries(Object.entries(GENRES).map(([id, g]) => [id, { label: g.label, bpm: g.spec().bpm }]))
};

/**
 * Templates model good mix practice: shared reverb/delay buses fed by sends (not a reverb per channel), high-passed
 * non-bass parts, and kick-triggered sidechain (pump source = the kick channel, given by name here).
 */
function build(spec) {
  const p = createEmptyProject({ name: spec.name, bpm: spec.bpm, key: spec.key, scale: spec.scale });
  p.swing = spec.swing || 0;
  const bar = ticksPerBar(p);
  const byName = {};
  const busIndex = {};
  (spec.buses || []).forEach((b, j) => {
    const i = spec.channels.length + 1 + j;
    p.mixer[i].name = b.name;
    if (b.volume !== undefined) p.mixer[i].volume = b.volume;
    for (const fx of b.fx) p.mixer[i].effects.push(createEffect(fx.type, fx.params));
    busIndex[b.name] = i;
  });
  spec.channels.forEach((c, i) => {
    const ch = createChannel({ ...c, mixerTrack: i + 1 });
    p.channels.push(ch);
    byName[c.name] = ch;
    p.mixer[i + 1].name = c.name;
    for (const fx of c.fx || []) p.mixer[i + 1].effects.push(createEffect(fx.type, fx.params));
    if (c.insertVolume !== undefined) p.mixer[i + 1].volume = c.insertVolume;
    p.mixer[i + 1].sends = Object.entries(c.sends || {}).map(([bus, amount]) => {
      if (!busIndex[bus]) throw new Error(`Template bus ${bus} missing`);
      return { to: busIndex[bus], amount };
    });
  });
  // sidechain sources are written as channel names in the specs
  for (const m of p.mixer) for (const fx of m.effects) if (fx.params.source) fx.params.source = byName[fx.params.source]?.id ?? null;
  const patByName = {};
  for (const ps of spec.patterns) {
    const pt = createPattern({ name: ps.name, color: ps.color, length: ps.bars * bar });
    for (const [chName, notes] of Object.entries(ps.notes(bar))) {
      const ch = byName[chName];
      if (!ch) throw new Error(`Template channel ${chName} missing`);
      pt.notes[ch.id] = notes.map((n) => ({ ...n, key: n.key ?? ch.rootKey })).sort((a, b) => a.start - b.start);
    }
    p.patterns.push(pt);
    patByName[ps.name] = pt;
  }
  for (const a of spec.arrangement || []) {
    p.playlist.clips.push(createClip({ kind: 'pattern', refId: patByName[a.pattern].id, track: a.track, start: a.bar * bar, length: a.bars * bar }));
    if (a.trackName) p.playlist.tracks[a.track].name = a.trackName;
  }
  for (const fx of spec.master || []) p.mixer[0].effects.unshift(createEffect(fx.type, fx.params));
  p.markers = (spec.markers || []).map((m) => createMarker({ tick: m.bar * bar, name: m.name }));
  return normalizeProject(p);
}

export function createProjectFromTemplate(template = 'default', opts = {}) {
  if (opts.key !== undefined && opts.key !== null && opts.key !== '') {
    if (!normalizeKey(opts.key)) throw new Error(`Invalid key "${opts.key}": use a root note such as C, F#, Bb`);
    if (template === 'default' || template === 'empty' || !template) opts = { ...opts, key: normalizeKey(opts.key) };
  }
  if (template === 'default' || !template) return createDefaultProject(opts);
  if (template === 'empty') {
    const p = createEmptyProject(opts);
    p.patterns = [createPattern({ name: 'Pattern 1' })];
    return p;
  }
  const specFn = GENRES[template]?.spec;
  if (!specFn) throw new Error(`Unknown template "${template}". Available: ${Object.keys(TEMPLATES).join(', ')}`);
  const spec = specFn();
  if (opts.name) spec.name = opts.name;
  if (opts.bpm) spec.bpm = opts.bpm;
  const p = build(spec);
  if (opts.key) transposeToKey(p, opts.key);
  return p;
}

/** Move a template's melodic parts to another key root (nearest direction, drums untouched). */
function transposeToKey(p, key) {
  const from = parsePitchClass(p.key || 'C');
  const to = parsePitchClass(key);
  if (to === null || from === null) throw new Error(`Invalid key "${key}"`);
  let shift = (to - from + 12) % 12;
  if (shift > 6) shift -= 12;
  const pitched = new Set(p.channels.filter((c) => INSTRUMENTS[c.instrument.kind]?.melodic).map((c) => c.id));
  // drums tuned to the key (the tabla's treble drum is tuned to Sa) follow by channel pitch; a sitar's sympathetic
  // strings are retuned to the new Sa
  for (const c of p.channels) {
    if (INSTRUMENTS[c.instrument.kind]?.tunedToKey && shift) c.pitch = Math.max(-24, Math.min(24, (c.pitch || 0) + shift));
    const sa = INSTRUMENTS[c.instrument.kind]?.params.find((d) => d.key === 'sa');
    if (sa) c.instrument.params.sa = sa.options[to];
  }
  if (shift) {
    for (const pt of p.patterns) {
      for (const [cid, list] of Object.entries(pt.notes)) {
        if (pitched.has(cid)) pt.notes[cid] = list.map((n) => ({ ...n, key: Math.max(0, Math.min(127, n.key + shift)) }));
      }
    }
  }
  p.key = normalizeKey(key);
}
