// Timing: everything in a project is measured in "ticks".
// PPQ = ticks per quarter note (beat). One 16th-note step = 24 ticks.
export const PPQ = 96;
export const STEPS_PER_BEAT = 4;
export const STEP = PPQ / STEPS_PER_BEAT; // 24 ticks

export const DEFAULT_BPM = 130;
export const MIN_BPM = 20;
export const MAX_BPM = 400;

export const DEFAULT_TRACK_COUNT = 16;
export const DEFAULT_INSERT_COUNT = 16;
export const MAX_INSERTS = 64;
export const MAX_TRACKS = 200;
export const MAX_EFFECTS_PER_INSERT = 10;

export const MAX_VOLUME = 1.25;

export const COLORS = [
  '#e8665a', '#f2a03d', '#f5d547', '#8bd65b', '#46c79a', '#3fb5d6', '#5a8ef0',
  '#8f6cf0', '#c86be0', '#e664a7', '#9aa5b1', '#d98c5f'
];

export function beatsPerBar(project) {
  const [num, den] = project?.timeSig || [4, 4];
  return num * (4 / den);
}

export function ticksPerBar(project) {
  return Math.round(beatsPerBar(project) * PPQ);
}

/** 16th steps per felt beat, for grouping step strings: compound meters (6/8, 9/8, 12/8) pulse in dotted quarters. */
export function stepsPerBeat(project) {
  const [num, den] = project?.timeSig || [4, 4];
  if (den === 8 && num % 3 === 0 && num > 3) return 6;
  return Math.max(1, Math.round(16 / den));
}

/** Longest pattern: 64 bars in the project's time signature. */
export const MAX_PATTERN_BARS = 64;
export function maxPatternLength(project) {
  return ticksPerBar(project) * MAX_PATTERN_BARS;
}

export function ticksToSeconds(ticks, bpm) {
  return (ticks / PPQ) * (60 / bpm);
}

export function secondsToTicks(seconds, bpm) {
  return (seconds * bpm / 60) * PPQ;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function num(v, fallback, lo = -Infinity, hi = Infinity) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, lo, hi);
}
