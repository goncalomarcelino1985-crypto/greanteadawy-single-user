import { chordProgressionNotes, bassFromChords } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Boom Bap (90 BPM, swing)',
  spec: () => ({
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
  })
};
