// synthwave: a big-room snare, a tom run and a crash framing every 4 bars, 8th-note FM bass, a 16th square arp, a
// chorused pad and a saw lead through a dotted-8th delay (i–VI–III–VII)
import { STEP } from '../constants.js';
import { chordProgressionNotes, bassFromChords, melodyFromString } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Synthwave (100 BPM, A minor: FM bass, arps, saw lead)',
  spec: () => {
    const prog = ['Am', 'F', 'C', 'G'];
    return {
      name: 'Synthwave', bpm: 100, key: 'A', scale: 'minor',
      channels: [
        { name: 'Kick', kind: 'kick', preset: 'Punchy', volume: 1 },
        { name: 'Snare', kind: 'snare', preset: 'Fat', volume: 1.25, sends: { Room: 0.35 } },
        { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 0.88 },
        { name: 'Tom', kind: 'tom', preset: 'Mid', volume: 0.6, sends: { Room: 0.25 } },
        { name: 'Crash', kind: 'cymbal', preset: 'Crash', volume: 0.35, sends: { Reverb: 0.15 } },
        { name: 'Bass', kind: 'fm', preset: 'FM Bass', volume: 0.82, params: { gain: 1.4 }, fx: [{ type: 'pump', params: { source: 'Kick', depth: 0.35, shape: 0.25 } }] },
        { name: 'Arp', kind: 'synth', preset: 'Arp Blip', volume: 0.88, pan: -0.2, fx: [{ type: 'eq', params: { hpf: 300 } }], sends: { Delay: 0.3 } },
        { name: 'Pad', kind: 'synth', preset: 'Soft Pad', volume: 0.67, fx: [{ type: 'eq', params: { hpf: 200 } }, { type: 'chorus', params: { mix: 0.4 } }], sends: { Reverb: 0.35 } },
        { name: 'Lead', kind: 'synth', preset: 'Saw Lead', volume: 0.8, pan: 0.1, fx: [{ type: 'eq', params: { hpf: 250 } }], sends: { Delay: 0.3, Reverb: 0.25 } }
      ],
      // a short, dense room for the snare and toms (the 80s gated sound) and a long hall for the synths
      buses: [
        { name: 'Room', fx: [{ type: 'reverb', params: { decay: 0.8, size: 0.9, damping: 7000, mix: 1 } }] },
        { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 3.5, size: 0.8, predelay: 0.03, mix: 1 } }] },
        { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/8d', feedback: 0.4, mix: 1 } }] }
      ],
      patterns: [
        {
          name: 'Drums', bars: 4, color: '#e8665a',
          notes: (bar) => ({
            Kick: steps('x-------x------- x-------x------- x-------x------- x-------x-------'),
            Snare: steps('----x-------x--- ----x-------x--- ----x-------x--- ----x-----------'),
            Hat: steps('x-x-x-x-x-x-x-x- x-x-x-x-x-x-x-x- x-x-x-x-x-x-x-x- x-x-x-x-x-x-----', 60, { velocityScale: 0.7 }),
            // drum notes are pitched: a run down from high to floor tom
            Tom: [
              ...steps('xx', 67, { offset: 3 * bar + 10 * STEP }),
              ...steps('xx', 62, { offset: 3 * bar + 12 * STEP }),
              ...steps('Xx', 57, { offset: 3 * bar + 14 * STEP })
            ],
            Crash: steps('X')
          })
        },
        {
          name: 'Bass', bars: 4, color: '#d98c5f',
          notes: (bar) => ({ Bass: bassFromChords(prog, { octave: 2, chordLength: bar, rhythm: 'x-x-x-x-x-x-x-x-', gate: 0.6, velocity: 0.8 }) })
        },
        {
          name: 'Arp', bars: 4, color: '#f5d547',
          notes: (bar) => ({ Arp: chordProgressionNotes(prog, { chordLength: bar, octave: 4, style: 'arp-up', rate: STEP, gate: 0.8, velocity: 0.6 }) })
        },
        {
          name: 'Pad', bars: 4, color: '#3fb5d6',
          notes: (bar) => ({ Pad: chordProgressionNotes(prog, { chordLength: bar, octave: 4, gate: 1, velocity: 0.55, voicing: 'open', center: 64 }) })
        },
        {
          name: 'Lead', bars: 4, color: '#8f6cf0',
          notes: () => ({ Lead: melodyFromString('E5:4 A5:4 G5:2 E5:2 C5:4  C5:4 F5:4 E5:2 C5:2 A4:4  E5:4 G5:4 C6:4 B5:2 G5:2  D5:6 B4:2 G4:4 -:4', { velocity: 0.75, gate: 0.9 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }, { bar: 12, name: 'Lead' }],
      arrangement: [
        { pattern: 'Pad', track: 0, bar: 0, bars: 20, trackName: 'Pad' },
        { pattern: 'Arp', track: 1, bar: 0, bars: 20, trackName: 'Arp' },
        { pattern: 'Drums', track: 2, bar: 4, bars: 16, trackName: 'Drums' },
        { pattern: 'Bass', track: 3, bar: 4, bars: 16, trackName: 'Bass' },
        { pattern: 'Lead', track: 4, bar: 12, bars: 8, trackName: 'Lead' }
      ]
    };
  }
};
