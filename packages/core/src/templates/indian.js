// the Indian collection: a tanpura drone and a sitar alap, then the tabla's keherwa (Dha Ge Na Tin | Na Ke Dhin Na,
// ending on a TiRaKiTa) with a harmonium on Sa–Pa; the bansuri answers. Dha = Na + Ge and Dhin = Tin + Ge, so four
// bol channels (plus Te for the fill) play the whole theka.
import { melodyFromString } from '../builders.js';
import { steps } from './steps.js';

export default {
  label: 'Indian Fusion (92 BPM, C bhairav: sitar, tabla, tanpura, bansuri, harmonium)',
  spec: () => ({
    name: 'Indian Fusion', bpm: 92, key: 'C', scale: 'bhairav',
    channels: [
      { name: 'Tanpura', kind: 'tanpura', preset: 'Tanpura', volume: 0.95, sends: { Reverb: 0.25 } },
      { name: 'Na', kind: 'tabla', preset: 'Na', volume: 0.7, pan: 0.15, sends: { Reverb: 0.12 } },
      { name: 'Tin', kind: 'tabla', preset: 'Tin', volume: 0.85, pan: 0.15, sends: { Reverb: 0.12 } },
      { name: 'Te', kind: 'tabla', preset: 'Te', volume: 1, pan: 0.15 },
      { name: 'Ge', kind: 'tabla', preset: 'Ge Slide', volume: 0.55, pan: -0.15, sends: { Reverb: 0.1 } },
      { name: 'Ke', kind: 'tabla', preset: 'Ke', volume: 0.95, pan: -0.15 },
      { name: 'Sitar', kind: 'sitar', preset: 'Sitar', volume: 0.85, pan: -0.2, fx: [{ type: 'eq', params: { hpf: 100 } }], sends: { Reverb: 0.3 } },
      { name: 'Harmonium', kind: 'harmonium', preset: 'Soft', volume: 0.45, pan: 0.25, fx: [{ type: 'eq', params: { hpf: 150 } }], sends: { Reverb: 0.2 } },
      { name: 'Bansuri', kind: 'bansuri', preset: 'Bansuri', volume: 0.8, pan: 0.1, fx: [{ type: 'eq', params: { hpf: 200 } }], sends: { Reverb: 0.35, Delay: 0.18 } }
    ],
    buses: [
      { name: 'Reverb', fx: [{ type: 'reverb', params: { decay: 3, size: 0.7, predelay: 0.03, mix: 1 } }] },
      { name: 'Delay', fx: [{ type: 'delay', params: { time: '1/4d', feedback: 0.3, mix: 1 } }] }
    ],
    patterns: [
      {
        // Pa, Sa, Sa, low Sa: the tanpura's cycle, each string left to ring
        name: 'Tanpura', bars: 2, color: '#a0785a',
        notes: () => ({ Tanpura: melodyFromString('G2:8 C3:8 C3:8 C2:8', { velocity: 0.7, gate: 1 }) })
      },
      {
        name: 'Theka', bars: 2, color: '#b5651d',
        notes: () => ({
          Na: steps('X---x---x-----x- X---x---x------x'),
          Ge: steps('X-x---------x--- X-x-------------'),
          Tin: steps('------x-----x--- ------x---------'),
          Ke: steps('----------x----- ----------x---x-'),
          Te: steps('---------------- ------------xo--')
        })
      },
      {
        name: 'Sitar', bars: 4, color: '#d98b3a',
        notes: () => ({
          // "~" = meend: the note runs into the next one and the mono sitar slides there
          Sitar: melodyFromString('C4:4 Db4:2~ C4:2 B3:4 C4:4  E4:4 F4:2 E4:2~ Db4:4 C4:4  G4:6 Ab4:2~ G4:4 F4:4  E4:2 F4:2 E4:2~ Db4:2 C4:8', { velocity: 0.8, gate: 0.92 })
        })
      },
      {
        name: 'Harmonium', bars: 1, color: '#b5835a',
        notes: () => ({ Harmonium: [...melodyFromString('C4:16', { velocity: 0.6, gate: 1 }), ...melodyFromString('G3:16', { velocity: 0.55, gate: 1 })] })
      },
      {
        name: 'Bansuri', bars: 4, color: '#e0a458',
        notes: () => ({
          Bansuri: melodyFromString('G4:8 Ab4:4~ G4:4  F4:4 E4:4~ F4:8  E4:4 Db4:4 E4:4~ F4:4  E4:4~ Db4:4 C4:8', { velocity: 0.75, gate: 0.9 })
        })
      }
    ],
    markers: [{ bar: 0, name: 'Alap' }, { bar: 4, name: 'Theka' }, { bar: 12, name: 'Bansuri' }],
    arrangement: [
      { pattern: 'Tanpura', track: 0, bar: 0, bars: 20, trackName: 'Tanpura' },
      { pattern: 'Sitar', track: 1, bar: 0, bars: 12, trackName: 'Sitar' },
      { pattern: 'Theka', track: 2, bar: 4, bars: 16, trackName: 'Tabla' },
      { pattern: 'Harmonium', track: 3, bar: 4, bars: 16, trackName: 'Harmonium' },
      { pattern: 'Bansuri', track: 4, bar: 12, bars: 8, trackName: 'Bansuri' }
    ]
  })
};
