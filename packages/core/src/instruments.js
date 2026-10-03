import { validPluginId, sanitizeStoredPluginParams } from './plugins.js';

// Instrument catalog. Every channel in the Channel Rack has an instrument:
//   { kind: 'kick' | 'synth' | ..., preset: 'Punchy', params: {...} }
// Param definitions drive both the UI (knobs) and MCP validation.

const n = (key, label, min, max, def, extra = {}) => ({ key, label, type: 'number', min, max, default: def, ...extra });
const sel = (key, label, options, def, extra = {}) => ({ key, label, type: 'select', options, default: def, ...extra });
const bool = (key, label, def, extra = {}) => ({ key, label, type: 'bool', default: def, ...extra });

const WAVES = ['sine', 'triangle', 'square', 'sawtooth'];
const WAVES_OFF = ['off', ...WAVES, 'noise'];

const ampEnv = (a = 0.005, d = 0.3, s = 0.7, r = 0.2) => [
  n('attack', 'Attack', 0.001, 4, a, { curve: 'log', unit: 's', group: 'Amp envelope' }),
  n('decay', 'Decay', 0.01, 6, d, { curve: 'log', unit: 's', group: 'Amp envelope' }),
  n('sustain', 'Sustain', 0, 1, s, { group: 'Amp envelope' }),
  n('release', 'Release', 0.005, 8, r, { curve: 'log', unit: 's', group: 'Amp envelope' })
];

const osc = (i, wave, level, oct = 0, semi = 0, fine = 0) => [
  sel(`osc${i}Wave`, 'Wave', WAVES_OFF, wave, { group: `Oscillator ${i}` }),
  n(`osc${i}Level`, 'Level', 0, 1, level, { group: `Oscillator ${i}` }),
  n(`osc${i}Oct`, 'Octave', -3, 3, oct, { step: 1, group: `Oscillator ${i}` }),
  n(`osc${i}Semi`, 'Semi', -12, 12, semi, { step: 1, group: `Oscillator ${i}` }),
  n(`osc${i}Fine`, 'Fine', -100, 100, fine, { step: 1, unit: 'ct', group: `Oscillator ${i}` })
];

// Browser sections / add-channel menu, in display order: [category, label]
export const INSTRUMENT_CATEGORIES = [
  ['drums', 'Drums'], ['bass', 'Bass'], ['keys', 'Keys'], ['guitar', 'Guitar'], ['strings', 'Strings'], ['synth', 'Synths'],
  ['flutes', 'Flutes'], ['beatbox', 'Beatbox'], ['indian', 'Indian'], ['eastasian', 'East Asian'], ['sampler', 'Sampler'],
  ['plugins', 'Plugins']
];

const SA_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Mono/glide pair: overlapping notes slide (meend, slurs, bends). */
const legato = (mono, glide, max = 0.5) => [
  bool('mono', 'Mono', mono, { group: 'Voice' }),
  n('glide', 'Glide', 0, max, glide, { unit: 's', group: 'Voice' })
];

/** Vibrato depth/rate (delayed: it fades in after the attack, like a player's). */
const vibratoParams = (depth, rate) => [
  n('vibrato', 'Depth', 0, 1, depth, { group: 'Vibrato' }),
  n('vibratoRate', 'Rate', 3, 8, rate, { unit: 'Hz', group: 'Vibrato' })
];

/**
 * The breath engine shared by every flute (concert, pan, recorder, whistle, ocarina, bansuri, shakuhachi, dizi):
 * the kind picks the instrument's harmonic recipe; these params shape the playing.
 */
const windParams = (d = {}) => [
  n('tone', 'Tone', 0, 1, d.tone ?? 0.45, { group: 'Tone' }),
  n('breath', 'Breath', 0, 1, d.breath ?? 0.3, { group: 'Tone' }),
  n('chiff', 'Chiff', 0, 1, d.chiff ?? 0.4, { group: 'Tone' }),
  ...(d.buzz !== undefined ? [n('buzz', 'Membrane', 0, 1, d.buzz, { group: 'Tone' })] : []),
  ...vibratoParams(d.vibrato ?? 0.3, d.vibratoRate ?? 5),
  n('attack', 'Attack', 0.005, 2, d.attack ?? 0.04, { unit: 's', curve: 'log', group: 'Voice' }),
  n('release', 'Release', 0.02, 3, d.release ?? 0.15, { unit: 's', curve: 'log', group: 'Voice' }),
  ...legato(d.mono ?? false, d.glide ?? 0.08),
  n('gain', 'Gain', 0, 2, d.gain ?? 0.7, { group: 'Voice' })
];
const WIND_HELP = 'Harder notes (velocity) and tone overblow brighter; breath = air noise, chiff = the tongued attack; vibrato fades in after the attack.';

/** Double reeds (shehnai, suona). */
const reedParams = (d = {}) => [
  n('tone', 'Tone', 0, 1, d.tone ?? 0.6, { group: 'Tone' }),
  n('nasal', 'Nasal', 0, 1, d.nasal ?? 0.6, { group: 'Tone' }),
  n('breath', 'Breath', 0, 1, d.breath ?? 0.15, { group: 'Tone' }),
  ...vibratoParams(d.vibrato ?? 0.35, d.vibratoRate ?? 5.5),
  n('attack', 'Attack', 0.005, 2, d.attack ?? 0.03, { unit: 's', curve: 'log', group: 'Voice' }),
  n('release', 'Release', 0.02, 3, d.release ?? 0.12, { unit: 's', curve: 'log', group: 'Voice' }),
  ...legato(d.mono ?? true, d.glide ?? 0.08),
  n('gain', 'Gain', 0, 2, d.gain ?? 0.6, { group: 'Voice' })
];

/** Physical-model plucked strings of the world collections (rendered per note like the guitar). */
const pluckParams = (d = {}) => [
  n('brightness', 'Brightness', 0, 1, d.brightness ?? 0.65, { group: 'Tone' }),
  n('sustain', 'Sustain', d.sustainMin ?? 0.3, d.sustainMax ?? 8, d.sustain ?? 2, { unit: 's', curve: 'log', group: 'Tone' }),
  ...(d.position !== undefined ? [n('position', 'Pluck point', 0.05, 0.4, d.position, { group: 'Tone' })] : []),
  n('release', 'Release', 0.02, 4, d.release ?? 0.2, { unit: 's', curve: 'log', group: 'Voice' }),
  ...(d.mono !== undefined ? legato(d.mono, d.glide ?? 0.12) : []),
  n('gain', 'Gain', 0, 2, d.gain ?? 0.8, { group: 'Voice' })
];

