// the beatbox collection on its own: mouth kick, spit snare, t-hats with an open "ts" on the last off-beat, a lip
// bass on the roots, a hummed hook and a scratch closing every 4-bar phrase
import { bassLineFromChords, melodyFromString } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Beatbox Jam (92 BPM, E minor: mouth drums, lip bass, hummed hook)',
  spec: () => {
    const prog = ['Em', 'C', 'G', 'D'];
    return {
      name: 'Beatbox Jam', bpm: 92, key: 'E', scale: 'minor', swing: 0.25,
      channels: [
        { name: 'Kick', kind: 'bbkick', preset: 'Classic B', volume: 1.25 },
        { name: 'Snare', kind: 'bbsnare', preset: 'Psh Spit Snare', volume: 0.95, sends: { Room: 0.12 } },
        { name: 'Rim', kind: 'bbsnare', preset: 'Kch Rimshot', volume: 0.45, pan: 0.2 },
        { name: 'Hat', kind: 'bbhat', preset: 'T Hat', volume: 1, chokeGroup: 1, pan: -0.1 },
        { name: 'Open Hat', kind: 'bbhat', preset: 'Ts Open Hat', volume: 0.4, chokeGroup: 1 },
        { name: 'Bass', kind: 'bbbass', preset: 'Lip Bass', volume: 1, fx: [{ type: 'pump', params: { source: 'Kick', depth: 0.25, shape: 0.2 } }] },
        { name: 'Hum', kind: 'bbbass', preset: 'Hum', volume: 0.38, pan: 0.1, sends: { Room: 0.25 } },
        { name: 'Scratch', kind: 'bbfx', preset: 'Scratch', volume: 0.45, pan: -0.2 }
      ],
      buses: [{ name: 'Room', fx: [{ type: 'reverb', params: { decay: 1.1, size: 0.3, mix: 1 } }] }],
      patterns: [
        {
          name: 'Beat', bars: 2, color: '#e8665a',
          notes: () => ({
            Kick: steps('x-----x---x----- x-----x---x---x-'),
            Snare: steps('----x-------x--- ----x-------x---'),
            Rim: steps('-------x-------- ---------x------'),
            Hat: steps('x-x-x-x-x-x-x--- x-x-x-x-x-x-x---', 60, { velocityScale: 0.85 }),
            'Open Hat': steps('--------------x- --------------x-')
          })
        },
        {
          name: 'Bass', bars: 4, color: '#d98c5f',
          notes: (bar) => ({ Bass: bassLineFromChords(prog, 'R:3 R:3 -:2 5:2 R:2 -:2 8:2', { octave: 2, chordLength: bar, gate: 0.8 }) })
        },
        {
          name: 'Hum', bars: 4, color: '#c86be0',
          notes: () => ({ Hum: melodyFromString('B3:4 G3:2 E3:2 -:2 G3:2 A3:4  G3:4 E3:2 C3:2 -:2 E3:2 G3:4  B3:4 D4:2 B3:2 -:2 A3:2 G3:4  F#3:4 A3:2 D4:2 -:2 E4:2 F#4:4', { velocity: 0.75, gate: 0.9 }) })
        },
        {
          name: 'Scratch', bars: 1, color: '#9aa5b1',
          notes: () => ({ Scratch: steps('--------x---x-x-') })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }, { bar: 8, name: 'Hook' }],
      arrangement: [
        { pattern: 'Beat', track: 0, bar: 0, bars: 16, trackName: 'Beat' },
        { pattern: 'Bass', track: 1, bar: 4, bars: 12, trackName: 'Bass' },
        { pattern: 'Hum', track: 2, bar: 8, bars: 8, trackName: 'Hum' },
        { pattern: 'Scratch', track: 3, bar: 3, bars: 1, trackName: 'Scratch' },
        { pattern: 'Scratch', track: 3, bar: 7, bars: 1 },
        { pattern: 'Scratch', track: 3, bar: 11, bars: 1 }
      ]
    };
  }
};
