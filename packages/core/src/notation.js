// LLM- and human-friendly text notations: step strings, positions, note lists.
import { STEP, PPQ, ticksPerBar, beatsPerBar } from './constants.js';
import { noteName } from './music.js';

/**
 * Parse a drum step string into hits.
 *   x = hit (velocity 0.8), X = accent (1.0), o = ghost (0.45), 1-9 = velocity 0.1-0.9
 *   - . _ 0 = rest. Spaces and | are ignored (use them to group beats/bars).
 * Example: "x---|x---|x---|x---" (four-on-the-floor), "--x---x---x---x-"
 */
export function parseStepString(str) {
  const hits = [];
  let step = 0;
  for (const ch of String(str)) {
    if (ch === ' ' || ch === '|' || ch === '\n' || ch === '\t') continue;
    let vel = null;
    if (ch === 'x') vel = 0.8;
    else if (ch === 'X') vel = 1;
    else if (ch === 'o' || ch === 'O') vel = 0.45;
    else if (ch >= '1' && ch <= '9') vel = (ch.charCodeAt(0) - 48) / 10;
    else if (ch === '-' || ch === '.' || ch === '_' || ch === '0') vel = null;
    else throw new Error(`Invalid step character "${ch}". Use x X o 1-9 for hits and - . _ for rests.`);
    if (vel !== null) hits.push({ step, velocity: vel });
    step++;
  }
  return { hits, steps: step };
}

/** Format notes of one channel as a step string (one char per 16th). */
/** barSteps: steps per bar (16 in 4/4, 12 in 3/4 and 6/8) — bars are separated by " | ", beats by spaces. */
export function toStepString(notes, steps, { barSteps = 16, group = barSteps % 4 === 0 ? 4 : barSteps % 3 === 0 ? 3 : barSteps } = {}) {
  const cells = new Array(steps).fill('-');
  for (const n of notes || []) {
    if (n.start % STEP !== 0) continue;
    const s = n.start / STEP;
    if (s >= steps) continue;
    cells[s] = n.velocity >= 0.95 ? 'X' : n.velocity < 0.6 ? 'o' : 'x';
  }
  let out = '';
  for (let i = 0; i < steps; i++) {
    if (i && i % barSteps === 0) out += ' | ';
    else if (i && group && i % group === 0) out += ' ';
    out += cells[i];
  }
  return out;
}

/** True if all notes sit on 16th-step boundaries with one pitch (drum-like data). */
export function isStepLike(notes) {
  if (!notes?.length) return true;
  const key = notes[0].key;
  return notes.every((n) => n.start % STEP === 0 && n.key === key && n.length <= STEP * 2);
}

/** "bar.beat.step" (1-based) for a tick position, as the toolbar's song position display shows it. */
export function formatPosition(ticks, project) {
  const bar = ticksPerBar(project);
  const b = Math.floor(ticks / bar);
  const rem = ticks - b * bar;
  const beat = Math.floor(rem / PPQ);
  const step = Math.floor((rem - beat * PPQ) / STEP);
  return `${b + 1}.${beat + 1}.${step + 1}`;
}

/** Convert a time value with unit into ticks. unit: steps (16ths) | beats | bars | ticks */
export function toTicks(value, unit = 'steps', project) {
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error(`Invalid time value "${value}"`);
  switch (unit) {
    case 'ticks': return Math.round(v);
    case 'beats': return Math.round(v * PPQ);
    case 'bars': return Math.round(v * ticksPerBar(project));
    case 'steps':
    default: return Math.round(v * STEP);
  }
}

export function fromTicks(ticks, unit = 'steps', project) {
  switch (unit) {
    case 'ticks': return ticks;
    case 'beats': return ticks / PPQ;
    case 'bars': return ticks / ticksPerBar(project);
    default: return ticks / STEP;
  }
}

const round3 = (x) => Math.round(x * 1000) / 1000;

/** Compact note list: "C4@0+4 v0.8" = note C4 at step 0, 4 steps long. */
export function formatNoteList(notes) {
  return (notes || [])
    .map((n) => `${noteName(n.key)}@${round3(n.start / STEP)}+${round3(n.length / STEP)}${n.velocity !== 0.8 ? ` v${round3(n.velocity)}` : ''}`)
    .join(', ');
}

export function barsLabel(ticks, project) {
  return round3(ticks / ticksPerBar(project));
}

export { beatsPerBar };