export const INSTRUMENTS = {
  kick: {
    label: 'Kick', category: 'drums', melodic: false, defaultKey: 60, gm: 36, color: '#e8665a',
    description: 'Synthesized kick drum (sine with pitch sweep, click and drive).',
    params: [
      n('tune', 'Pitch', 30, 150, 50, { unit: 'Hz', curve: 'log' }),
      n('sweep', 'Sweep from', 80, 800, 230, { unit: 'Hz', curve: 'log' }),
      n('sweepTime', 'Sweep time', 0.005, 0.3, 0.05, { unit: 's', curve: 'log' }),
      n('decay', 'Decay', 0.05, 2.5, 0.5, { unit: 's', curve: 'log' }),
      n('click', 'Click', 0, 1, 0.35),
      n('drive', 'Drive', 0, 1, 0.15)
    ],
    presets: {
      Punchy: {},
      Deep: { tune: 42, sweep: 160, decay: 0.9, click: 0.15, drive: 0.1 },
      Hard: { tune: 55, sweep: 400, sweepTime: 0.03, decay: 0.35, click: 0.7, drive: 0.55 },
      'House Thump': { tune: 50, sweep: 200, sweepTime: 0.06, decay: 0.45, click: 0.3, drive: 0.25 },
      'Lo-fi': { tune: 48, sweep: 140, decay: 0.3, click: 0.05, drive: 0.4 },
      // short (gone before the 808 sustains) and low (~45 Hz), clear of 808 lines around 50–80 Hz
      Trap: { tune: 45, sweep: 300, sweepTime: 0.025, decay: 0.28, click: 0.55, drive: 0.35 }
    }
  },
  snare: {
    label: 'Snare', category: 'drums', melodic: false, defaultKey: 60, gm: 38, color: '#f2a03d',
    description: 'Synthesized snare: tuned body + filtered noise.',
    params: [
      n('tone', 'Body pitch', 100, 400, 185, { unit: 'Hz', curve: 'log' }),
      n('toneDecay', 'Body decay', 0.02, 0.6, 0.1, { unit: 's', curve: 'log' }),
      n('noiseDecay', 'Noise decay', 0.03, 1, 0.18, { unit: 's', curve: 'log' }),
      n('snappy', 'Snappy', 0, 1, 0.7),
      n('color', 'Noise color', 800, 12000, 4500, { unit: 'Hz', curve: 'log' })
    ],
    presets: {
      Tight: {},
      Fat: { tone: 160, toneDecay: 0.18, noiseDecay: 0.28, snappy: 0.6, color: 3500 },
      Trap: { tone: 210, toneDecay: 0.08, noiseDecay: 0.22, snappy: 0.85, color: 6000 },
      Rimmy: { tone: 330, toneDecay: 0.05, noiseDecay: 0.09, snappy: 0.5, color: 7000 }
    }
  },
  clap: {
    label: 'Clap', category: 'drums', melodic: false, defaultKey: 60, gm: 39, color: '#f5d547',
    description: 'Multi-burst noise hand clap.',
    params: [
      n('decay', 'Decay', 0.05, 1.2, 0.22, { unit: 's', curve: 'log' }),
      n('color', 'Color', 400, 6000, 1200, { unit: 'Hz', curve: 'log' }),
      n('spread', 'Spread', 0.004, 0.03, 0.011, { unit: 's' }),
      n('room', 'Room', 0, 1, 0.3)
    ],
    presets: { Classic: {}, Tight: { decay: 0.12, spread: 0.007, room: 0.1 }, Big: { decay: 0.45, color: 1000, spread: 0.016, room: 0.7 } }
  },
  hat: {
    label: 'Hi-hat', category: 'drums', melodic: false, defaultKey: 60, gm: 42, color: '#8bd65b',
    description: 'Metallic 808-style hi-hat. Use short decay for closed, long for open. Put open & closed hats in the same choke group.',
    params: [
      n('decay', 'Decay', 0.01, 2, 0.06, { unit: 's', curve: 'log' }),
      n('color', 'Color', 3000, 15000, 9000, { unit: 'Hz', curve: 'log' }),
      n('metallic', 'Metallic', 0, 1, 0.7)
    ],
    presets: { Closed: {}, Open: { decay: 0.45 }, Pedal: { decay: 0.03, color: 6500 }, Crisp: { decay: 0.04, color: 12000, metallic: 0.4 } }
  },
  tom: {
    label: 'Tom', category: 'drums', melodic: false, defaultKey: 60, gm: 45, color: '#46c79a',
    params: [
      n('pitch', 'Pitch', 50, 400, 110, { unit: 'Hz', curve: 'log' }),
      n('sweep', 'Sweep', 0, 1, 0.4),
      n('decay', 'Decay', 0.05, 1.5, 0.35, { unit: 's', curve: 'log' })
    ],
    presets: { Mid: {}, Low: { pitch: 80, decay: 0.5 }, High: { pitch: 170, decay: 0.25 } }
  },
  rim: {
    label: 'Rimshot', category: 'drums', melodic: false, defaultKey: 60, gm: 37, color: '#3fb5d6',
    params: [
      n('pitch', 'Pitch', 300, 2000, 800, { unit: 'Hz', curve: 'log' }),
      n('decay', 'Decay', 0.01, 0.2, 0.04, { unit: 's', curve: 'log' })
    ],
    presets: { Classic: {} }
  },
  cowbell: {
    label: 'Cowbell', category: 'drums', melodic: false, defaultKey: 60, gm: 56, color: '#5a8ef0',
    params: [
      n('pitch', 'Pitch', 300, 1200, 560, { unit: 'Hz', curve: 'log' }),
      n('decay', 'Decay', 0.05, 1, 0.25, { unit: 's', curve: 'log' })
    ],
    presets: { '808': {} }
  },
  cymbal: {
    label: 'Cymbal', category: 'drums', melodic: false, defaultKey: 60, gm: 49, color: '#8f6cf0',
    params: [
      n('decay', 'Decay', 0.3, 5, 1.8, { unit: 's', curve: 'log' }),
      n('color', 'Color', 3000, 14000, 7000, { unit: 'Hz', curve: 'log' })
    ],
    presets: { Crash: {}, Ride: { decay: 2.5, color: 10000 }, Splash: { decay: 0.6, color: 9000 } }
  },
  shaker: {
    label: 'Shaker', category: 'drums', melodic: false, defaultKey: 60, gm: 70, color: '#c86be0',
    params: [
      n('decay', 'Decay', 0.02, 0.4, 0.07, { unit: 's', curve: 'log' }),
      n('color', 'Color', 2000, 14000, 7000, { unit: 'Hz', curve: 'log' })
    ],
    presets: { Classic: {}, Soft: { decay: 0.12, color: 4500 } }
  },
  perc: {
    label: 'Perc', category: 'drums', melodic: false, defaultKey: 60, gm: 64, color: '#e664a7',
    description: 'Tonal percussion blip (congas, bongos, zaps). Follows note pitch.',
    params: [
      sel('wave', 'Wave', WAVES, 'sine'),
      n('pitch', 'Pitch', 100, 2000, 400, { unit: 'Hz', curve: 'log' }),
      n('sweep', 'Sweep', 0, 1, 0.3),
      n('decay', 'Decay', 0.02, 1, 0.12, { unit: 's', curve: 'log' }),
      n('noise', 'Noise', 0, 1, 0.1)
    ],
    presets: { Conga: {}, Bongo: { pitch: 620, decay: 0.08 }, Zap: { wave: 'square', pitch: 1500, sweep: 1, decay: 0.15, noise: 0 }, Woodblock: { wave: 'triangle', pitch: 1100, decay: 0.05, sweep: 0.1 } }
  },
  bass808: {
    label: '808 Bass', category: 'bass', melodic: true, defaultKey: 36, color: '#d98c5f',
    description: 'Long sine 808 with pitch punch, drive and glide. Monophonic: overlapping notes glide (slide).',
    params: [
      n('decay', 'Decay', 0.1, 4, 1.1, { unit: 's', curve: 'log' }),
      n('punch', 'Punch', 0, 24, 7, { unit: 'st' }),
      n('punchTime', 'Punch time', 0.005, 2, 0.03, { unit: 's', curve: 'log' }),
      n('drive', 'Drive', 0, 1, 0.3),
      n('click', 'Click', 0, 1, 0.15),
      n('tone', 'Tone', 200, 8000, 2500, { unit: 'Hz', curve: 'log' }),
      n('glide', 'Glide', 0, 0.4, 0.06, { unit: 's' }),
      bool('mono', 'Mono', true)
    ],
    presets: {
      Classic: {},
      Distorted: { drive: 0.8, tone: 4000, decay: 1.4 },
      Clean: { drive: 0.05, click: 0.05, punch: 3 },
      Long: { decay: 2.6, glide: 0.1 },
      Short: { decay: 0.35, punch: 10 },
      'Sub Drop': { punch: 24, punchTime: 1.4, decay: 3, drive: 0.2, click: 0, tone: 1200, mono: false }
    }
  },
  synth: {
    label: 'Subtractive Synth', category: 'synth', melodic: true, defaultKey: 60, color: '#3fb5d6',
    description: 'Subtractive synth: 3 oscillators, unison, resonant filter with envelope, LFO, mono/glide.',
    params: [
      ...osc(1, 'sawtooth', 0.8),
      ...osc(2, 'sawtooth', 0.6, 0, 0, 8),
      ...osc(3, 'off', 0.5, -1),
      n('unison', 'Voices', 1, 7, 1, { step: 1, group: 'Unison' }),
      n('unisonDetune', 'Detune', 0, 100, 18, { unit: 'ct', group: 'Unison' }),
      n('unisonSpread', 'Stereo', 0, 1, 0.6, { group: 'Unison' }),
      sel('filterType', 'Type', ['lowpass', 'highpass', 'bandpass'], 'lowpass', { group: 'Filter' }),
      n('cutoff', 'Cutoff', 20, 20000, 4500, { unit: 'Hz', curve: 'log', group: 'Filter' }),
      n('resonance', 'Resonance', 0.1, 20, 1, { curve: 'log', group: 'Filter' }),
      n('filterEnv', 'Env amount', -1, 1, 0.25, { group: 'Filter' }),
      n('keyTrack', 'Key track', 0, 1, 0.3, { group: 'Filter' }),
      n('fAttack', 'Attack', 0.001, 4, 0.005, { curve: 'log', unit: 's', group: 'Filter envelope' }),
      n('fDecay', 'Decay', 0.01, 6, 0.3, { curve: 'log', unit: 's', group: 'Filter envelope' }),
      n('fSustain', 'Sustain', 0, 1, 0.3, { group: 'Filter envelope' }),
      n('fRelease', 'Release', 0.005, 8, 0.3, { curve: 'log', unit: 's', group: 'Filter envelope' }),
      ...ampEnv(0.005, 0.3, 0.75, 0.2),
      n('lfoRate', 'Rate', 0.05, 20, 5, { unit: 'Hz', curve: 'log', group: 'LFO' }),
      n('lfoDepth', 'Depth', 0, 1, 0, { group: 'LFO' }),
      sel('lfoTarget', 'Target', ['pitch', 'filter', 'amp'], 'pitch', { group: 'LFO' }),
      bool('mono', 'Mono', false, { group: 'Voice' }),
      n('glide', 'Glide', 0, 1, 0, { unit: 's', group: 'Voice' }),
      n('gain', 'Gain', 0, 2, 0.6, { group: 'Voice' })
    ],
    presets: {
      'Saw Lead': {},
      Supersaw: { osc2Wave: 'off', unison: 7, unisonDetune: 28, cutoff: 9000, filterEnv: 0.1, attack: 0.01, release: 0.35, gain: 0.45 },
      'Square Lead': { osc1Wave: 'square', osc2Wave: 'square', osc2Fine: -7, osc2Oct: 1, osc2Level: 0.3, cutoff: 3200, resonance: 2, release: 0.15 },
      'Soft Pad': { osc1Wave: 'sawtooth', osc2Wave: 'triangle', osc2Oct: 1, unison: 3, unisonDetune: 14, cutoff: 1600, filterEnv: 0.15, fAttack: 0.8, attack: 0.7, decay: 1.5, sustain: 0.8, release: 1.6, lfoTarget: 'filter', lfoRate: 0.3, lfoDepth: 0.25, gain: 0.45 },
      Pluck: { osc1Wave: 'sawtooth', osc2Wave: 'square', osc2Oct: 1, osc2Level: 0.25, cutoff: 500, resonance: 2.5, filterEnv: 0.75, fDecay: 0.18, fSustain: 0, attack: 0.002, decay: 0.35, sustain: 0, release: 0.25 },
      'Sub Bass': { osc1Wave: 'sine', osc1Level: 1, osc2Wave: 'triangle', osc2Level: 0.15, cutoff: 600, filterEnv: 0, attack: 0.004, decay: 0.2, sustain: 1, release: 0.1, mono: true, glide: 0.03, gain: 0.8 },
      'Reese Bass': { osc1Wave: 'sawtooth', osc2Wave: 'sawtooth', osc2Fine: 14, osc1Fine: -14, unison: 2, unisonDetune: 20, cutoff: 900, resonance: 2, filterEnv: 0.1, lfoTarget: 'filter', lfoRate: 0.5, lfoDepth: 0.3, mono: true, glide: 0.05, release: 0.15 },
      'Acid Bass': { osc1Wave: 'sawtooth', osc2Wave: 'off', cutoff: 380, resonance: 14, filterEnv: 0.8, fDecay: 0.2, fSustain: 0.05, decay: 0.2, sustain: 0.6, release: 0.08, mono: true, glide: 0.06 },
      'Chord Stab': { osc1Wave: 'sawtooth', osc2Wave: 'square', osc2Level: 0.3, unison: 3, unisonDetune: 16, cutoff: 2800, filterEnv: 0.4, fDecay: 0.15, fSustain: 0.1, decay: 0.25, sustain: 0.1, release: 0.18 },
      Brass: { osc1Wave: 'sawtooth', osc2Wave: 'sawtooth', osc2Fine: 6, cutoff: 900, filterEnv: 0.55, fAttack: 0.08, fDecay: 0.6, fSustain: 0.5, attack: 0.04, sustain: 0.85, release: 0.25 },
      Organ: { osc1Wave: 'sine', osc1Level: 0.8, osc2Wave: 'sine', osc2Oct: 1, osc2Level: 0.5, osc3Wave: 'sine', osc3Oct: 1, osc3Semi: 7, osc3Level: 0.3, cutoff: 8000, filterEnv: 0, attack: 0.005, sustain: 1, release: 0.06, lfoTarget: 'amp', lfoRate: 6, lfoDepth: 0.1 },
      'Arp Blip': { osc1Wave: 'square', osc2Wave: 'off', cutoff: 3500, filterEnv: 0.3, fDecay: 0.08, fSustain: 0, decay: 0.12, sustain: 0, release: 0.05 },
      'Warm Keys': { osc1Wave: 'triangle', osc2Wave: 'sawtooth', osc2Level: 0.25, cutoff: 1800, filterEnv: 0.35, fDecay: 0.5, fSustain: 0.2, attack: 0.004, decay: 1.2, sustain: 0.35, release: 0.4 },
      'Lo-fi Keys': { osc1Wave: 'triangle', osc2Wave: 'sine', osc2Oct: 1, osc2Level: 0.35, cutoff: 1400, keyTrack: 0.5, filterEnv: 0.3, fDecay: 0.6, fSustain: 0.15, attack: 0.006, decay: 1.6, sustain: 0.25, release: 0.5, lfoTarget: 'pitch', lfoRate: 0.7, lfoDepth: 0.12, gain: 0.55 },
      Strings: { osc1Wave: 'sawtooth', osc2Wave: 'sawtooth', osc2Fine: -9, osc2Level: 0.7, unison: 5, unisonDetune: 12, unisonSpread: 0.8, cutoff: 2600, keyTrack: 0.4, filterEnv: 0.1, fAttack: 0.4, attack: 0.35, decay: 1, sustain: 0.9, release: 0.9, lfoTarget: 'pitch', lfoRate: 5.2, lfoDepth: 0.06, gain: 0.4 },
      // an open filter: risers are swept with the channel filter (automation), which needs the full spectrum
      'Riser Noise': { osc1Wave: 'noise', osc1Level: 1, osc2Wave: 'sawtooth', osc2Level: 0.15, unison: 3, unisonDetune: 25, filterType: 'lowpass', cutoff: 14000, resonance: 1.5, keyTrack: 0, filterEnv: 0, attack: 0.05, decay: 1, sustain: 1, release: 0.4, gain: 0.45 },
      'Reverse Swell': { osc1Wave: 'noise', osc1Level: 0.8, osc2Wave: 'sawtooth', osc2Level: 0.2, unison: 3, filterType: 'highpass', cutoff: 1200, keyTrack: 0, filterEnv: 0, attack: 1.5, decay: 0.1, sustain: 1, release: 0.03, gain: 0.45 }
    }
  },
  fm: {
    label: 'FM Synth', category: 'synth', melodic: true, defaultKey: 60, color: '#8f6cf0',
    description: '2-operator FM synth: e-pianos, bells, mallets, metallic basses.',
    params: [
      sel('carrierWave', 'Carrier', WAVES, 'sine', { group: 'Operators' }),
      n('ratio', 'Mod ratio', 0.25, 16, 2, { step: 0.25, group: 'Operators' }),
      n('index', 'Mod index', 0, 30, 4, { group: 'Operators' }),
      n('indexDecay', 'Index decay', 0.01, 4, 0.6, { unit: 's', curve: 'log', group: 'Operators' }),
      n('indexSustain', 'Index sustain', 0, 1, 0.2, { group: 'Operators' }),
      n('detune', 'Detune', -50, 50, 0, { unit: 'ct', group: 'Operators' }),
      ...ampEnv(0.003, 1, 0.3, 0.4),
      n('gain', 'Gain', 0, 2, 0.6, { group: 'Voice' })
    ],
    presets: {
      'E-Piano': { ratio: 1, index: 2.5, indexDecay: 1.2, indexSustain: 0.15, decay: 1.6, sustain: 0.3, release: 0.5 },
      Bell: { ratio: 3.5, index: 6, indexDecay: 2, indexSustain: 0.1, decay: 3, sustain: 0, release: 2 },
      'FM Bass': { ratio: 1, index: 4, indexDecay: 0.15, indexSustain: 0.2, decay: 0.3, sustain: 0.7, release: 0.1, gain: 0.7 },
      Mallet: { ratio: 4, index: 3, indexDecay: 0.08, indexSustain: 0, decay: 0.4, sustain: 0, release: 0.3 },
      Glass: { carrierWave: 'sine', ratio: 7, index: 2, indexDecay: 0.6, indexSustain: 0.3, attack: 0.01, decay: 2, sustain: 0.2, release: 1.5 },
      'Felt Piano': { ratio: 1, index: 1.8, indexDecay: 0.4, indexSustain: 0.05, detune: -4, attack: 0.002, decay: 2.5, sustain: 0, release: 0.6, gain: 0.7 }
    }
  },
  // ---------------------------------------------------------------- band instruments (GarageBand-style)
  // piano, guitar, bass and pizzicato are physical models rendered per note (client/src/audio/models.js);
  // epiano, organ and legato/staccato strings are oscillator engines.
  piano: {
    label: 'Grand Piano', category: 'keys', melodic: true, defaultKey: 60, color: '#e4d9b8',
    description: 'Modelled acoustic piano: inharmonic strings, hammer hardness follows velocity, two-stage decay and beating unison strings. A note rings until its end (long notes = sustain pedal); keys above G6 have no dampers. stereo spreads low keys left and high keys right.',
    params: [
      n('brightness', 'Brightness', 0, 1, 0.55, { group: 'Tone' }),
      n('hardness', 'Hammer', 0, 1, 0.5, { group: 'Tone' }),
      n('decay', 'Decay', 1, 20, 12, { unit: 's', curve: 'log', group: 'Tone' }),
      n('detune', 'Unison detune', 0, 10, 1.2, { unit: 'ct', group: 'Tone' }),
      n('release', 'Damper', 0.02, 2, 0.25, { unit: 's', curve: 'log', group: 'Voice' }),
      n('stereo', 'Stereo', 0, 1, 0.5, { group: 'Voice' }),
      n('gain', 'Gain', 0, 2, 0.8, { group: 'Voice' })
    ],
    presets: {
      Grand: {},
      Bright: { brightness: 0.8, hardness: 0.75 },
      Upright: { brightness: 0.45, decay: 7, detune: 2.5, stereo: 0.25 },
      Felt: { brightness: 0.2, hardness: 0.15, decay: 8, release: 0.4 },
      'Honky Tonk': { brightness: 0.7, decay: 8, detune: 10, stereo: 0.3 }
    }
  },
  epiano: {
    label: 'Electric Piano', category: 'keys', melodic: true, defaultKey: 60, color: '#d9a35f',
    description: 'Tine (Rhodes-style) or reed (Wurlitzer-style) electric piano: harder notes bark, a bell "ding" on the attack, stereo tremolo (tine) or amplitude tremolo (reed) that stays in phase across notes.',
    params: [
      sel('model', 'Model', ['tine', 'reed'], 'tine', { group: 'Tone' }),
      n('bark', 'Bark', 0, 1, 0.45, { group: 'Tone' }),
      n('bell', 'Bell', 0, 1, 0.4, { group: 'Tone' }),
      n('decay', 'Decay', 0.5, 10, 3.5, { unit: 's', curve: 'log', group: 'Tone' }),
      n('release', 'Release', 0.02, 2, 0.18, { unit: 's', curve: 'log', group: 'Tone' }),
      n('tremoloRate', 'Rate', 0.5, 10, 4.5, { unit: 'Hz', curve: 'log', group: 'Tremolo' }),
      n('tremoloDepth', 'Depth', 0, 1, 0, { group: 'Tremolo' }),
      n('gain', 'Gain', 0, 2, 0.7, { group: 'Voice' })
    ],
    presets: {
      Suitcase: { tremoloDepth: 0.45 },
      Mellow: { bark: 0.2, bell: 0.2, decay: 4.5 },
      'Bright Tines': { bark: 0.7, bell: 0.7 },
      Tremolo: { tremoloDepth: 0.8, tremoloRate: 5.5 },
      Wurli: { model: 'reed', bark: 0.55, bell: 0.15, decay: 2.5, tremoloDepth: 0.3, tremoloRate: 5.5 }
    }
  },
  organ: {
    label: 'Drawbar Organ', category: 'keys', melodic: true, defaultKey: 60, color: '#c4733f',
    description: 'Tonewheel organ with nine drawbars (16\' 5⅓\' 8\' 4\' 2⅔\' 2\' 1⅗\' 1⅓\' 1\', 0–8 each), percussion, key click, overdrive and a rotary speaker (slow/fast) shared by all notes. Sustains while held; barely velocity-sensitive, like the real thing.',
    params: [
      n('db16', "16'", 0, 8, 8, { step: 1, group: 'Drawbars' }),
      n('db513', "5⅓'", 0, 8, 8, { step: 1, group: 'Drawbars' }),
      n('db8', "8'", 0, 8, 8, { step: 1, group: 'Drawbars' }),
      n('db4', "4'", 0, 8, 0, { step: 1, group: 'Drawbars' }),
      n('db223', "2⅔'", 0, 8, 0, { step: 1, group: 'Drawbars' }),
      n('db2', "2'", 0, 8, 0, { step: 1, group: 'Drawbars' }),
      n('db135', "1⅗'", 0, 8, 0, { step: 1, group: 'Drawbars' }),
      n('db113', "1⅓'", 0, 8, 0, { step: 1, group: 'Drawbars' }),
      n('db1', "1'", 0, 8, 0, { step: 1, group: 'Drawbars' }),
      bool('percussion', 'On', false, { group: 'Percussion' }),
      sel('percHarmonic', 'Harmonic', ['second', 'third'], 'third', { group: 'Percussion' }),
      n('percDecay', 'Decay', 0.1, 1.5, 0.3, { unit: 's', curve: 'log', group: 'Percussion' }),
      n('click', 'Key click', 0, 1, 0.3, { group: 'Voice' }),
      sel('rotary', 'Rotary', ['off', 'slow', 'fast'], 'slow', { group: 'Voice' }),
      n('drive', 'Drive', 0, 1, 0.15, { group: 'Voice' }),
      n('gain', 'Gain', 0, 2, 0.6, { group: 'Voice' })
    ],
    presets: {
      Jazz: { db513: 8, db8: 8, percussion: true, percHarmonic: 'third', click: 0.35 },
      Gospel: { db16: 8, db513: 8, db8: 8, db4: 8, db223: 0, db2: 0, db135: 0, db113: 0, db1: 8, rotary: 'fast', drive: 0.3 },
      Rock: { db16: 8, db513: 8, db8: 8, db4: 8, db223: 6, db2: 4, db135: 0, db113: 0, db1: 0, drive: 0.7, rotary: 'fast', click: 0.5 },
      Soft: { db16: 0, db513: 0, db8: 6, db4: 4, db223: 0, db2: 0, click: 0.05, rotary: 'slow', drive: 0 },
      Church: { db16: 8, db513: 6, db8: 8, db4: 8, db223: 5, db2: 6, db135: 4, db113: 4, db1: 6, click: 0, rotary: 'off', drive: 0 }
    }
  },
  guitar: {
    label: 'Guitar', category: 'guitar', melodic: true, defaultKey: 52, color: '#b8864b',
    description: 'Modelled plucked guitar string (Karplus–Strong) with an acoustic or nylon body or an electric pickup; harder notes are brighter. position = pluck point (0.05 near the bridge = twangy, 0.5 = round), mute = palm mute, drive = amp overdrive.',
    params: [
      sel('body', 'Body', ['acoustic', 'nylon', 'electric'], 'acoustic', { group: 'Tone' }),
      n('brightness', 'Brightness', 0, 1, 0.6, { group: 'Tone' }),
      n('position', 'Pluck point', 0.05, 0.5, 0.18, { group: 'Tone' }),
      n('sustain', 'Sustain', 0.5, 10, 4, { unit: 's', curve: 'log', group: 'Tone' }),
      n('mute', 'Palm mute', 0, 1, 0, { group: 'Tone' }),
      n('drive', 'Drive', 0, 1, 0, { group: 'Amp' }),
      n('release', 'Release', 0.02, 1, 0.08, { unit: 's', curve: 'log', group: 'Voice' }),
      n('gain', 'Gain', 0, 2, 0.8, { group: 'Voice' })
    ],
    presets: {
      Acoustic: {},
      Nylon: { body: 'nylon', brightness: 0.4, position: 0.25, sustain: 3 },
      'Clean Electric': { body: 'electric', brightness: 0.55, position: 0.12, sustain: 5 },
      Muted: { body: 'electric', mute: 0.75, brightness: 0.5, position: 0.1, release: 0.04 },
      Overdrive: { body: 'electric', brightness: 0.7, position: 0.1, sustain: 6, drive: 0.6, gain: 0.55 }
    }
  },
  bass: {
    label: 'Bass Guitar', category: 'bass', melodic: true, defaultKey: 36, color: '#a8613f',
    description: 'Modelled electric or upright bass: finger, pick, slap or upright style; harder notes are brighter. Mono by default: overlapping notes slide (glide time).',
    params: [
      sel('style', 'Style', ['finger', 'pick', 'slap', 'upright'], 'finger', { group: 'Tone' }),
      n('brightness', 'Brightness', 0, 1, 0.4, { group: 'Tone' }),
      n('sustain', 'Sustain', 0.3, 8, 3, { unit: 's', curve: 'log', group: 'Tone' }),
      n('mute', 'Palm mute', 0, 1, 0, { group: 'Tone' }),
      n('drive', 'Drive', 0, 1, 0, { group: 'Amp' }),
      n('release', 'Release', 0.02, 1, 0.06, { unit: 's', curve: 'log', group: 'Voice' }),
      bool('mono', 'Mono', true, { group: 'Voice' }),
      n('glide', 'Glide', 0, 0.3, 0.05, { unit: 's', group: 'Voice' }),
      n('gain', 'Gain', 0, 2, 0.8, { group: 'Voice' })
    ],
    presets: {
      Finger: {},
      Pick: { style: 'pick', brightness: 0.55 },
      Slap: { style: 'slap', brightness: 0.6, sustain: 2 },
      Muted: { mute: 0.7, brightness: 0.3, sustain: 1.5 },
      Upright: { style: 'upright', brightness: 0.3, sustain: 2, release: 0.12 }
    }
  },
  strings: {
    label: 'String Ensemble', category: 'strings', melodic: true, defaultKey: 60, color: '#b55e7a',
    description: 'Bowed string section or soloist: ensemble = players per note (1 = solo), delayed vibrato, legato (sustained), staccato (short bow) or pizzicato (modelled pluck) articulation. Harder notes bow brighter and attack faster.',
    params: [
      sel('articulation', 'Articulation', ['legato', 'staccato', 'pizzicato'], 'legato', { group: 'Bow' }),
      n('ensemble', 'Players', 1, 8, 5, { step: 1, group: 'Bow' }),
      n('attack', 'Attack', 0.01, 3, 0.25, { unit: 's', curve: 'log', group: 'Bow' }),
      n('release', 'Release', 0.05, 4, 0.6, { unit: 's', curve: 'log', group: 'Bow' }),
      n('brightness', 'Brightness', 0, 1, 0.5, { group: 'Tone' }),
      n('vibrato', 'Vibrato', 0, 1, 0.35, { group: 'Tone' }),
      n('vibratoRate', 'Vibrato rate', 3, 8, 5.2, { unit: 'Hz', group: 'Tone' }),
      n('gain', 'Gain', 0, 2, 0.7, { group: 'Voice' })
    ],
    presets: {
      Ensemble: {},
      'Slow Strings': { attack: 1.2, release: 1.5, brightness: 0.35, vibrato: 0.25 },
      'Solo Cello': { ensemble: 1, attack: 0.12, brightness: 0.45, vibrato: 0.6, vibratoRate: 5, release: 0.35 },
      'Solo Violin': { ensemble: 1, attack: 0.08, brightness: 0.65, vibrato: 0.6, vibratoRate: 5.8, release: 0.3 },
      Staccato: { articulation: 'staccato', ensemble: 6, attack: 0.02, brightness: 0.6, vibrato: 0 },
      Pizzicato: { articulation: 'pizzicato', brightness: 0.5, vibrato: 0 }
    }
  },
  // ---------------------------------------------------------------- flutes (one breath engine, a voicing per kind)
  flute: {
    label: 'Flute', category: 'flutes', melodic: true, defaultKey: 72, color: '#7fc8e8',
    description: `Concert flute: a pure, breathy tone (C4–C7). The Alto Flute and Piccolo presets change the tone only: write them a fourth lower / an octave higher. ${WIND_HELP} mono=true slurs overlapping notes.`,
    params: windParams(),
    presets: {
      Concert: {},
      Breathy: { breath: 0.6, tone: 0.3, chiff: 0.5 },
      'Lo-fi Flute': { breath: 0.5, tone: 0.25, vibrato: 0.45, vibratoRate: 4.5, release: 0.3 },
      'Trap Flute': { tone: 0.55, breath: 0.35, chiff: 0.5, vibrato: 0.2, mono: true, glide: 0.05 },
      'Alto Flute': { tone: 0.3, breath: 0.45, vibrato: 0.35, attack: 0.06 },
      Piccolo: { tone: 0.6, breath: 0.15, chiff: 0.5, vibrato: 0.25, vibratoRate: 5.8 }
    }
  },
  panflute: {
    label: 'Pan Flute', category: 'flutes', melodic: true, defaultKey: 72, color: '#9fd6a0',
    description: `Pan pipes: a hollow, breathy tone with a puff of air on every note and little vibrato. ${WIND_HELP}`,
    params: windParams({ tone: 0.25, breath: 0.55, chiff: 0.75, vibrato: 0.15, attack: 0.02, release: 0.2 }),
    presets: {
      Andes: {},
      Soft: { chiff: 0.4, breath: 0.4, attack: 0.05 },
      Airy: { breath: 0.85, tone: 0.15 },
      'Zampoña': { tone: 0.4, chiff: 0.9, breath: 0.6, vibrato: 0.05 }
    }
  },
  recorder: {
    label: 'Recorder', category: 'flutes', melodic: true, defaultKey: 72, color: '#c9b27a',
    description: `Wooden recorder: a clear, slightly reedy tone with a crisp tongued attack, little breath and light vibrato. ${WIND_HELP}`,
    params: windParams({ tone: 0.35, breath: 0.12, chiff: 0.55, vibrato: 0.12, attack: 0.015, release: 0.08 }),
    presets: { Soprano: {}, 'Alto Recorder': { tone: 0.25, breath: 0.18, chiff: 0.45 }, Baroque: { vibrato: 0.25, chiff: 0.4, release: 0.12 } }
  },
  whistle: {
    label: 'Tin Whistle', category: 'flutes', melodic: true, defaultKey: 74, color: '#bfe3f0',
    description: `Irish tin whistle / low whistle: bright and pure with crisp tongued attacks. Mono with a short glide: overlapping notes slur (cuts and slides). ${WIND_HELP}`,
    params: windParams({ tone: 0.55, breath: 0.25, chiff: 0.6, vibrato: 0.1, attack: 0.012, release: 0.06, mono: true, glide: 0.03 }),
    presets: { Irish: {}, 'Low Whistle': { tone: 0.3, breath: 0.45, vibrato: 0.25, attack: 0.03, release: 0.12 } }
  },
  ocarina: {
    label: 'Ocarina', category: 'flutes', melodic: true, defaultKey: 72, color: '#d9b38c',
    description: `Clay vessel flute: an almost pure, round tone with soft breath and gentle attacks. ${WIND_HELP}`,
    params: windParams({ tone: 0.15, breath: 0.18, chiff: 0.2, vibrato: 0.2, attack: 0.03, release: 0.12 }),
    presets: { Clay: {}, Ghostly: { breath: 0.5, vibrato: 0.4, vibratoRate: 4, attack: 0.12, release: 0.6 }, Bright: { tone: 0.4, chiff: 0.35 } }
  },
  // ---------------------------------------------------------------- beatbox (mouth percussion and bass)
  bbkick: {
    label: 'Beatbox Kick', category: 'beatbox', melodic: false, defaultKey: 60, gm: 36, color: '#e07a5f',
    description: 'Mouth kick ("B"): a lip-burst thump with a puff of air, a little close-mic saturation. pitch = the thump, punch = how far it drops, air = lip burst noise.',
    params: [
      n('pitch', 'Pitch', 40, 120, 62, { unit: 'Hz', curve: 'log' }),
      n('punch', 'Punch', 0, 1, 0.5),
      n('decay', 'Decay', 0.05, 0.8, 0.2, { unit: 's', curve: 'log' }),
      n('air', 'Air', 0, 1, 0.5),
      n('drive', 'Drive', 0, 1, 0.3)
    ],
    presets: {
      'Classic B': {},
      Punchy: { punch: 0.8, decay: 0.16, air: 0.6, drive: 0.4 },
      'Deep 808 Mouth': { pitch: 48, decay: 0.55, punch: 0.35, air: 0.3, drive: 0.25 },
      'Throat Kick': { pitch: 70, decay: 0.12, drive: 0.8, air: 0.2 },
      'Lip Pop': { pitch: 85, decay: 0.08, air: 0.9, punch: 0.3, drive: 0.15 }
    }
  },
  bbsnare: {
    label: 'Beatbox Snare', category: 'beatbox', melodic: false, defaultKey: 60, gm: 38, color: '#f2b84b',
    description: 'Mouth snares: "Pf" (classic), "Psh" (spit snare), inward "K" (inhaled, throaty) or "Kch" (a rimshot/clap). tone = the hiss colour, snap = the plosive burst, body = the mouth\'s low ring.',
    params: [
      sel('style', 'Style', ['pf', 'psh', 'k', 'kch'], 'pf'),
      n('tone', 'Tone', 1500, 9000, 4500, { unit: 'Hz', curve: 'log' }),
      n('decay', 'Decay', 0.03, 0.5, 0.14, { unit: 's', curve: 'log' }),
      n('snap', 'Snap', 0, 1, 0.6),
      n('body', 'Body', 0, 1, 0.3)
    ],
    presets: {
      'Pf Snare': {},
      'Psh Spit Snare': { style: 'psh', tone: 3800, decay: 0.2 },
      'Inward K Snare': { style: 'k', tone: 3500, decay: 0.12, body: 0.15 },
      'Kch Rimshot': { style: 'kch', tone: 5000, decay: 0.09, snap: 0.85 }
    }
  },
  bbhat: {
    label: 'Beatbox Hat', category: 'beatbox', melodic: false, defaultKey: 60, gm: 42, color: '#a6d36a',
    description: 'Mouth hi-hats: "t" (closed), "ts" (open), inward (inhaled) or "tch". click = the tongue tap. Put closed and open in one choke group.',
    params: [
      sel('style', 'Style', ['t', 'ts', 'inward', 'tch'], 't'),
      n('color', 'Color', 4000, 12000, 7500, { unit: 'Hz', curve: 'log' }),
      n('decay', 'Decay', 0.01, 0.6, 0.05, { unit: 's', curve: 'log' }),
      n('click', 'Click', 0, 1, 0.6)
    ],
    presets: { 'T Hat': {}, 'Ts Open Hat': { style: 'ts', decay: 0.3 }, 'Inward Hat': { style: 'inward', decay: 0.08, click: 0.3 }, 'Tch Hat': { style: 'tch', decay: 0.09, color: 6000 } }
  },
  bbbass: {
    label: 'Beatbox Bass', category: 'beatbox', melodic: true, defaultKey: 36, color: '#c96a8c',
    description: 'Mouth bass: a lip/throat buzz shaped by a vowel ("oo", "oh", "ah" or a closed-mouth "mm" hum). growl adds a throat sub-octave and grit, wobble sweeps the vowel ("wub"). Mono with glide by default.',
    params: [
      sel('vowel', 'Vowel', ['oo', 'oh', 'ah', 'mm'], 'oo', { group: 'Tone' }),
      n('growl', 'Growl', 0, 1, 0.2, { group: 'Tone' }),
      n('wobble', 'Wobble', 0, 1, 0, { group: 'Wobble' }),
      n('wobbleRate', 'Rate', 0.5, 12, 4, { unit: 'Hz', curve: 'log', group: 'Wobble' }),
      n('attack', 'Attack', 0.003, 1, 0.01, { unit: 's', curve: 'log', group: 'Voice' }),
      n('release', 'Release', 0.02, 2, 0.08, { unit: 's', curve: 'log', group: 'Voice' }),
      ...legato(true, 0.05, 0.4),
      n('gain', 'Gain', 0, 2, 0.8, { group: 'Voice' })
    ],
    presets: {
      'Lip Bass': {},
      Hum: { vowel: 'mm', growl: 0 },
      'Throat Bass': { vowel: 'oh', growl: 0.7 },
      Wub: { vowel: 'ah', wobble: 0.7, wobbleRate: 4, growl: 0.3 }
    }
  },
  bbfx: {
    label: 'Beatbox FX', category: 'beatbox', melodic: false, defaultKey: 60, gm: 69, color: '#8e7cc3',
    description: 'Mouth effects: a tongue click roll, a vocal DJ scratch ("wicka"), a laser zap or a siren. decay = how long it lasts; rate = clicks per second (click roll), the scratch speed (rate/2 push-pull strokes a second) or the siren\'s wobble; the zap ignores it.',
    params: [
      sel('style', 'Style', ['clickroll', 'scratch', 'zap', 'siren'], 'clickroll'),
      n('pitch', 'Pitch', 80, 2000, 400, { unit: 'Hz', curve: 'log' }),
      n('rate', 'Rate', 4, 40, 22, { unit: 'Hz', curve: 'log' }),
      n('decay', 'Decay', 0.1, 2, 0.4, { unit: 's', curve: 'log' })
    ],
    presets: {
      'Click Roll': {},
      Scratch: { style: 'scratch', pitch: 260, rate: 8, decay: 0.35 },
      'Laser Zap': { style: 'zap', pitch: 500, decay: 0.25 },
      Siren: { style: 'siren', pitch: 450, rate: 6, decay: 1.2 }
    }
  },
  // ---------------------------------------------------------------- Indian
  sitar: {
    label: 'Sitar', category: 'indian', melodic: true, defaultKey: 60, color: '#d98b3a',
    description: 'Modelled sitar: a plucked string on a buzzing jawari bridge (the bright, evolving "zing") with sympathetic strings (taraf) tuned to the major scale of Sa (the sa param) — matching notes ring along. Mono with glide by default: overlapping notes are pulled along the fret (meend).',
    params: [
      n('jawari', 'Jawari', 0, 1, 0.6, { group: 'Tone' }),
      ...pluckParams({ brightness: 0.6, sustain: 3.5, sustainMin: 0.5, release: 0.15, mono: true, glide: 0.12 }).filter((x) => x.key !== 'gain'),
      n('sympathetic', 'Taraf', 0, 1, 0.5, { group: 'Sympathetic strings' }),
      sel('sa', 'Sa', SA_NOTES, 'C', { group: 'Sympathetic strings' }),
      n('gain', 'Gain', 0, 2, 0.8, { group: 'Voice' })
    ],
    presets: {
      Sitar: {},
      'Bright Jawari': { jawari: 0.85, brightness: 0.75 },
      Mellow: { jawari: 0.35, brightness: 0.4, sympathetic: 0.3 },
      'Pop Sitar': { mono: false, sympathetic: 0.2, sustain: 2.5 }
    }
  },
  tanpura: {
    label: 'Tanpura', category: 'indian', melodic: true, defaultKey: 48, color: '#a0785a',
    description: 'Drone lute: long, buzzing strings (jawari) that bloom and shimmer for seconds. Play Sa and Pa (e.g. C3 with G2 or C2) as long, repeated notes under a raga; the release lets each note ring on.',
    params: [
      n('jawari', 'Jawari', 0, 1, 0.8, { group: 'Tone' }),
      ...pluckParams({ brightness: 0.45, sustain: 8, sustainMin: 2, sustainMax: 12, release: 1.5 })
    ],
    presets: { Tanpura: {}, Bright: { jawari: 0.95, brightness: 0.65 }, Soft: { jawari: 0.6, brightness: 0.3 } }
  },
  tabla: {
    label: 'Tabla', category: 'indian', melodic: false, tunedToKey: true, defaultKey: 60, gm: 60, color: '#b5651d',
    description: 'Tabla strokes (bols): na (rim, ringing), tin / tun (open treble), te (closed slap), ge (open bass, bend = the palm glide), ke (closed bass), dha = na + ge, dhin = tin + ge. tune = the treble drum (dayan) at C4 (261.6 Hz = C; play the note of your Sa to tune it), bayanTune = the bass drum. One channel per bol.',
    params: [
      sel('stroke', 'Bol', ['na', 'tin', 'tun', 'te', 'ge', 'ke', 'dha', 'dhin'], 'na'),
      n('tune', 'Dayan', 180, 520, 261.6, { unit: 'Hz', curve: 'log' }),
      n('bayanTune', 'Bayan', 60, 160, 95, { unit: 'Hz', curve: 'log' }),
      n('bend', 'Bend', 0, 1, 0.3),
      n('decay', 'Decay', 0.3, 2, 1)
    ],
    presets: {
      Na: {}, Tin: { stroke: 'tin' }, Tun: { stroke: 'tun' }, Te: { stroke: 'te' },
      Ge: { stroke: 'ge' }, Ke: { stroke: 'ke' }, Dha: { stroke: 'dha' }, Dhin: { stroke: 'dhin' },
      'Ge Slide': { stroke: 'ge', bend: 0.85, decay: 1.4 }
    }
  },
  bansuri: {
    label: 'Bansuri', category: 'indian', melodic: true, defaultKey: 67, color: '#e0a458',
    description: `Indian bamboo flute: deep, breathy and warm with slow expressive vibrato. Mono with glide by default: overlapping notes slide (meend). ${WIND_HELP}`,
    params: windParams({ tone: 0.3, breath: 0.5, chiff: 0.3, vibrato: 0.35, vibratoRate: 4.8, attack: 0.06, release: 0.25, mono: true, glide: 0.12 }),
    presets: { Bansuri: {}, 'Slow Meend': { glide: 0.3 }, Breathy: { breath: 0.75, tone: 0.2 }, Bright: { tone: 0.5, breath: 0.35 } }
  },
  shehnai: {
    label: 'Shehnai', category: 'indian', melodic: true, defaultKey: 67, color: '#d8724a',
    description: 'North Indian double-reed oboe: bright, nasal and piercing with ornamental vibrato. Mono with glide by default for meend. tone = brightness, nasal = the reed\'s formants.',
    params: reedParams(),
    presets: { Shehnai: {}, Wedding: { tone: 0.8, nasal: 0.75, vibrato: 0.45 }, Mellow: { tone: 0.35, nasal: 0.4, breath: 0.25 } }
  },
  santoor: {
    label: 'Santoor', category: 'indian', melodic: true, defaultKey: 72, color: '#d4a03c',
    description: 'Hammered dulcimer of Kashmir: courses of metal strings struck with light mallets — a bright, bell-like attack and a long shimmering ring (the strings of a course beat slightly). hardness = mallet, shimmer = course detune; the release lets notes ring on.',
    params: [
      n('hardness', 'Mallet', 0, 1, 0.6, { group: 'Tone' }),
      n('shimmer', 'Shimmer', 0, 1, 0.4, { group: 'Tone' }),
      ...pluckParams({ brightness: 0.6, sustain: 4, sustainMin: 1, sustainMax: 10, release: 2.5 })
    ],
    presets: { Santoor: {}, 'Soft Mallets': { hardness: 0.25, brightness: 0.45 }, Bright: { hardness: 0.85, brightness: 0.8 }, Dry: { sustain: 1.5, release: 0.4, shimmer: 0.2 } }
  },
  harmonium: {
    label: 'Harmonium', category: 'indian', melodic: true, defaultKey: 60, color: '#b5835a',
    description: 'Indian hand-pumped harmonium: bass, male and female reed banks (an octave apart, beating gently against each other), a reed "speak" on the attack and a bellows pulse shared by all notes. Sustains while held; barely velocity-sensitive.',
    params: [
      n('bassReed', 'Bass', 0, 1, 0, { group: 'Reeds' }),
      n('maleReed', 'Male', 0, 1, 1, { group: 'Reeds' }),
      n('femaleReed', 'Female', 0, 1, 0.6, { group: 'Reeds' }),
      n('tone', 'Tone', 0, 1, 0.5, { group: 'Tone' }),
      n('bellows', 'Bellows', 0, 1, 0.3, { group: 'Tone' }),
      n('bellowsRate', 'Bellows rate', 0.1, 3, 0.6, { unit: 'Hz', curve: 'log', group: 'Tone' }),
      n('attack', 'Attack', 0.01, 1, 0.06, { unit: 's', curve: 'log', group: 'Voice' }),
      n('release', 'Release', 0.02, 2, 0.1, { unit: 's', curve: 'log', group: 'Voice' }),
      n('gain', 'Gain', 0, 2, 0.6, { group: 'Voice' })
    ],
    presets: {
      'Male + Female': {},
      Male: { femaleReed: 0 },
      'Three Reeds': { bassReed: 0.8 },
      Soft: { tone: 0.3, femaleReed: 0.3, bellows: 0.2 },
      Qawwali: { bassReed: 0.6, tone: 0.7, bellows: 0.45, bellowsRate: 1.2 }
    }
  },
  // ---------------------------------------------------------------- East Asian
  koto: {
    label: 'Koto', category: 'eastasian', melodic: true, defaultKey: 62, color: '#c49a6c',
    description: 'Japanese 13-string zither plucked with picks: a bright, twangy attack and a woody ring. Pentatonic tunings suit it (hirajōshi: D E F A Bb). mono=true slides into notes like a pressed string (oshide).',
    params: pluckParams({ brightness: 0.7, sustain: 2.2, sustainMin: 0.5, sustainMax: 6, position: 0.1, release: 0.25, mono: false, glide: 0.15 }),
    presets: { Koto: {}, 'Finger Pluck': { brightness: 0.4, position: 0.25 }, Oshide: { mono: true, glide: 0.2 } }
  },
  guzheng: {
    label: 'Guzheng', category: 'eastasian', melodic: true, defaultKey: 67, color: '#d9774e',
    description: 'Chinese 21-string zither: bright, ringing strings plucked with fingernail picks and a long shimmering sustain; pentatonic (C D E G A) runs, glissandi and bends (mono=true) are its signature.',
    params: pluckParams({ brightness: 0.7, sustain: 3.5, sustainMin: 1, sustainMax: 8, position: 0.12, release: 0.35, mono: false, glide: 0.12 }),
    presets: { Guzheng: {}, Bright: { brightness: 0.9, position: 0.08 }, Mellow: { brightness: 0.45, position: 0.22 }, Bend: { mono: true, glide: 0.18 } }
  },
  pipa: {
    label: 'Pipa', category: 'eastasian', melodic: true, defaultKey: 64, color: '#b3563c',
    description: 'Chinese pear-shaped lute plucked with nails: a hard, bright, percussive attack and a short nasal ring. Fast repeated notes (32nds) give its tremolo (lunzhi).',
    params: pluckParams({ brightness: 0.8, sustain: 1.4, sustainMin: 0.3, sustainMax: 4, position: 0.08, release: 0.12 }),
    presets: { Pipa: {}, Soft: { brightness: 0.5, position: 0.18 }, Dry: { sustain: 0.6, release: 0.06 } }
  },
  shamisen: {
    label: 'Shamisen', category: 'eastasian', melodic: true, defaultKey: 57, color: '#7a4b8c',
    description: 'Japanese three-string lute struck with a large plectrum (bachi): a snappy skin "thwack", a buzzing sawari and a short, dry ring. Tsugaru style hits harder.',
    params: [
      n('thwack', 'Thwack', 0, 1, 0.5, { group: 'Tone' }),
      n('sawari', 'Sawari', 0, 1, 0.5, { group: 'Tone' }),
      ...pluckParams({ brightness: 0.65, sustain: 1.2, sustainMin: 0.3, sustainMax: 4, release: 0.1 })
    ],
    presets: { Shamisen: {}, Tsugaru: { thwack: 0.85, brightness: 0.8, sawari: 0.6 }, Nagauta: { thwack: 0.3, brightness: 0.5, sawari: 0.4 } }
  },
  erhu: {
    label: 'Erhu', category: 'eastasian', melodic: true, defaultKey: 67, color: '#c0504d',
    description: 'Chinese two-string fiddle: a singing, nasal, voice-like bowed tone with a snakeskin resonator, deep vibrato and slides. Mono with glide by default; harder notes bow brighter.',
    params: [
      n('brightness', 'Brightness', 0, 1, 0.55, { group: 'Tone' }),
      n('body', 'Skin', 0, 1, 0.6, { group: 'Tone' }),
      n('bowNoise', 'Bow noise', 0, 1, 0.25, { group: 'Tone' }),
      ...vibratoParams(0.45, 5.5),
      n('attack', 'Attack', 0.01, 2, 0.08, { unit: 's', curve: 'log', group: 'Voice' }),
      n('release', 'Release', 0.02, 3, 0.2, { unit: 's', curve: 'log', group: 'Voice' }),
      ...legato(true, 0.12),
      n('gain', 'Gain', 0, 2, 0.7, { group: 'Voice' })
    ],
    presets: {
      Erhu: {},
      Lament: { vibrato: 0.7, vibratoRate: 4.8, attack: 0.18, glide: 0.25 },
      Bright: { brightness: 0.8, bowNoise: 0.35 },
      'Zhonghu (alto)': { brightness: 0.35, body: 0.8 }
    }
  },
  shakuhachi: {
    label: 'Shakuhachi', category: 'eastasian', melodic: true, defaultKey: 62, color: '#a3b86c',
    description: `Japanese end-blown bamboo flute: very breathy and raw; notes swell in from slightly below pitch, with strong breath accents (muraiki) when played hard. Mono with glide by default. ${WIND_HELP}`,
    params: windParams({ tone: 0.4, breath: 0.65, chiff: 0.55, vibrato: 0.25, vibratoRate: 4.5, attack: 0.1, release: 0.3, mono: true, glide: 0.1 }),
    presets: { Shakuhachi: {}, Muraiki: { breath: 0.9, chiff: 0.85, tone: 0.5 }, Zen: { breath: 0.5, tone: 0.25, attack: 0.25, vibrato: 0.15, release: 0.6 } }
  },
  dizi: {
    label: 'Dizi', category: 'eastasian', melodic: true, defaultKey: 74, color: '#e8c35a',
    description: `Chinese bamboo flute with a buzzing membrane (dimo): bright, nasal and singing, fast vibrato; mono with glide for slides. buzz = the membrane. ${WIND_HELP}`,
    params: windParams({ tone: 0.6, breath: 0.3, chiff: 0.5, buzz: 0.6, vibrato: 0.3, vibratoRate: 6, attack: 0.03, release: 0.12, mono: true, glide: 0.06 }),
    presets: { Dizi: {}, Bright: { buzz: 0.85, tone: 0.75 }, Xiao: { buzz: 0, tone: 0.3, breath: 0.5, vibrato: 0.2, attack: 0.06 } }
  },
  suona: {
    label: 'Suona', category: 'eastasian', melodic: true, defaultKey: 69, color: '#e3a33c',
    description: 'Chinese double-reed horn: loud, brassy and bright, made for celebrations and processions; mono with glide for its bends. tone = brightness, nasal = the reed\'s formants.',
    params: reedParams({ tone: 0.75, nasal: 0.55, breath: 0.1, vibrato: 0.3, vibratoRate: 6, glide: 0.06 }),
    presets: { Suona: {}, Festive: { tone: 0.9, vibrato: 0.4 }, Distant: { tone: 0.45, nasal: 0.35, breath: 0.25 } }
  },
  taiko: {
    label: 'Taiko', category: 'eastasian', melodic: false, defaultKey: 60, gm: 41, color: '#8c3b2e',
    description: 'Japanese drums: odaiko (huge and booming), chudaiko (the classic festival drum), shime-daiko (small and tight) or kara (a stick on the wooden rim). stick = the bachi click, body = the skin\'s overtones. Follows note pitch.',
    params: [
      n('pitch', 'Pitch', 35, 450, 95, { unit: 'Hz', curve: 'log' }),
      n('decay', 'Decay', 0.05, 3, 0.9, { unit: 's', curve: 'log' }),
      n('stick', 'Stick', 0, 1, 0.5),
      n('body', 'Body', 0, 1, 0.5)
    ],
    presets: {
      Chudaiko: {},
      Odaiko: { pitch: 52, decay: 2.2, stick: 0.35, body: 0.6 },
      Shime: { pitch: 330, decay: 0.18, stick: 0.75, body: 0.3 },
      Kara: { pitch: 420, decay: 0.06, stick: 1, body: 0.05 }
    }
  },
  gong: {
    label: 'Gong', category: 'eastasian', melodic: false, defaultKey: 60, gm: 52, color: '#c9a227',
    description: 'Gongs and bells: tam-tam (a shimmering wash that blooms after the hit), Chinese opera gongs (bend < 0: the pitch falls, > 0: rises) and a temple bell (type bell). mallet = hardness, shimmer = the bloom. Follows note pitch.',
    params: [
      sel('type', 'Type', ['gong', 'bell'], 'gong'),
      n('pitch', 'Pitch', 50, 700, 70, { unit: 'Hz', curve: 'log' }),
      n('decay', 'Decay', 0.5, 12, 7, { unit: 's', curve: 'log' }),
      n('bend', 'Bend', -1, 1, 0),
      n('mallet', 'Mallet', 0, 1, 0.5),
      n('shimmer', 'Shimmer', 0, 1, 0.8)
    ],
    presets: {
      'Tam-tam': {},
      'Opera Gong': { pitch: 180, decay: 2.5, bend: -0.6, shimmer: 0.2, mallet: 0.6 },
      'Opera Gong High': { pitch: 420, decay: 1.5, bend: 0.7, shimmer: 0.1, mallet: 0.7 },
      'Temple Bell': { type: 'bell', pitch: 130, decay: 9, shimmer: 0.1, mallet: 0.2 },
      'Small Gong': { pitch: 300, decay: 3, shimmer: 0.4 }
    }
  },
  // a user plugin (see plugins.js): instrument.plugin holds its id; its params come from the plugin's manifest
  plugin: {
    label: 'Plugin instrument', category: 'plugins', melodic: true, defaultKey: 60, color: '#7c8a99', dynamic: true,
    description: 'An instrument from one of the user\'s installed plugins (list_plugins): add_channel with instrument "plugin" and plugin "<id>"; its params and presets come from the plugin.',
    params: [],
    presets: { Default: {} }
  },
  sampler: {
    label: 'Sampler', category: 'sampler', melodic: true, defaultKey: 60, color: '#9aa5b1',
    description: 'Plays an uploaded audio sample. Pitched by note (rootKey = original pitch). start/end trim the sample (fractions of its length); loop repeats loopStart..loopEnd while the note is held (oneShot off); cutoff is a low-pass that opens with velocity.',
    params: [
      { key: 'sampleId', label: 'Sample', type: 'sample', default: null },
      n('rootKey', 'Root key', 0, 127, 60, { step: 1 }),
      bool('pitched', 'Pitched', true),
      bool('oneShot', 'One shot', true),
      bool('reverse', 'Reverse', false),
      n('start', 'Start', 0, 0.99, 0),
      n('end', 'End', 0.01, 1, 1),
      bool('loop', 'Loop', false),
      n('loopStart', 'Loop start', 0, 0.99, 0),
      n('loopEnd', 'Loop end', 0.01, 1, 1),
      n('cutoff', 'Cutoff', 100, 20000, 20000, { unit: 'Hz', curve: 'log' }),
      n('gain', 'Gain', 0, 2, 1),
      ...ampEnv(0.001, 0.5, 1, 0.05)
    ],
    presets: { Default: {} }
  }
};

