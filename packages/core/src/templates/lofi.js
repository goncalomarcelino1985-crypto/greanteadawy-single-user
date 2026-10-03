import { chordProgressionNotes, bassFromChords } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Lo-fi Hip Hop (80 BPM)',
  spec: () => ({
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
  })
};
