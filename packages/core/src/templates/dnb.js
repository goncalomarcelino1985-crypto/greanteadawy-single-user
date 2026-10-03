// liquid drum & bass: a two-step break (kick on 1 and the "and" of 3, snare on 2 and 4) under a ride, a reese bass
// ducking under the kick, Rhodes and a pad holding each chord for two bars
import { chordProgressionNotes, bassLineFromChords } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Liquid Drum & Bass (174 BPM, F minor: reese bass, Rhodes)',
  spec: () => {
    const prog = ['Fm9', 'Dbmaj9', 'Bbm9', 'Eb9'];
    return {
      name: 'Liquid Drum & Bass', bpm: 174, key: 'F', scale: 'minor',
      channels: [
        { name: 'Kick', kind: 'kick', preset: 'Punchy', volume: 0.8 },
        { name: 'Snare', kind: 'snare', preset: 'Fat', volume: 0.75, sends: { Reverb: 0.15 } },
        { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 1 },
        { name: 'Ride', kind: 'cymbal', preset: 'Ride', volume: 0.24, pan: 0.25 },
        { name: 'Reese', kind: 'synth', preset: 'Reese Bass', volume: 0.9, params: { gain: 1.2 }, fx: [{ type: 'pump', params: { source: 'Kick', depth: 0.4, shape: 0.2 } }, { type: 'stereo', params: { width: 1, monoBelow: 150 } }] },
        { name: 'Rhodes', kind: 'epiano', preset: 'Suitcase', volume: 0.6, fx: [{ type: 'eq', params: { hpf: 150 } }], sends: { Reverb: 0.3, Delay: 0.15 } },
        { name: 'Pad', kind: 'synth', preset: 'Soft Pad', volume: 0.35, fx: [{ type: 'eq', params: { hpf: 250 } }, { type: 'pump', params: { source: 'Kick', depth: 0.5 } }], sends: { Reverb: 0.4 } }
      ],
      buses: [
        { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 3, size: 0.7, predelay: 0.02, mix: 1 } }] },
        { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/4t', feedback: 0.3, mix: 1 } }] }
      ],
      patterns: [
        {
          name: 'Drums', bars: 2, color: '#e8665a',
          notes: () => ({
            Kick: steps('X---------x----- X-x-------x-----'),
            Snare: steps('----X-------X--- ----X-------X--o'),
            Hat: steps('x-o-x-o-x-o-x-ox x-o-x-o-x-o-x-o-', 60, { velocityScale: 0.8 }),
            Ride: steps('--x---x---x---x- --x---x---x---x-')
          })
        },
        {
          name: 'Reese', bars: 8, color: '#d98c5f',
          notes: (bar) => ({ Reese: bassLineFromChords(prog, 'R:20 R:4 -:2 8:2~ R:4', { octave: 2, chordLength: 2 * bar, gate: 0.95 }) })
        },
        {
          name: 'Rhodes', bars: 8, color: '#d9a35f',
          notes: (bar) => ({ Rhodes: chordProgressionNotes(prog, { chordLength: 2 * bar, octave: 4, style: 'rhythm', rhythm: 'x-------------x- ------x---------', gate: 0.95, velocity: 0.6, voicing: 'rootless', center: 64 }) })
        },
        {
          name: 'Pad', bars: 8, color: '#3fb5d6',
          notes: (bar) => ({ Pad: chordProgressionNotes(prog, { chordLength: 2 * bar, octave: 4, gate: 1, velocity: 0.45, voicing: 'open', center: 67 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 8, name: 'Drop' }],
      arrangement: [
        { pattern: 'Rhodes', track: 0, bar: 0, bars: 24, trackName: 'Rhodes' },
        { pattern: 'Pad', track: 1, bar: 0, bars: 24, trackName: 'Pad' },
        { pattern: 'Drums', track: 2, bar: 8, bars: 16, trackName: 'Drums' },
        { pattern: 'Reese', track: 3, bar: 8, bars: 16, trackName: 'Reese' }
      ]
    };
  }
};
