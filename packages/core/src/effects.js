import { uid } from './ids.js';
import { sanitizeParams } from './instruments.js';
import { validPluginId, sanitizeStoredPluginParams } from './plugins.js';

const n = (key, label, min, max, def, extra = {}) => ({ key, label, type: 'number', min, max, default: def, ...extra });
const sel = (key, label, options, def, extra = {}) => ({ key, label, type: 'select', options, default: def, ...extra });
const bool = (key, label, def) => ({ key, label, type: 'bool', default: def });
/** A channel reference (channel id, or null = none) — e.g. the trigger of a note-driven sidechain. */
const channelRef = (key, label) => ({ key, label, type: 'channel', default: null });

export const SYNC_DIVISIONS = ['1/32', '1/16', '1/16d', '1/8t', '1/8', '1/8d', '1/4t', '1/4', '1/4d', '1/2', '1/1'];

/** Length of a tempo-synced division in beats (quarter notes). */
export function divisionBeats(div) {
  const m = /^1\/(\d+)([dt]?)$/.exec(div);
  if (!m) return 0.5;
  let beats = 4 / parseInt(m[1], 10);
  if (m[2] === 'd') beats *= 1.5;
  if (m[2] === 't') beats *= 2 / 3;
  return beats;
}

// automatable: param is backed by a Web Audio AudioParam and can be automated.
export const EFFECTS = {
  eq: {
    label: 'Parametric EQ', description: '3-band EQ (low shelf, mid peak, high shelf) with high-pass and low-pass filters (12 dB/oct; hpf 20 Hz / lpf 20 kHz = off).',
    params: [
      n('hpf', 'High-pass', 20, 1000, 20, { unit: 'Hz', curve: 'log', automatable: true }),
      n('low', 'Low', -24, 24, 0, { unit: 'dB', automatable: true }),
      n('lowFreq', 'Low freq', 20, 1000, 180, { unit: 'Hz', curve: 'log', automatable: true }),
      n('mid', 'Mid', -24, 24, 0, { unit: 'dB', automatable: true }),
      n('midFreq', 'Mid freq', 150, 8000, 1000, { unit: 'Hz', curve: 'log', automatable: true }),
      n('midQ', 'Mid Q', 0.1, 10, 1, { curve: 'log' }),
      n('high', 'High', -24, 24, 0, { unit: 'dB', automatable: true }),
      n('highFreq', 'High freq', 1000, 20000, 6000, { unit: 'Hz', curve: 'log', automatable: true }),
      n('lpf', 'Low-pass', 1000, 20000, 20000, { unit: 'Hz', curve: 'log', automatable: true })
    ]
  },
  filter: {
    label: 'Filter', description: 'Resonant filter. Automate cutoff for sweeps.',
    params: [
      sel('type', 'Type', ['lowpass', 'highpass', 'bandpass', 'notch'], 'lowpass'),
      n('cutoff', 'Cutoff', 20, 20000, 20000, { unit: 'Hz', curve: 'log', automatable: true }),
      n('resonance', 'Resonance', 0.1, 20, 0.8, { curve: 'log', automatable: true }),
      n('mix', 'Mix', 0, 1, 1, { automatable: true })
    ]
  },
  compressor: {
    label: 'Compressor', description: 'Dynamics compressor; mix < 1 = parallel (New York) compression. No automatic makeup: set makeup so the level matches the bypassed sound.',
    params: [
      n('threshold', 'Threshold', -60, 0, -18, { unit: 'dB', automatable: true }),
      n('ratio', 'Ratio', 1, 20, 4, { curve: 'log', automatable: true }),
      n('attack', 'Attack', 0.001, 0.5, 0.01, { unit: 's', curve: 'log' }),
      n('release', 'Release', 0.01, 1, 0.15, { unit: 's', curve: 'log' }),
      n('knee', 'Knee', 0, 40, 6, { unit: 'dB' }),
      n('makeup', 'Makeup', 0, 24, 0, { unit: 'dB', automatable: true }),
      n('mix', 'Mix', 0, 1, 1, { automatable: true })
    ]
  },
  delay: {
    label: 'Delay', description: 'Tempo-synced (ping-pong) delay; the repeats are high-passed so they never muddy the low end.',
    params: [
      sel('time', 'Time', SYNC_DIVISIONS, '1/8d'),
      n('feedback', 'Feedback', 0, 0.95, 0.35, { automatable: true }),
      n('tone', 'Tone', 300, 20000, 6000, { unit: 'Hz', curve: 'log', automatable: true }),
      bool('pingPong', 'Ping-pong', true),
      n('mix', 'Mix', 0, 1, 0.25, { automatable: true })
    ]
  },
  reverb: {
    label: 'Reverb', description: 'Convolution reverb with a generated room: early reflections (size), a decay whose highs die faster (damping), and a 120 Hz low cut.',
    params: [
      n('decay', 'Decay', 0.2, 10, 2.2, { unit: 's', curve: 'log' }),
      n('size', 'Size', 0, 1, 0.5),
      n('predelay', 'Pre-delay', 0, 0.2, 0.01, { unit: 's' }),
      n('damping', 'Damping', 1000, 20000, 7000, { unit: 'Hz', curve: 'log', automatable: true }),
      n('mix', 'Mix', 0, 1, 0.25, { automatable: true })
    ]
  },
  distortion: {
    label: 'Distortion', description: 'Waveshaper saturation / distortion.',
    params: [
      n('drive', 'Drive', 0, 1, 0.35),
      sel('mode', 'Mode', ['soft', 'hard', 'fold'], 'soft'),
      n('tone', 'Tone', 500, 20000, 9000, { unit: 'Hz', curve: 'log', automatable: true }),
      n('mix', 'Mix', 0, 1, 1, { automatable: true }),
      n('output', 'Output', 0, 2, 0.8, { automatable: true })
    ]
  },
  chorus: {
    label: 'Chorus', description: 'Stereo modulated-delay chorus.',
    params: [
      n('rate', 'Rate', 0.05, 8, 0.8, { unit: 'Hz', curve: 'log', automatable: true }),
      n('depth', 'Depth', 0, 1, 0.4),
      n('delay', 'Delay', 0.005, 0.04, 0.015, { unit: 's' }),
      n('mix', 'Mix', 0, 1, 0.5, { automatable: true })
    ]
  },
  phaser: {
    label: 'Phaser', description: '4-stage all-pass phaser.',
    params: [
      n('rate', 'Rate', 0.05, 8, 0.5, { unit: 'Hz', curve: 'log', automatable: true }),
      n('depth', 'Depth', 0, 1, 0.6),
      n('frequency', 'Center', 200, 4000, 900, { unit: 'Hz', curve: 'log' }),
      n('feedback', 'Feedback', 0, 0.9, 0.4),
      n('mix', 'Mix', 0, 1, 0.5, { automatable: true })
    ]
  },
  bitcrusher: {
    label: 'Lo-fi Crusher', description: 'Bit-depth reduction for crunchy lo-fi tones.',
    params: [
      n('bits', 'Bits', 1, 16, 8, { step: 1 }),
      n('mix', 'Mix', 0, 1, 0.6, { automatable: true })
    ]
  },
  stereo: {
    label: 'Stereo Shaper', description: 'Stereo width (0 = mono, 1 = normal, 2 = extra wide); monoBelow keeps everything under that frequency mono (0 = off) so wide bass stays club- and phone-safe.',
    params: [
      n('width', 'Width', 0, 2, 1, { automatable: true }),
      n('monoBelow', 'Mono below', 0, 500, 0, { unit: 'Hz' })
    ]
  },
  pump: {
    label: 'Sidechain Pump', description: 'Volume ducking. With source = a channel (e.g. the kick) it ducks on every note of that channel — a real sidechain that follows syncopated kicks, even when that channel is muted (a "ghost" trigger). Without a source it pumps on a tempo-synced grid (rate).',
    params: [
      channelRef('source', 'Trigger channel'),
      sel('rate', 'Rate', ['1/16', '1/8', '1/4', '1/2', '1/1'], '1/4'),
      n('depth', 'Depth', 0, 1, 0.7),
      n('shape', 'Release', 0.05, 0.95, 0.45, { description: 'Recovery time as a fraction of the rate (grid mode) or of one beat (source mode)' })
    ]
  },
  limiter: {
    label: 'Limiter', description: 'Master limiter: input gain drives it, ceiling caps the output (oversampled clip stage). Keep the master fader after it at 0 dB; check true peak with render_mix (streaming wants ≤ -1 dBTP).',
    params: [
      n('gain', 'Input gain', 0, 24, 0, { unit: 'dB', automatable: true }),
      n('ceiling', 'Ceiling', -12, 0, -1, { unit: 'dB' }),
      n('release', 'Release', 0.01, 1, 0.1, { unit: 's', curve: 'log' })
    ]
  }
};

