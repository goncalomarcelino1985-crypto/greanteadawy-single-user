// the band instruments: piano carries the intro, bass guitar and drums join for the verse, strummed acoustic
// guitar and a string section lift the chorus (I–V–vi–IV)
import { chordProgressionNotes, bassFromChords, bassLineFromChords } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Pop Band (96 BPM, G major: piano, guitar, bass, strings)',
  spec: () => {
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
  }
};
