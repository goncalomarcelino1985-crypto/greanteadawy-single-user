// UK drill: half-time snare on beat 3 with a late hit, hats in 3-3-2 groups ending in a triplet roll, an 808 that
// slides up an octave, a dark piano line over strings (i–VI–iv–V, the D chord's F# from harmonic minor)
import { STEP } from '../constants.js';
import { chordProgressionNotes, bassLineFromChords, melodyFromString, rollNotes } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'UK Drill (142 BPM, G harmonic minor: sliding 808, dark piano)',
  spec: () => {
    const prog = ['Gm', 'Eb', 'Cm', 'D'];
    return {
      name: 'UK Drill', bpm: 142, key: 'G', scale: 'harmonicMinor',
      channels: [
        { name: 'Kick', kind: 'kick', preset: 'Trap', volume: 0.8 },
        { name: 'Snare', kind: 'snare', preset: 'Trap', volume: 0.6, sends: { Reverb: 0.12 } },
        { name: 'Hat', kind: 'hat', preset: 'Crisp', volume: 0.63, nudge: -2 },
        { name: 'Rim', kind: 'rim', preset: 'Classic', volume: 0.4, pan: 0.25, sends: { Reverb: 0.1 } },
        { name: '808', kind: 'bass808', preset: 'Long', volume: 0.64, fx: [{ type: 'pump', params: { source: 'Kick', depth: 0.35, shape: 0.25 } }] },
        { name: 'Piano', kind: 'piano', preset: 'Grand', volume: 0.7, params: { gain: 1.3 }, fx: [{ type: 'eq', params: { hpf: 150 } }], sends: { Reverb: 0.3, Delay: 0.15 } },
        { name: 'Strings', kind: 'strings', preset: 'Ensemble', volume: 0.72, fx: [{ type: 'eq', params: { hpf: 180 } }], sends: { Reverb: 0.4 } }
      ],
      buses: [
        { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 2.4, size: 0.6, predelay: 0.02, mix: 1 } }] },
        { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/8d', feedback: 0.3, mix: 1 } }] }
      ],
      patterns: [
        {
          name: 'Drums', bars: 2, color: '#e8665a',
          notes: () => ({
            Kick: steps('X---------x----- X---------x-----'),
            Snare: steps('--------X-----x- --------X--x----'),
            Hat: [
              ...steps('X--x--x-x--x--x- x--x--x-x--x----', 60, { velocityScale: 0.85 }),
              ...rollNotes({ start: 28 * STEP, span: 4 * STEP, count: 6, from: 0.45, to: 0.85 })
            ],
            Rim: steps('------x--------x ----x-------x---')
          })
        },
        {
          name: '808', bars: 4, color: '#d98c5f',
          notes: (bar) => ({ 808: bassLineFromChords(prog, 'R:6 -:4 R:2~ 8:2 -:2', { octave: 2, chordLength: bar, gate: 0.95 }) })
        },
        {
          name: 'Piano', bars: 4, color: '#e4d9b8',
          notes: () => ({ Piano: melodyFromString('G4:2 Bb4:2 D5:2 F#5:2 G5:4 D5:4  Eb5:2 D5:2 Bb4:2 G4:2 Eb4:8  C5:2 Eb5:2 G5:2 Eb5:2 C5:4 Bb4:4  A4:2 C5:2 D5:2 F#5:2 A5:4 F#5:4', { velocity: 0.7, gate: 0.9 }) })
        },
        {
          name: 'Strings', bars: 4, color: '#b55e7a',
          notes: (bar) => ({ Strings: chordProgressionNotes(prog, { chordLength: bar, octave: 4, gate: 1, velocity: 0.55, voicing: 'open', center: 62 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }],
      arrangement: [
        { pattern: 'Piano', track: 0, bar: 0, bars: 16, trackName: 'Piano' },
        { pattern: 'Strings', track: 1, bar: 0, bars: 16, trackName: 'Strings' },
        { pattern: 'Drums', track: 2, bar: 4, bars: 12, trackName: 'Drums' },
        { pattern: '808', track: 3, bar: 4, bars: 12, trackName: '808' }
      ]
    };
  }
};