// a user plugin effect (see plugins.js): effect.plugin holds its id, params come from the plugin's manifest
EFFECTS.plugin = {
  label: 'Plugin effect', dynamic: true,
  description: 'An effect from one of the user\'s installed plugins (list_plugins): add_effect with type "plugin" and plugin "<id>"; params come from the plugin.',
  params: []
};

export const EFFECT_TYPES = Object.keys(EFFECTS);

export function getEffectDef(type) {
  const def = EFFECTS[type];
  if (!def) throw new Error(`Unknown effect "${type}". Available: ${EFFECT_TYPES.join(', ')}`);
  return def;
}

export function effectDefaults(type) {
  const params = {};
  for (const p of getEffectDef(type).params) params[p.key] = p.default;
  return params;
}

export function createEffect(type, params = {}, extra = {}) {
  const def = getEffectDef(type);
  if (type === 'plugin') {
    return { id: extra.id || uid('fx'), type, plugin: validPluginId(extra.plugin), enabled: extra.enabled !== false, params: sanitizeStoredPluginParams(params) };
  }
  return {
    id: extra.id || uid('fx'),
    type,
    enabled: extra.enabled !== false,
    params: { ...effectDefaults(type), ...sanitizeParams(def.params, params) }
  };
}

export function describeEffects() {
  return EFFECT_TYPES.map((type) => ({
    type,
    label: EFFECTS[type].label,
    description: EFFECTS[type].description,
    params: EFFECTS[type].params.map((p) => ({
      key: p.key,
      type: p.type,
      ...(p.type === 'number' ? { min: p.min, max: p.max } : {}),
      ...(p.options ? { options: p.options } : {}),
      default: p.default,
      ...(p.unit ? { unit: p.unit } : {}),
      ...(p.automatable ? { automatable: true } : {}),
      ...(p.type === 'channel' ? { note: 'channel id or name' } : {}),
      ...(p.description ? { description: p.description } : {})
    }))
  }));
}
