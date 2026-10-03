// cinematic: a felt-piano ostinato over low strings, a solo cello takes the theme, then a reverse swell and a tam-tam
// open the big half where staccato strings and taiko drive (i–VI–III–VII)
import { STEP } from '../constants.js';
import { chordProgressionNotes, melodyFromString } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Cinematic (90 BPM, D minor: strings, solo cello, taiko)',
  spec: () => {
    const prog = ['Dm', 'Bb', 'F', 'C'];
    return {
      name: 'Cinematic', bpm: 90, key: 'D', scale: 'minor',
      channels: [
        { name: 'Odaiko', kind: 'taiko', preset: 'Odaiko', volume: 0.64, sends: { Hall: 0.25 } },
        { name: 'Chudaiko', kind: 'taiko', preset: 'Chudaiko', volume: 0.7, pan: -0.2, sends: { Hall: 0.2 } },
        { name: 'Tam-tam', kind: 'gong', preset: 'Tam-tam', volume: 0.5, sends: { Hall: 0.3 } },
        { name: 'Piano', kind: 'piano', preset: 'Felt', volume: 1, fx: [{ type: 'eq', params: { hpf: 80 } }], sends: { Hall: 0.3 } },
        { name: 'Strings', kind: 'strings', preset: 'Ensemble', volume: 0.75, fx: [{ type: 'eq', params: { hpf: 60 } }], sends: { Hall: 0.35 } },
        { name: 'Staccato', kind: 'strings', preset: 'Staccato', volume: 0.55, pan: 0.2, fx: [{ type: 'eq', params: { hpf: 100 } }], sends: { Hall: 0.2 } },
        { name: 'Cello', kind: 'strings', preset: 'Solo Cello', volume: 1.25, pan: -0.15, sends: { Hall: 0.3 } },
        { name: 'Swell', kind: 'synth', preset: 'Reverse Swell', volume: 1, params: { gain: 1 }, sends: { Hall: 0.3 } }
      ],
      buses: [{ name: 'Hall', fx: [{ type: 'reverb', params: { decay: 4.5, size: 0.9, predelay: 0.04, mix: 1 } }] }],
      patterns: [
        {
          name: 'Taiko', bars: 2, color: '#8c3b2e',
          notes: () => ({
            Odaiko: steps('X-------x-x----- X-------x---x-x-'),
            Chudaiko: steps('x--x--x-x--x--x- x--x--x-x-x-xxxx', 60, { velocityScale: 0.8 })
          })
        },
        {
          name: 'Tam-tam', bars: 1, color: '#c9a227',
          notes: () => ({ 'Tam-tam': steps('X') })
        },
        {
          // the swell's 1.5 s attack peaks right on the next downbeat
          name: 'Swell', bars: 1, color: '#9aa5b1',
          notes: () => ({ Swell: melodyFromString('-:7 D4:9', { velocity: 0.8, gate: 1 }) })
        },
        {
          name: 'Piano', bars: 4, color: '#e4d9b8',
          notes: (bar) => ({ Piano: chordProgressionNotes(prog, { chordLength: bar, octave: 4, style: 'arp-updown', rate: STEP * 2, gate: 0.9, velocity: 0.55 }) })
        },
        {
          name: 'Strings', bars: 4, color: '#b55e7a',
          notes: (bar) => ({ Strings: chordProgressionNotes(prog, { chordLength: bar, octave: 3, gate: 1, velocity: 0.6, voicing: 'spread', center: 57 }) })
        },
        {
          name: 'Staccato', bars: 4, color: '#d9774e',
          notes: (bar) => ({ Staccato: chordProgressionNotes(prog, { chordLength: bar, octave: 3, style: 'rhythm', rhythm: 'x-xxx-xxx-xxx-xx', gate: 0.5, velocity: 0.7, voicing: 'close', center: 55 }) })
        },
        {
          name: 'Cello', bars: 4, color: '#a0785a',
          notes: () => ({ Cello: melodyFromString('A3:6 D4:2 F4:4 E4:4  D4:6 F4:2 Bb3:8  C4:6 A3:2 F3:4 A3:4  G3:6 E3:2 C4:8', { velocity: 0.75, gate: 0.95 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Theme' }, { bar: 8, name: 'Epic' }],
      arrangement: [
        { pattern: 'Piano', track: 0, bar: 0, bars: 16, trackName: 'Piano' },
        { pattern: 'Strings', track: 1, bar: 0, bars: 16, trackName: 'Strings' },
        { pattern: 'Cello', track: 2, bar: 4, bars: 12, trackName: 'Cello' },
        { pattern: 'Staccato', track: 3, bar: 8, bars: 8, trackName: 'Staccato' },
        { pattern: 'Taiko', track: 4, bar: 8, bars: 8, trackName: 'Taiko' },
        { pattern: 'Swell', track: 5, bar: 7, bars: 1, trackName: 'FX' },
        { pattern: 'Tam-tam', track: 5, bar: 8, bars: 1 }
      ]
    };
  }
};
