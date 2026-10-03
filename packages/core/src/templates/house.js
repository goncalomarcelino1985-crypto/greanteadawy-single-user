import { chordProgressionNotes, bassFromChords } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Deep House (124 BPM, A minor)',
  spec: () => ({
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
  })
};
