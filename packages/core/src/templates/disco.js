// disco funk: four on the floor with open hats on the off-beats, a slap bass jumping octaves, muted 16th guitar,
// brass stabs, and a string section for the last eight bars (i9–IV9–bIIImaj7–ii7: the dorian IV is major)
import { chordProgressionNotes, bassLineFromChords } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Disco Funk (118 BPM, E dorian: slap bass, muted guitar, brass)',
  spec: () => {
    const prog = ['Em9', 'A9', 'Gmaj7', 'F#m7'];
    return {
      name: 'Disco Funk', bpm: 118, key: 'E', scale: 'dorian',
      channels: [
        { name: 'Kick', kind: 'kick', preset: 'House Thump', volume: 0.85 },
        { name: 'Clap', kind: 'clap', preset: 'Classic', volume: 1.2, sends: { Reverb: 0.15 } },
        { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 0.62, chokeGroup: 1, nudge: 3 },
        { name: 'Open Hat', kind: 'hat', preset: 'Open', volume: 0.4, chokeGroup: 1 },
        { name: 'Bass', kind: 'bass', preset: 'Slap', volume: 1, fx: [{ type: 'compressor', params: { threshold: -24, ratio: 4, attack: 0.01, makeup: 11 } }, { type: 'pump', params: { source: 'Kick', depth: 0.2, shape: 0.2 } }] },
        { name: 'Guitar', kind: 'guitar', preset: 'Muted', volume: 0.31, pan: 0.35, fx: [{ type: 'eq', params: { hpf: 250 } }] },
        { name: 'Brass', kind: 'synth', preset: 'Brass', volume: 0.32, pan: -0.2, fx: [{ type: 'eq', params: { hpf: 200 } }], sends: { Reverb: 0.2 } },
        { name: 'Strings', kind: 'strings', preset: 'Ensemble', volume: 0.57, pan: -0.1, fx: [{ type: 'eq', params: { hpf: 300 } }], sends: { Reverb: 0.35 } }
      ],
      buses: [{ name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 2, size: 0.55, predelay: 0.02, mix: 1 } }] }],
      patterns: [
        {
          name: 'Drums', bars: 1, color: '#e8665a',
          notes: () => ({
            Kick: steps('x---x---x---x---'),
            Clap: steps('----x-------x---'),
            // closed hats rest under the open ones: they share a choke group
            Hat: steps('xo-oxo-oxo-oxo-o'),
            'Open Hat': steps('--x---x---x---x-')
          })
        },
        {
          name: 'Bass', bars: 4, color: '#a8613f',
          notes: (bar) => ({ Bass: bassLineFromChords(prog, 'R:2 8:1 -:1 R:1 R:1 8:2 -:2 R:1 8:1 5:2 7:2', { octave: 2, chordLength: bar, gate: 0.8, velocity: 0.85 }) })
        },
        {
          name: 'Guitar', bars: 4, color: '#b8864b',
          notes: (bar) => ({ Guitar: chordProgressionNotes(prog, { chordLength: bar, octave: 4, style: 'rhythm', rhythm: 'x-xxx-x-x-xxx-x-', gate: 0.35, velocity: 0.7, voicing: 'close', center: 64 }) })
        },
        {
          name: 'Brass', bars: 4, color: '#f2a03d',
          notes: (bar) => ({ Brass: chordProgressionNotes(prog, { chordLength: bar, octave: 4, style: 'rhythm', rhythm: '------x---x-----', gate: 0.5, velocity: 0.75, voicing: 'close', center: 67 }) })
        },
        {
          name: 'Strings', bars: 4, color: '#b55e7a',
          notes: (bar) => ({ Strings: chordProgressionNotes(prog, { chordLength: bar, octave: 5, gate: 1, velocity: 0.55, voicing: 'open', center: 72 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Groove' }, { bar: 12, name: 'Strings' }],
      arrangement: [
        { pattern: 'Drums', track: 0, bar: 0, bars: 20, trackName: 'Drums' },
        { pattern: 'Guitar', track: 1, bar: 0, bars: 20, trackName: 'Guitar' },
        { pattern: 'Bass', track: 2, bar: 4, bars: 16, trackName: 'Bass' },
        { pattern: 'Brass', track: 3, bar: 4, bars: 16, trackName: 'Brass' },
        { pattern: 'Strings', track: 4, bar: 12, bars: 8, trackName: 'Strings' }
      ]
    };
  }
};