export const INSTRUMENT_KINDS = Object.keys(INSTRUMENTS);

export function getInstrumentDef(kind) {
  const def = INSTRUMENTS[kind];
  if (!def) throw new Error(`Unknown instrument "${kind}". Available: ${INSTRUMENT_KINDS.join(', ')}`);
  return def;
}

export function paramDef(kind, key) {
  return INSTRUMENTS[kind]?.params.find((p) => p.key === key) || null;
}

export function instrumentDefaults(kind) {
  const def = getInstrumentDef(kind);
  const params = {};
  for (const p of def.params) params[p.key] = p.default;
  return params;
}

/** Clamp/validate a params object against a param definition list. Unknown keys are dropped. */
export function sanitizeParams(defs, params = {}, { strict = false } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    const p = defs.find((d) => d.key === key);
    if (!p) {
      if (strict) throw new Error(`Unknown parameter "${key}". Valid: ${defs.map((d) => d.key).join(', ')}`);
      continue;
    }
    out[key] = sanitizeValue(p, value, strict);
  }
  return out;
}

export function sanitizeValue(p, value, strict = false) {
  if (p.type === 'number') {
    const v = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(v)) {
      if (strict) throw new Error(`Parameter "${p.key}" must be a number`);
      return p.default;
    }
    if (strict && (v < p.min || v > p.max)) {
      throw new Error(`Parameter "${p.key}" must be between ${p.min} and ${p.max}${p.unit ? ` ${p.unit}` : ''} (got ${v})`);
    }
    let c = Math.min(p.max, Math.max(p.min, v));
    if (p.step && p.step >= 1) c = Math.round(c);
    return c;
  }
  if (p.type === 'select') {
    if (!p.options.includes(value)) {
      if (strict) throw new Error(`Parameter "${p.key}" must be one of: ${p.options.join(', ')}`);
      return p.default;
    }
    return value;
  }
  if (p.type === 'bool') return value === true || value === 'true' || value === 1;
  if (p.type === 'sample' || p.type === 'channel') return value == null || value === '' ? null : String(value).slice(0, 64);
  return value;
}

