import { STEP } from '../constants.js';
import { melodyFromString, repeatNotes } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Acid Techno (132 BPM)',
  spec: () => ({
    name: 'Acid Techno', bpm: 132, key: 'A', scale: 'minor',
    channels: [
      { name: 'Kick', kind: 'kick', preset: 'Hard', volume: 0.85 },
      { name: 'Clap', kind: 'clap', preset: 'Tight', volume: 0.55, sends: { Reverb: 0.2 } },
      { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 0.4 },
      { name: 'Open Hat', kind: 'hat', preset: 'Open', volume: 0.4, params: { decay: 0.2 } },
      { name: 'Acid', kind: 'synth', preset: 'Acid Bass', volume: 0.6, fx: [{ type: 'distortion', params: { drive: 0.3, mix: 0.5 } }, { type: 'pump', params: { source: 'Kick', depth: 0.35, shape: 0.3 } }], sends: { Delay: 0.18 } }
    ],
    buses: [
      { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 1.8, size: 0.6, mix: 1 } }] },
      { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/8d', feedback: 0.4, mix: 1 } }] }
    ],
    patterns: [
      {
        name: 'Drums', bars: 1, color: '#9aa5b1',
        notes: () => ({
          Kick: steps('x---x---x---x---'),
          Clap: steps('----x-------x---'),
          Hat: steps('oxoxoxoxoxoxoxox'),
          'Open Hat': steps('--x---x---x---x-')
        })
      },
      {
        name: 'Acid Line', bars: 2, color: '#f5d547',
        notes: () => ({ Acid: repeatNotes(melodyFromString('A2:1 A2:1! A3:1 A2:1 C3:1! A2:1 E3:1 A2:1 -:1 G3:1! A2:1 A3:1 C3:1 A2:1 G2:1! A2:1', { gate: 0.6 }), 16 * STEP, 2) })
      }
    ],
    markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Acid' }],
    arrangement: [
      { pattern: 'Drums', track: 0, bar: 0, bars: 16, trackName: 'Drums' },
      { pattern: 'Acid Line', track: 1, bar: 4, bars: 12, trackName: 'Acid' }
    ]
  })
};
