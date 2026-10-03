// the East Asian collection over a lo-fi beat: koto arpeggios in D hirajoshi (D E F A Bb), a temple bell opens each
// section, the shakuhachi sings long notes, taiko (odaiko + shime) lift the second half
import { melodyFromString } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'East Asian Lo-fi (82 BPM, D hirajoshi: koto, shakuhachi, taiko)',
  spec: () => ({
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