export function makeInstrument(kind, preset, overrides = {}, { strict = false, plugin = null } = {}) {
  const def = getInstrumentDef(kind);
  if (kind === 'plugin') {
    // the manifest isn't known here: values are cleaned loosely (the server validates them against the manifest)
    return { kind, plugin: validPluginId(plugin), preset: typeof preset === 'string' && preset ? preset.slice(0, 32) : 'Default', params: sanitizeStoredPluginParams(overrides) };
  }
  const presetName = preset && Object.hasOwn(def.presets, preset) ? preset : Object.keys(def.presets)[0];
  if (strict && preset && !Object.hasOwn(def.presets, preset)) {
    throw new Error(`Unknown preset "${preset}" for ${kind}. Available: ${Object.keys(def.presets).join(', ')}`);
  }
  const params = {
    ...instrumentDefaults(kind),
    ...def.presets[presetName],
    ...sanitizeParams(def.params, overrides, { strict })
  };
  return { kind, preset: presetName, params };
}

/** Human readable catalog (used by MCP list_instruments). */
export function describeInstruments() {
  return INSTRUMENT_KINDS.map((kind) => {
    const d = INSTRUMENTS[kind];
    return {
      kind,
      label: d.label,
      category: d.category,
      melodic: d.melodic,
      defaultKey: d.defaultKey,
      description: d.description || '',
      presets: Object.keys(d.presets),
      params: d.params.map((p) => ({
        key: p.key,
        type: p.type,
        ...(p.type === 'number' ? { min: p.min, max: p.max } : {}),
        ...(p.options ? { options: p.options } : {}),
        default: p.default,
        ...(p.unit ? { unit: p.unit } : {})
      }))
    };
  });
}
