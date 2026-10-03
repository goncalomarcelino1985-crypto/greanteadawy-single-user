// afrobeats: a 3-3-2 kick, rim backbeat, accented 16th shakers and two-tone congas answering in the gaps; a highlife
// guitar picks the chord tones over a syncopated finger bass (I–V–vi–IV)
import { chordProgressionNotes, bassLineFromChords, melodyFromString } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Afrobeats (104 BPM, Bb major: congas, highlife guitar)',
  spec: () => {
    const prog = ['Bbmaj7', 'F', 'Gm7', 'Ebmaj7'];
    return {
      name: 'Afrobeats', bpm: 104, key: 'Bb', scale: 'major', swing: 0.15,
      channels: [
        { name: 'Kick', kind: 'kick', preset: 'Deep', volume: 1 },
        { name: 'Rim', kind: 'rim', preset: 'Classic', volume: 1.1, sends: { Reverb: 0.12 } },
        { name: 'Shaker', kind: 'shaker', preset: 'Classic', volume: 0.4, pan: 0.2 },
        { name: 'Conga', kind: 'perc', preset: 'Conga', volume: 0.7, pan: -0.3, sends: { Reverb: 0.1 } },
        { name: 'Bass', kind: 'bass', preset: 'Finger', volume: 1, fx: [{ type: 'compressor', params: { threshold: -24, ratio: 4, attack: 0.015, makeup: 11 } }, { type: 'pump', params: { source: 'Kick', depth: 0.25, shape: 0.2 } }] },
        { name: 'Guitar', kind: 'guitar', preset: 'Clean Electric', volume: 0.85, pan: 0.3, fx: [{ type: 'eq', params: { hpf: 200 } }], sends: { Delay: 0.2, Reverb: 0.15 } },
        { name: 'Pad', kind: 'synth', preset: 'Soft Pad', volume: 0.45, fx: [{ type: 'eq', params: { hpf: 250 } }, { type: 'pump', params: { source: 'Kick', depth: 0.5 } }], sends: { Reverb: 0.3 } }
      ],
      buses: [
        { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 2.2, size: 0.55, predelay: 0.02, mix: 1 } }] },
        { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/8d', feedback: 0.3, mix: 1 } }] }
      ],
      patterns: [
        {
          name: 'Drums', bars: 2, color: '#e8665a',
          notes: () => ({
            Kick: steps('x--x--x---x----- x-----x-x-------'),
            Rim: steps('----x-------x--- ----x-------x--x'),
            Shaker: steps('7373737373737373 7373737373737373'),
            // open tones up a fifth, slaps on the base pitch
            Conga: [...steps('--x--x----x--x-- --x--x----x-----', 67), ...steps('-------x-------x -------x----x-x-', 60)]
          })
        },
        {
          name: 'Bass', bars: 4, color: '#a8613f',
          notes: (bar) => ({ Bass: bassLineFromChords(prog, 'R:3 R:3 5:2 R:3 8:3 5:2', { octave: 2, chordLength: bar, gate: 0.85, velocity: 0.85 }) })
        },
        {
          name: 'Guitar', bars: 4, color: '#b8864b',
          notes: () => ({
            Guitar: melodyFromString('F4 Bb4 D5:2 F5 D5 A4:2 Bb4 D5 F5:2 D5:2 A4:2  C4 F4 A4:2 C5 A4 F4:2 C4 F4 A4:2 C5:2 A4:2  D4 G4 Bb4:2 D5 Bb4 F4:2 G4 Bb4 D5:2 Bb4:2 F4:2  Eb4 G4 Bb4:2 D5 Bb4 G4:2 Eb4 G4 Bb4:2 G4:2 D4:2', { velocity: 0.7, gate: 0.55 })
          })
        },
        {
          name: 'Pad', bars: 4, color: '#3fb5d6',
          notes: (bar) => ({ Pad: chordProgressionNotes(prog, { chordLength: bar, octave: 4, gate: 1, velocity: 0.5, voicing: 'open', center: 64 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Groove' }],
      arrangement: [
        { pattern: 'Guitar', track: 0, bar: 0, bars: 16, trackName: 'Guitar' },
        { pattern: 'Pad', track: 1, bar: 0, bars: 16, trackName: 'Pad' },
        { pattern: 'Drums', track: 2, bar: 4, bars: 12, trackName: 'Drums' },
        { pattern: 'Bass', track: 3, bar: 4, bars: 12, trackName: 'Bass' }
      ]
    };
  }
};
