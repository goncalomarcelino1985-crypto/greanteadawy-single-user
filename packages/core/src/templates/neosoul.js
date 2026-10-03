// neo-soul: a lazy swung beat (snare and hats sit late), Rhodes in rootless voicings, a legato finger bass and a
// soft organ underneath (IVmaj9–vi9–ii9–V13: every rootless voicing's added 9th stays in the key)
import { chordProgressionNotes, bassLineFromChords } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Neo-Soul (84 BPM, Eb major: Rhodes, finger bass, organ)',
  spec: () => {
    const prog = ['Abmaj9', 'Cm9', 'Fm9', 'Bb13'];
    return {
      name: 'Neo-Soul', bpm: 84, key: 'Eb', scale: 'major', swing: 0.35,
      channels: [
        { name: 'Kick', kind: 'kick', preset: 'Lo-fi', volume: 0.8 },
        { name: 'Snare', kind: 'snare', preset: 'Rimmy', volume: 1, nudge: 18, sends: { Room: 0.15 } },
        { name: 'Hat', kind: 'hat', preset: 'Closed', volume: 0.7, nudge: 8, params: { color: 8000 } },
        { name: 'Rhodes', kind: 'epiano', preset: 'Suitcase', volume: 0.55, fx: [{ type: 'eq', params: { hpf: 120 } }], sends: { Room: 0.2 } },
        { name: 'Bass', kind: 'bass', preset: 'Finger', volume: 1, fx: [{ type: 'compressor', params: { threshold: -24, ratio: 4, attack: 0.015, makeup: 12 } }] },
        { name: 'Organ', kind: 'organ', preset: 'Soft', volume: 0.42, pan: 0.2, fx: [{ type: 'eq', params: { hpf: 200 } }], sends: { Room: 0.2 } }
      ],
      buses: [{ name: 'Room', fx: [{ type: 'reverb', params: { decay: 1.8, size: 0.45, predelay: 0.01, mix: 1 } }] }],
      patterns: [
        {
          name: 'Drums', bars: 2, color: '#46c79a',
          notes: () => ({
            Kick: steps('x------x-x------ x-----x---x-----'),
            Snare: steps('----X-------X--- ----X--o----X--o'),
            Hat: steps('x-xox-x-x-xox-xo x-xox-x-x-xox-x-', 60, { velocityScale: 0.85 })
          })
        },
        {
          name: 'Rhodes', bars: 4, color: '#d9a35f',
          notes: (bar) => ({ Rhodes: chordProgressionNotes(prog, { chordLength: bar, octave: 4, style: 'rhythm', rhythm: 'x------x--x-----', gate: 0.95, velocity: 0.62, voicing: 'rootless', center: 64 }) })
        },
        {
          name: 'Bass', bars: 4, color: '#a8613f',
          notes: (bar) => ({ Bass: bassLineFromChords(prog, 'R:6 -:1 R:1 5:4 7:2 8:2', { octave: 2, chordLength: bar, gate: 1, velocity: 0.8 }) })
        },
        {
          name: 'Organ', bars: 4, color: '#c4733f',
          notes: (bar) => ({ Organ: chordProgressionNotes(prog, { chordLength: bar, octave: 4, gate: 1, velocity: 0.5, voicing: 'shell', center: 60 }) })
        }
      ],
      markers: [{ bar: 0, name: 'Intro' }, { bar: 4, name: 'Verse' }],
      arrangement: [
        { pattern: 'Rhodes', track: 0, bar: 0, bars: 16, trackName: 'Rhodes' },
        { pattern: 'Drums', track: 1, bar: 4, bars: 12, trackName: 'Drums' },
        { pattern: 'Bass', track: 2, bar: 4, bars: 12, trackName: 'Bass' },
        { pattern: 'Organ', track: 3, bar: 4, bars: 12, trackName: 'Organ' }
      ]
    };
  }
};
