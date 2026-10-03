// reggaeton: the dembow (kick on every beat, snare on the 3-3-2 off-beats), an 808 hitting with it, nylon-guitar
// arpeggios and a plucked hook an octave above them (i–VI–III–VII)
import { STEP } from '../constants.js';
import { chordProgressionNotes, bassLineFromChords, melodyFromString } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Reggaeton (94 BPM, B minor: dembow, nylon guitar)',
  spec: () => {
    const prog = ['Bm', 'G', 'D', 'A'];
    return {
      name: 'Reggaeton', bpm: 94, key: 'B', scale: 'minor',
      channels: [
        { name: 'Kick', kind: 'kick', preset: 'Punchy', volume: 0.8 },
        { name: 'Snare', kind: 'snare', preset: 'Tight', volume: 1.15, sends: { Reverb: 0.12 } },
        { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 0.7, nudge: 3 },
        { name: 'Bongo', kind: 'perc', preset: 'Bongo', volume: 0.56, pan: 0.3 },
        { name: '808', kind: 'bass808', preset: 'Clean', volume: 1, fx: [{ type: 'pump', params: { source: 'Kick', depth: 0.35, shape: 0.2 } }] },
        { name: 'Guitar', kind: 'guitar', preset: 'Nylon', volume: 1, pan: -0.25, fx: [{ type: 'eq', params: { hpf: 150 } }], sends: { Reverb: 0.2 } },
        { name: 'Pluck', kind: 'synth', preset: 'Pluck', volume: 0.8, pan: 0.15, params: { gain: 1.2 }, fx: [{ type: 'eq', params: { hpf: 250 } }], sends: { Delay: 0.25, Reverb: 0.2 } }
      ],
      buses: [
        { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 2, size: 0.55, predelay: 0.02, mix: 1 } }] },
        { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/8d', feedback: 0.3, mix: 1 } }] }
      ],
      patterns: [
        {
          name: 'Dembow', bars: 2, color: '#e8665a',
          notes: () => ({
            Kick: steps('x---x---x---x--- x---x---x---x---'),
            Snare: steps('---x--x----x--x- ---x--x----x--x-'),
            Hat: steps('x-x-x-x-x-x-x-x- x-x-x-x-x-x-x-x-', 60, { velocityScale: 0.7 }),
            Bongo: [...steps('--x-------x----- --x-------x-xx--', 69, { velocityScale: 0.8 }), ...steps('-------x-------- -------x------xx', 62)]
          })
        },
        {
          name: '808', bars: 4, color: '#d98c5f',
          notes: (bar) => ({ 808: bassLineFromChords(prog, 'R:3 R:3 R:2 -:3 R:3 5:2', { octave: 2, chordLength: bar, gate: 0.9 }) })
        },
        {
          name: 'Guitar', bars: 4, color: '#b8864b',
          notes: (bar) => ({ Guitar: chordProgressionNotes(prog, { chordLength: bar, octave: 3, style: 'arp-updown', rate: STEP * 2, gate: 0.9, velocity: 0.65 }) })
        },
        {
          name: 'Hook', bars: 4, color: '#8f6cf0',
          notes: () => ({ Pluck: melodyFromString('F#5:3 D5:3 B4:2 C#5:2 D5:2 F#5:4  G5:3 F#5:3 D5:2 B4:4 -:4  A5:3 F#5:3 D5:2 E5:2 F#5:2 A5:4  G5:3 F#5:3 E5:2 C#5:4 -:4', { velocity: 0.75, gate: 0.8 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }, { bar: 8, name: 'Hook' }],
      arrangement: [
        { pattern: 'Guitar', track: 0, bar: 0, bars: 16, trackName: 'Guitar' },
        { pattern: 'Dembow', track: 1, bar: 4, bars: 12, trackName: 'Dembow' },
        { pattern: '808', track: 2, bar: 4, bars: 12, trackName: '808' },
        { pattern: 'Hook', track: 3, bar: 8, bars: 8, trackName: 'Hook' }
      ]
    };
  }
};
