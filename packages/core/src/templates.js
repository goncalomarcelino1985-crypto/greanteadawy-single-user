// Genre starter templates (also used by the MCP `create_project` tool).
import { STEP, ticksPerBar } from './constants.js';
import { createEmptyProject, createDefaultProject, createChannel, createPattern, createClip, createMarker, normalizeProject, normalizeKey } from './model.js';
import { parsePitchClass } from './music.js';
import { createEffect } from './effects.js';
import { INSTRUMENTS } from './instruments.js';
import { notesFromSteps, chordProgressionNotes, bassFromChords, bassLineFromChords, melodyFromString, rollNotes, repeatNotes } from './builders.js';

export const TEMPLATES = {
  default: { label: 'Default (4 drum channels)', bpm: 130 },
  empty: { label: 'Empty project', bpm: 130 },
  trap: { label: 'Trap (140 BPM, C minor)', bpm: 140 },
  house: { label: 'Deep House (124 BPM, A minor)', bpm: 124 },
  boombap: { label: 'Boom Bap (90 BPM, swing)', bpm: 90 },
  lofi: { label: 'Lo-fi Hip Hop (80 BPM)', bpm: 80 },
  techno: { label: 'Acid Techno (132 BPM)', bpm: 132 },
  band: { label: 'Pop Band (96 BPM, G major: piano, guitar, bass, strings)', bpm: 96 },
  indian: { label: 'Indian Fusion (92 BPM, C bhairav: sitar, tabla, tanpura, bansuri, harmonium)', bpm: 92 },
  eastasian: { label: 'East Asian Lo-fi (82 BPM, D hirajoshi: koto, shakuhachi, taiko)', bpm: 82 }
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

const steps = (str, key, opts = {}) => notesFromSteps(str.replace(/\s/g, ''), { key, ...opts });

const SPECS = {
  trap: () => ({
    name: 'Trap Beat', bpm: 140, key: 'C', scale: 'minor',
    channels: [
      { name: 'Kick', kind: 'kick', preset: 'Trap', volume: 0.85 },
      { name: 'Clap', kind: 'clap', preset: 'Classic', volume: 0.7, sends: { Reverb: 0.15 } },
      { name: 'Hat', kind: 'hat', preset: 'Crisp', chokeGroup: 1, volume: 0.55, nudge: -3 },
      { name: 'Open Hat', kind: 'hat', preset: 'Open', chokeGroup: 1, volume: 0.45 },
      { name: '808', kind: 'bass808', preset: 'Classic', volume: 0.8, fx: [{ type: 'pump', params: { source: 'Kick', depth: 0.45, shape: 0.25 } }] },
      { name: 'Pad', kind: 'synth', preset: 'Soft Pad', volume: 0.5, fx: [{ type: 'eq', params: { hpf: 180 } }], sends: { Reverb: 0.35 } },
      { name: 'Bell', kind: 'fm', preset: 'Bell', volume: 0.45, fx: [{ type: 'eq', params: { hpf: 300 } }], sends: { Delay: 0.25, Reverb: 0.25 } }
    ],
    buses: [
      { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 2.6, size: 0.6, predelay: 0.02, mix: 1 } }] },
      { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/8d', feedback: 0.35, mix: 1 } }] }
    ],
    patterns: [
      {
        name: 'Drums', bars: 2, color: '#e8665a',
        notes: () => ({
          Kick: steps('x-----x---x----- x-----x-x-----x-'),
          Clap: steps('--------X------- --------X-------'),
          Hat: [
            ...steps('X-x-X-x-X-x-Xxx- X-x-X-x-X-x-----', 60, { velocityScale: 0.9 }),
            ...rollNotes({ start: 28 * STEP, span: 4 * STEP, count: 8, from: 0.4, to: 0.9 })
          ],
          'Open Hat': steps('---------------- ----------x-----')
        })
      },
      {
        name: '808', bars: 4, color: '#d98c5f',
        notes: (bar) => ({
          808: bassLineFromChords(['Cm', 'Ab', 'Eb', 'Bb'], 'R:6 R:4~ 8:2 -:2 5:2', { octave: 2, chordLength: bar, gate: 0.95 })
        })
      },
      {
        name: 'Chords', bars: 4, color: '#3fb5d6',
        notes: (bar) => ({ Pad: chordProgressionNotes(['Cm', 'Ab', 'Eb', 'Bb'], { chordLength: bar, octave: 4, gate: 1, velocity: 0.6 }) })
      },
      {
        name: 'Melody', bars: 4, color: '#8f6cf0',
        notes: () => ({ Bell: melodyFromString('G5:3 Eb5:3 C5:2 D5:4 Eb5:4  C5:3 Ab4:3 C5:2 Eb5:8  G5:3 Bb5:3 G5:2 F5:4 Eb5:4  D5:3 Bb4:3 D5:2 C5:8', { velocity: 0.75 }) })
      }
    ],
    markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Hook' }],
    arrangement: [
      { pattern: 'Melody', track: 0, bar: 0, bars: 16, trackName: 'Melody' },
      { pattern: 'Chords', track: 1, bar: 0, bars: 16, trackName: 'Chords' },
      { pattern: 'Drums', track: 2, bar: 4, bars: 12, trackName: 'Drums' },
      { pattern: '808', track: 3, bar: 4, bars: 12, trackName: '808' }
    ]
  }),

  house: () => ({
    name: 'Deep House', bpm: 124, key: 'A', scale: 'minor',
    channels: [
      { name: 'Kick', kind: 'kick', preset: 'House Thump', volume: 0.85 },
      { name: 'Clap', kind: 'clap', preset: 'Big', volume: 0.6, nudge: 4, sends: { Reverb: 0.12 } },
      { name: 'Open Hat', kind: 'hat', preset: 'Open', volume: 0.45, params: { decay: 0.25 } },
      { name: 'Shaker', kind: 'shaker', preset: 'Classic', volume: 0.35 },
      { name: 'Bass', kind: 'synth', preset: 'Sub Bass', volume: 0.75, fx: [{ type: 'pump', params: { source: 'Kick', depth: 0.6 } }] },
      { name: 'Chords', kind: 'synth', preset: 'Chord Stab', volume: 0.55, fx: [{ type: 'eq', params: { hpf: 200 } }, { type: 'pump', params: { source: 'Kick', depth: 0.75 } }], sends: { Reverb: 0.3 } }
    ],
    buses: [{ name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 2.8, size: 0.7, mix: 1 } }, { type: 'pump', params: { source: 'Kick', depth: 0.5 } }] }],
    patterns: [
      {
        name: 'Drums', bars: 1, color: '#e8665a',
        notes: () => ({
          Kick: steps('x---x---x---x---'),
          Clap: steps('----x-------x---'),
          'Open Hat': steps('--x---x---x---x-'),
          Shaker: steps('oxoxoxoxoxoxoxox')
        })
      },
      {
        name: 'Bass', bars: 4, color: '#d98c5f',
        notes: (bar) => ({ Bass: bassFromChords(['Am7', 'Dm7', 'Fmaj7', 'Em7'], { octave: 2, chordLength: bar, rhythm: '--x---x---x--xx-', gate: 0.8 }) })
      },
      {
        name: 'Chords', bars: 4, color: '#3fb5d6',
        notes: (bar) => ({ Chords: chordProgressionNotes(['Am7', 'Dm7', 'Fmaj7', 'Em7'], { chordLength: bar, octave: 4, style: 'rhythm', rhythm: '--x--x----x--x--', gate: 0.6, velocity: 0.7 }) })
      }
    ],
    markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Groove' }],
    arrangement: [
      { pattern: 'Drums', track: 0, bar: 0, bars: 16, trackName: 'Drums' },
      { pattern: 'Chords', track: 1, bar: 0, bars: 16, trackName: 'Chords' },
      { pattern: 'Bass', track: 2, bar: 4, bars: 12, trackName: 'Bass' }
    ]
  }),

  boombap: () => ({
    name: 'Boom Bap', bpm: 90, key: 'D', scale: 'dorian', swing: 0.45,
    channels: [
      { name: 'Kick', kind: 'kick', preset: 'Punchy', volume: 0.85, params: { drive: 0.35 } },
      { name: 'Snare', kind: 'snare', preset: 'Fat', volume: 0.75, nudge: 14, sends: { Room: 0.18 } },
      { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 0.45, nudge: 4 },
      { name: 'Keys', kind: 'fm', preset: 'E-Piano', volume: 0.55, fx: [{ type: 'eq', params: { hpf: 150 } }, { type: 'chorus', params: { mix: 0.35 } }], sends: { Room: 0.2 } },
      { name: 'Bass', kind: 'synth', preset: 'Sub Bass', volume: 0.7 }
    ],
    buses: [{ name: 'Room', fx: [{ type: 'reverb', params: { decay: 1.4, size: 0.35, mix: 1 } }] }],
    patterns: [
      {
        name: 'Drums', bars: 1, color: '#f2a03d',
        notes: () => ({
          Kick: steps('x------x--x-----'),
          Snare: steps('----X--o-o--X--o'),
          Hat: steps('x-o-x-o-x-o-x-ox')
        })
      },
      {
        name: 'Keys', bars: 4, color: '#8f6cf0',
        notes: (bar) => ({ Keys: chordProgressionNotes(['Dm9', 'G9', 'Cmaj9', 'A7'], { chordLength: bar, octave: 4, style: 'rhythm', rhythm: 'x-------x--x----', gate: 0.95, velocity: 0.65, voicing: 'rootless' }) })
      },
      {
        name: 'Bass', bars: 4, color: '#d98c5f',
        notes: (bar) => ({ Bass: bassFromChords(['Dm9', 'G9', 'Cmaj9', 'A7'], { octave: 2, chordLength: bar, rhythm: 'x------x--x-----', gate: 0.9 }) })
      }
    ],
    markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }],
    arrangement: [
      { pattern: 'Keys', track: 0, bar: 0, bars: 12, trackName: 'Keys' },
      { pattern: 'Drums', track: 1, bar: 0, bars: 12, trackName: 'Drums' },
      { pattern: 'Bass', track: 2, bar: 4, bars: 8, trackName: 'Bass' }
    ]
  }),

  lofi: () => ({
    name: 'Lo-fi Chill', bpm: 80, key: 'F', scale: 'major', swing: 0.3,
    channels: [
      { name: 'Kick', kind: 'kick', preset: 'Lo-fi', volume: 0.8 },
      { name: 'Snare', kind: 'snare', preset: 'Rimmy', volume: 0.6, nudge: 16, sends: { Reverb: 0.15 } },
      { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 0.35, params: { color: 7000 }, nudge: 5 },
      { name: 'Keys', kind: 'synth', preset: 'Lo-fi Keys', volume: 0.6, fx: [{ type: 'eq', params: { hpf: 160, lpf: 5000 } }, { type: 'bitcrusher', params: { bits: 10, mix: 0.4 } }, { type: 'chorus', params: { mix: 0.4, rate: 0.4 } }], sends: { Reverb: 0.3 } },
      { name: 'Bass', kind: 'synth', preset: 'Sub Bass', volume: 0.65, nudge: 8 }
    ],
    buses: [{ name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 2.5, size: 0.5, damping: 4500, mix: 1 } }] }],
    master: [{ type: 'filter', params: { type: 'lowpass', cutoff: 9000 } }],
    patterns: [
      {
        name: 'Drums', bars: 1, color: '#46c79a',
        notes: () => ({
          Kick: steps('x-----x-x-------'),
          Snare: steps('----x-------x---'),
          Hat: steps('x-o-x-o-x-o-x-o-')
        })
      },
      {
        name: 'Keys', bars: 4, color: '#c86be0',
        notes: (bar) => ({ Keys: chordProgressionNotes(['Fmaj7', 'Em7', 'Dm7', 'Cmaj7'], { chordLength: bar, octave: 4, style: 'broken', gate: 0.95, velocity: 0.6, voicing: 'drop2' }) })
      },
      {
        name: 'Bass', bars: 4, color: '#d98c5f',
        notes: (bar) => ({ Bass: bassFromChords(['Fmaj7', 'Em7', 'Dm7', 'Cmaj7'], { octave: 2, chordLength: bar, rhythm: 'x-------x-----x-', gate: 0.9 }) })
      }
    ],
    markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Loop' }],
    arrangement: [
      { pattern: 'Keys', track: 0, bar: 0, bars: 16, trackName: 'Keys' },
      { pattern: 'Drums', track: 1, bar: 4, bars: 12, trackName: 'Drums' },
      { pattern: 'Bass', track: 2, bar: 4, bars: 12, trackName: 'Bass' }
    ]
  }),

  techno: () => ({
    name: 'Acid Techno', bpm: 132, key: 'A', scale: 'minor',
    channels: [
      { name: 'Kick', kind: 'kick', preset: 'Hard', volume: 0.85 },
      { name: 'Clap', kind: 'clap', preset: 'Tight', volume: 0.55, sends: { Reverb: 0.2 } },
      { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 0.4 },
      { name: 'Open Hat', kind: 'hat', preset: 'Open', volume: 0.4, params: { decay: 0.2 } },
      { name: 'Acid', kind: 'synth', preset: 'Acid Bass', volume: 0.6, fx: [{ type: 'distortion', params: { drive: 0.3, mix: 0.5 } }, { type: 'pump', params: { source: 'Kick', depth: 0.35, shape: 0.3 } }], sends: { Delay: 0.18 } }
    ],
    buses: [
      { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 1.8, size: 0.6, mix: 1 } }] },
      { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/8d', feedback: 0.4, mix: 1 } }] }
    ],
    patterns: [
      {
        name: 'Drums', bars: 1, color: '#9aa5b1',
        notes: () => ({
          Kick: steps('x---x---x---x---'),
          Clap: steps('----x-------x---'),
          Hat: steps('oxoxoxoxoxoxoxox'),
          'Open Hat': steps('--x---x---x---x-')
        })
      },
      {
        name: 'Acid Line', bars: 2, color: '#f5d547',
        notes: () => ({ Acid: repeatNotes(melodyFromString('A2:1 A2:1! A3:1 A2:1 C3:1! A2:1 E3:1 A2:1 -:1 G3:1! A2:1 A3:1 C3:1 A2:1 G2:1! A2:1', { gate: 0.6 }), 16 * STEP, 2) })
      }
    ],
    markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Acid' }],
    arrangement: [
      { pattern: 'Drums', track: 0, bar: 0, bars: 16, trackName: 'Drums' },
      { pattern: 'Acid Line', track: 1, bar: 4, bars: 12, trackName: 'Acid' }
    ]
  }),

  // the band instruments: piano carries the intro, bass guitar and drums join for the verse, strummed acoustic
  // guitar and a string section lift the chorus (I–V–vi–IV)
  band: () => {
    const prog = ['G', 'D', 'Em', 'C'];
    return {
      name: 'Pop Band', bpm: 96, key: 'G', scale: 'major',
      channels: [
        { name: 'Kick', kind: 'kick', preset: 'Punchy', volume: 0.6, params: { decay: 0.35, click: 0.3 } },
        { name: 'Snare', kind: 'snare', preset: 'Fat', volume: 1.2, sends: { Reverb: 0.18 } },
        { name: 'Hat', kind: 'hat', preset: 'Crisp', volume: 1, nudge: 4 },
        { name: 'Piano', kind: 'piano', preset: 'Grand', volume: 0.8, fx: [{ type: 'eq', params: { hpf: 70 } }], sends: { Reverb: 0.22 } },
        { name: 'Bass', kind: 'bass', preset: 'Finger', volume: 1, fx: [{ type: 'compressor', params: { threshold: -24, ratio: 4, attack: 0.015, makeup: 7 } }, { type: 'pump', params: { source: 'Kick', depth: 0.25, shape: 0.2 } }] },
        { name: 'Guitar', kind: 'guitar', preset: 'Acoustic', volume: 0.6, pan: -0.35, fx: [{ type: 'eq', params: { hpf: 120 } }], sends: { Reverb: 0.15 } },
        { name: 'Strings', kind: 'strings', preset: 'Slow Strings', volume: 0.7, pan: 0.25, fx: [{ type: 'eq', params: { hpf: 150 } }], sends: { Reverb: 0.4 } }
      ],
      buses: [{ name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 2.4, size: 0.65, predelay: 0.02, mix: 1 } }] }],
      patterns: [
        {
          name: 'Drums', bars: 1, color: '#e8665a',
          notes: () => ({
            Kick: steps('x-------x-x-----'),
            Snare: steps('----x-------x--o'),
            Hat: steps('x-o-x-o-x-o-x-ox', 60, { velocityScale: 0.85 })
          })
        },
        {
          name: 'Piano', bars: 4, color: '#e4d9b8',
          notes: (bar) => ({
            Piano: [
              ...chordProgressionNotes(prog, { chordLength: bar, octave: 4, style: 'rhythm', rhythm: 'x-----x---x-----', gate: 1, velocity: 0.62, voicing: 'close', center: 64 }),
              ...bassFromChords(prog, { octave: 2, chordLength: bar, rhythm: 'x---------------', gate: 1, velocity: 0.55 })
            ]
          })
        },
        {
          name: 'Bass', bars: 4, color: '#a8613f',
          notes: (bar) => ({ Bass: bassLineFromChords(prog, 'R:6 R:2 5:4 8:2 5:2', { octave: 2, chordLength: bar, gate: 0.9, velocity: 0.8 }) })
        },
        {
          name: 'Guitar', bars: 4, color: '#b8864b',
          notes: (bar) => ({ Guitar: chordProgressionNotes(prog, { chordLength: bar, octave: 3, style: 'rhythm', rhythm: 'x--x--x---x-x-x-', gate: 0.9, velocity: 0.7, voicing: 'spread' }) })
        },
        {
          name: 'Strings', bars: 4, color: '#b55e7a',
          notes: (bar) => ({ Strings: chordProgressionNotes(prog, { chordLength: bar, octave: 4, gate: 1, velocity: 0.6, voicing: 'open', center: 67 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }, { bar: 12, name: 'Chorus' }],
      arrangement: [
        { pattern: 'Piano', track: 0, bar: 0, bars: 20, trackName: 'Piano' },
        { pattern: 'Drums', track: 1, bar: 4, bars: 16, trackName: 'Drums' },
        { pattern: 'Bass', track: 2, bar: 4, bars: 16, trackName: 'Bass' },
        { pattern: 'Guitar', track: 3, bar: 12, bars: 8, trackName: 'Guitar' },
        { pattern: 'Strings', track: 4, bar: 12, bars: 8, trackName: 'Strings' }
      ]
    };
  },

  // the Indian collection: a tanpura drone and a sitar alap, then the tabla's keherwa (Dha Ge Na Tin | Na Ke Dhin Na,
  // ending on a TiRaKiTa) with a harmonium on Sa–Pa; the bansuri answers. Dha = Na + Ge and Dhin = Tin + Ge, so four
  // bol channels (plus Te for the fill) play the whole theka.
  indian: () => ({
    name: 'Indian Fusion', bpm: 92, key: 'C', scale: 'bhairav',
    channels: [
      { name: 'Tanpura', kind: 'tanpura', preset: 'Tanpura', volume: 0.95, sends: { Reverb: 0.25 } },
      { name: 'Na', kind: 'tabla', preset: 'Na', volume: 0.7, pan: 0.15, sends: { Reverb: 0.12 } },
      { name: 'Tin', kind: 'tabla', preset: 'Tin', volume: 0.85, pan: 0.15, sends: { Reverb: 0.12 } },
      { name: 'Te', kind: 'tabla', preset: 'Te', volume: 1, pan: 0.15 },
      { name: 'Ge', kind: 'tabla', preset: 'Ge Slide', volume: 0.55, pan: -0.15, sends: { Reverb: 0.1 } },
      { name: 'Ke', kind: 'tabla', preset: 'Ke', volume: 0.95, pan: -0.15 },
      { name: 'Sitar', kind: 'sitar', preset: 'Sitar', volume: 0.85, pan: -0.2, fx: [{ type: 'eq', params: { hpf: 100 } }], sends: { Reverb: 0.3 } },
      { name: 'Harmonium', kind: 'harmonium', preset: 'Soft', volume: 0.45, pan: 0.25, fx: [{ type: 'eq', params: { hpf: 150 } }], sends: { Reverb: 0.2 } },
      { name: 'Bansuri', kind: 'bansuri', preset: 'Bansuri', volume: 0.8, pan: 0.1, fx: [{ type: 'eq', params: { hpf: 200 } }], sends: { Reverb: 0.35, Delay: 0.18 } }
    ],
    buses: [
      { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 3, size: 0.7, predelay: 0.03, mix: 1 } }] },
      { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/4d', feedback: 0.3, mix: 1 } }] }
    ],
    patterns: [
      {
        // Pa, Sa, Sa, low Sa: the tanpura's cycle, each string left to ring
        name: 'Tanpura', bars: 2, color: '#a0785a',
        notes: () => ({ Tanpura: melodyFromString('G2:8 C3:8 C3:8 C2:8', { velocity: 0.7, gate: 1 }) })
      },
      {
        name: 'Theka', bars: 2, color: '#b5651d',
        notes: () => ({
          Na: steps('X---x---x-----x- X---x---x------x'),
          Ge: steps('X-x---------x--- X-x-------------'),
          Tin: steps('------x-----x--- ------x---------'),
          Ke: steps('----------x----- ----------x---x-'),
          Te: steps('---------------- ------------xo--')
        })
      },
      {
        name: 'Sitar', bars: 4, color: '#d98b3a',
        notes: () => ({
          // "~" = meend: the note runs into the next one and the mono sitar slides there
          Sitar: melodyFromString('C4:4 Db4:2~ C4:2 B3:4 C4:4  E4:4 F4:2 E4:2~ Db4:4 C4:4  G4:6 Ab4:2~ G4:4 F4:4  E4:2 F4:2 E4:2~ Db4:2 C4:8', { velocity: 0.8, gate: 0.92 })
        })
      },
      {
        name: 'Harmonium', bars: 1, color: '#b5835a',
        notes: () => ({ Harmonium: [...melodyFromString('C4:16', { velocity: 0.6, gate: 1 }), ...melodyFromString('G3:16', { velocity: 0.55, gate: 1 })] })
      },
      {
        name: 'Bansuri', bars: 4, color: '#e0a458',
        notes: () => ({
          Bansuri: melodyFromString('G4:8 Ab4:4~ G4:4  F4:4 E4:4~ F4:8  E4:4 Db4:4 E4:4~ F4:4  E4:4~ Db4:4 C4:8', { velocity: 0.75, gate: 0.9 })
        })
      }
    ],
    markers: [{ bar: 0, name: 'Alap' }, { bar: 4, name: 'Theka' }, { bar: 12, name: 'Bansuri' }],
    arrangement: [
      { pattern: 'Tanpura', track: 0, bar: 0, bars: 20, trackName: 'Tanpura' },
      { pattern: 'Sitar', track: 1, bar: 0, bars: 12, trackName: 'Sitar' },
      { pattern: 'Theka', track: 2, bar: 4, bars: 16, trackName: 'Tabla' },
      { pattern: 'Harmonium', track: 3, bar: 4, bars: 16, trackName: 'Harmonium' },
      { pattern: 'Bansuri', track: 4, bar: 12, bars: 8, trackName: 'Bansuri' }
    ]
  }),

  // the East Asian collection over a lo-fi beat: koto arpeggios in D hirajoshi (D E F A Bb), a temple bell opens each
  // section, the shakuhachi sings long notes, taiko (odaiko + shime) lift the second half
  eastasian: () => ({
    name: 'East Asian Lo-fi', bpm: 82, key: 'D', scale: 'hirajoshi', swing: 0.3,
    channels: [
      { name: 'Kick', kind: 'kick', preset: 'Lo-fi', volume: 0.7 },
      { name: 'Snare', kind: 'snare', preset: 'Rimmy', volume: 1.1, sends: { Reverb: 0.15 } },
      { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 1, nudge: 6 },
      // tuned above the kick's 50 Hz so the two don't mask each other
      { name: 'Odaiko', kind: 'taiko', preset: 'Odaiko', params: { pitch: 66 }, volume: 0.75, sends: { Reverb: 0.25 } },
      { name: 'Shime', kind: 'taiko', preset: 'Shime', volume: 0.85, pan: 0.3, sends: { Reverb: 0.1 } },
      { name: 'Koto', kind: 'koto', preset: 'Koto', volume: 0.85, pan: -0.25, fx: [{ type: 'eq', params: { hpf: 150 } }], sends: { Reverb: 0.25, Delay: 0.15 } },
      { name: 'Shakuhachi', kind: 'shakuhachi', preset: 'Zen', volume: 0.75, pan: 0.15, fx: [{ type: 'eq', params: { hpf: 200 } }], sends: { Reverb: 0.4 } },
      { name: 'Bell', kind: 'gong', preset: 'Temple Bell', volume: 0.5, sends: { Reverb: 0.3 } }
    ],
    buses: [
      { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 3.2, size: 0.75, predelay: 0.03, mix: 1 } }] },
      { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/8d', feedback: 0.35, mix: 1 } }] }
    ],
    patterns: [
      {
        name: 'Beat', bars: 1, color: '#e8665a',
        notes: () => ({
          Kick: steps('x-------x-x-----'),
          Snare: steps('----x-------x--o'),
          Hat: steps('x-x-x-x-x-x-x-xo', 60, { velocityScale: 0.75 })
        })
      },
      {
        name: 'Taiko', bars: 2, color: '#8c3b2e',
        notes: () => ({
          Odaiko: steps('X--------------- x-------x-------'),
          Shime: steps('x-o-x-o-x-o-x-o- x-o-x-o-x-o-xxxx', 60, { velocityScale: 0.85 })
        })
      },
      {
        name: 'Koto', bars: 4, color: '#c49a6c',
        notes: () => ({
          Koto: melodyFromString('D4:2 A4:2 Bb4:2 A4:2 F4:2 E4:2 D4:4  D4:2 A4:2 Bb4:2 D5:2 E5:2 D5:2 A4:4  Bb3:2 F4:2 A4:2 Bb4:2 D5:2 A4:2 F4:4  A3:2 E4:2 F4:2 A4:2 E4:4 D4:4', { velocity: 0.75, gate: 1 })
        })
      },
      {
        name: 'Shakuhachi', bars: 4, color: '#a3b86c',
        notes: () => ({ Shakuhachi: melodyFromString('A4:12 Bb4:4~  A4:8 F4:4 E4:4~  D4:16  -:16', { velocity: 0.7, gate: 0.9 }) })
      },
      {
        name: 'Bell', bars: 1, color: '#c9a227',
        notes: () => ({ Bell: steps('x---------------') })
      }
    ],
    markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }, { bar: 8, name: 'Taiko' }],
    arrangement: [
      { pattern: 'Koto', track: 0, bar: 0, bars: 16, trackName: 'Koto' },
      { pattern: 'Shakuhachi', track: 1, bar: 4, bars: 12, trackName: 'Shakuhachi' },
      { pattern: 'Beat', track: 2, bar: 4, bars: 12, trackName: 'Beat' },
      { pattern: 'Taiko', track: 3, bar: 8, bars: 8, trackName: 'Taiko' },
      { pattern: 'Bell', track: 4, bar: 0, bars: 1, trackName: 'Bell' },
      { pattern: 'Bell', track: 4, bar: 8, bars: 1 }
    ]
  })
};

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
  const specFn = SPECS[template];
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
