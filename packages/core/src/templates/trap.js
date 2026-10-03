import { STEP } from '../constants.js';
import { chordProgressionNotes, bassLineFromChords, melodyFromString, rollNotes } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Trap (140 BPM, C minor)',
  spec: () => ({
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
  })
};
