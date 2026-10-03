// bossa nova: nylon guitar in the batida rhythm, an upright bass on root and fifth, the bossa clave on a rim, and a
// breathy flute theme over Imaj7–II9–ii9–bII7 (the tritone substitute leading home)
import { chordProgressionNotes, bassLineFromChords, melodyFromString } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Bossa Nova (128 BPM, C major: nylon guitar, upright bass, flute)',
  spec: () => {
    const prog = ['Cmaj7', 'Cmaj7', 'D9', 'D9', 'Dm9', 'Db7', 'Cmaj7', 'Cmaj7'];
    return {
      name: 'Bossa Nova', bpm: 128, key: 'C', scale: 'major',
      channels: [
        { name: 'Kick', kind: 'kick', preset: 'Lo-fi', volume: 0.55 },
        { name: 'Rim', kind: 'rim', preset: 'Classic', volume: 1, pan: -0.2, sends: { Room: 0.15 } },
        { name: 'Shaker', kind: 'shaker', preset: 'Soft', volume: 0.35, pan: 0.25 },
        { name: 'Guitar', kind: 'guitar', preset: 'Nylon', volume: 0.8, pan: -0.15, fx: [{ type: 'eq', params: { hpf: 100 } }], sends: { Room: 0.2 } },
        { name: 'Bass', kind: 'bass', preset: 'Upright', volume: 1, fx: [{ type: 'compressor', params: { threshold: -24, ratio: 4, attack: 0.015, makeup: 12 } }] },
        { name: 'Flute', kind: 'flute', preset: 'Breathy', volume: 0.85, params: { gain: 1 }, pan: 0.15, fx: [{ type: 'eq', params: { hpf: 250 } }], sends: { Room: 0.3 } }
      ],
      buses: [{ name: 'Room', fx: [{ type: 'reverb', params: { decay: 1.6, size: 0.45, predelay: 0.02, mix: 1 } }] }],
      patterns: [
        {
          name: 'Drums', bars: 2, color: '#f2a03d',
          notes: () => ({
            // the surdo-like kick follows the bass; the clave spans both bars
            Kick: steps('x-----x-x-----x- x-----x-x-----x-', 60, { velocityScale: 0.8 }),
            Rim: steps('x-----x-----x--- ----x-----x-----'),
            Shaker: steps('x-o-x-o-x-o-x-o- x-o-x-o-x-o-x-o-')
          })
        },
        {
          name: 'Guitar', bars: 8, color: '#b8864b',
          notes: (bar) => ({ Guitar: chordProgressionNotes(prog, { chordLength: bar, octave: 4, style: 'rhythm', rhythm: 'x--x--x---x--x--', gate: 0.7, velocity: 0.6, voicing: 'drop2', center: 60 }) })
        },
        {
          name: 'Bass', bars: 8, color: '#a8613f',
          notes: (bar) => ({ Bass: bassLineFromChords(prog, 'R:6 R:2 -5:6 -5:2', { octave: 2, chordLength: bar, gate: 0.85, velocity: 0.8 }) })
        },
        {
          name: 'Theme', bars: 8, color: '#e0a458',
          notes: () => ({ Flute: melodyFromString('G5:6 E5:2 E5:4 D5:4  G5:6 E5:2 E5:2 D5:2 G5:4  F#5:6 E5:2 E5:4 D5:4  F#5:6 E5:2 C5:4 -:4  F5:6 D5:2 C5:4 A4:4  Ab4:6 F4:2 B4:4 Ab4:4  G4:4 B4:4 E5:8  D5:4 C5:12', { velocity: 0.7, gate: 0.92 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 8, name: 'Theme' }],
      arrangement: [
        { pattern: 'Guitar', track: 0, bar: 0, bars: 16, trackName: 'Guitar' },
        { pattern: 'Drums', track: 1, bar: 0, bars: 16, trackName: 'Percussion' },
        { pattern: 'Bass', track: 2, bar: 0, bars: 16, trackName: 'Bass' },
        { pattern: 'Theme', track: 3, bar: 8, bars: 8, trackName: 'Flute' }
      ]
    };
  }
};
