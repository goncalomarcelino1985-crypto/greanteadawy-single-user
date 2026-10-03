// High-level note generators shared by templates, MCP tools and the UI.
import { STEP, PPQ } from './constants.js';
import { uid } from './ids.js';
import { parseStepString } from './notation.js';
import { chordNotes, voiceNear, parseNote, parseChord } from './music.js';

/**
 * Chord voicings (how the chord tones are spread), applied after voice-leading picks the inversion:
 *   close     all tones within an octave (default)
 *   open      the second-lowest tone raised an octave — wider, less muddy pads
 *   drop2     the second-highest tone dropped an octave — the classic jazz/neo-soul piano & guitar voicing
 *   drop3     the third-highest tone dropped an octave (4+ note chords)
 *   spread    root an octave down, upper tones opened up — big, cinematic
 *   shell     root, 3rd and 7th only — tight jazz/lo-fi comping that leaves room for bass and melody
 *   rootless  no root (the bass has it), 9th added — modern keys / neo-soul sound
 */
export const VOICINGS = ['close', 'open', 'drop2', 'drop3', 'spread', 'shell', 'rootless'];

export function applyVoicing(notes, voicing = 'close', rootPc = null) {
  const s = [...notes].sort((a, b) => a - b);
  const pcOf = (n) => ((n % 12) + 12) % 12;
  const root = rootPc ?? pcOf(s[0]);
  const rel = (n) => (pcOf(n) - root + 12) % 12;
  const sorted = (a) => [...new Set(a)].sort((x, y) => x - y).filter((n) => n >= 0 && n <= 127);
  switch (voicing) {
    case 'open':
      return s.length >= 3 ? sorted([s[0], ...s.slice(2), s[1] + 12]) : s;
    case 'drop2':
      return s.length >= 3 ? sorted([s[s.length - 2] - 12, ...s.filter((_, i) => i !== s.length - 2)]) : s;
    case 'drop3':
      return s.length >= 4 ? sorted([s[s.length - 3] - 12, ...s.filter((_, i) => i !== s.length - 3)]) : applyVoicing(s, 'drop2', root);
    case 'spread': {
      const r = s.find((n) => rel(n) === 0) ?? s[0];
      const upper = s.filter((n) => n !== r);
      return sorted([r - 12, ...applyVoicing(upper.length >= 3 ? upper : [r, ...upper], 'open', root).filter((n) => rel(n) !== 0 || upper.length < 2)]);
    }
    case 'shell': {
      const r = s.find((n) => rel(n) === 0) ?? s[0];
      const third = s.find((n) => [3, 4].includes(rel(n))) ?? s.find((n) => [2, 5].includes(rel(n)));
      const seventh = s.find((n) => [10, 11].includes(rel(n))) ?? s.find((n) => rel(n) === 9);
      const fifth = s.find((n) => [6, 7, 8].includes(rel(n)));
      return sorted([r, third ?? fifth, seventh ?? fifth].filter((n) => n !== undefined));
    }
    case 'rootless': {
      const rest = s.filter((n) => rel(n) !== 0);
      const hasNinth = s.some((n) => [1, 2, 3].includes(rel(n)) && n - s[0] > 12) || rest.some((n) => rel(n) === 2);
      const dim = s.some((n) => rel(n) === 6) && !s.some((n) => rel(n) === 7);
      if (!hasNinth && !dim) rest.push((s.find((n) => rel(n) === 0) ?? s[0]) + 14);
      return rest.length >= 2 ? sorted(rest) : s;
    }
    case 'close':
    default:
      return s;
  }
}

/** Voicings defined relative to the root (an inversion would scramble them). */
const ROOT_POSITION_VOICINGS = new Set(['shell', 'rootless', 'spread']);

/** Move a voicing by whole octaves so its average pitch sits near `center` (keeps every chord in one register). */
function centerOn(notes, center) {
  const avg = notes.reduce((a, b) => a + b, 0) / notes.length;
  const shift = Math.round((center - avg) / 12) * 12;
  const out = notes.map((n) => n + shift);
  return out.every((n) => n >= 0 && n <= 127) ? out : notes;
}

/** A rhythm step string that restarts every chord; must contain at least one step. */
function parseRhythm(rhythm) {
  const r = parseStepString(rhythm);
  if (!r.steps) throw new Error(`Rhythm "${rhythm}" has no steps — use e.g. "x---x---" (x = hit, - = rest)`);
  return r;
}

const isRest = (symbol) => !symbol || symbol === '-' || /^n\.?c\.?$/i.test(symbol);

/** Step string -> notes. Each hit lasts `length` ticks. */
export function notesFromSteps(str, { key = 60, length = STEP, offset = 0, velocityScale = 1 } = {}) {
  const { hits } = parseStepString(str);
  return hits.map((h) => ({ id: uid('n'), key, start: offset + h.step * STEP, length, velocity: Math.min(1, h.velocity * velocityScale) }));
}

/**
 * Notes for a chord progression.
 * chords: ["Am", "F", "C", "G"] (use "-" or "" for a rest)
 * style:
 *   block       hold each chord for its full length
 *   rhythm      hit the chord on each "x" of `rhythm` (a step string, restarted every chord)
 *   arp-up / arp-down / arp-updown   arpeggiate at `rate` ticks per note
 *   broken      bass note first, then the upper notes together on the next beat
 */
export function chordProgressionNotes(chords, {
  start = 0, chordLength = PPQ * 4, octave = 4, style = 'block', rhythm = 'x-------x-------', rate = STEP * 2,
  velocity = 0.75, voiceLead = true, inversion = 0, gate = 0.9, center = null, voicing = 'close'
} = {}) {
  if (!VOICINGS.includes(voicing)) throw new Error(`Unknown voicing "${voicing}". Use: ${VOICINGS.join(', ')}`);
  const out = [];
  let target = center;
  chords.forEach((symbol, ci) => {
    const t0 = start + ci * chordLength;
    if (isRest(symbol)) return;
    // voice-lead the chord itself; a slash bass (C/E) always goes below it
    const { bass, root } = parseChord(symbol);
    const plain = String(symbol).replace(/\/[^/]+$/, '');
    let upper;
    if (ROOT_POSITION_VOICINGS.has(voicing)) {
      // these re-arrange around the root, so build them from root position and only move whole octaves
      upper = applyVoicing(chordNotes(plain, octave, 0), voicing, root);
      if (target === null) target = upper.reduce((a, b) => a + b, 0) / upper.length;
      else if (voiceLead || ci === 0) upper = centerOn(upper, target);
    } else {
      upper = chordNotes(plain, octave, inversion);
      if (target === null) target = upper.reduce((a, b) => a + b, 0) / upper.length;
      // an explicit inversion of the first chord is kept (moved to the register), later chords are voice-led
      else if (ci === 0 && inversion > 0) upper = centerOn(upper, target);
      else if (voiceLead) upper = voiceNear(upper, target);
      if (voicing !== 'close') {
        upper = applyVoicing(upper, voicing, root);
        if (voiceLead) upper = centerOn(upper, target);
      }
    }
    let notes = upper;
    if (bass !== null) {
      let b = Math.floor(upper[0] / 12) * 12 + bass;
      while (b >= upper[0]) b -= 12;
      if (b >= 0) notes = [b, ...upper];
    }
    notes = [...new Set(notes)].sort((x, y) => x - y);
    const push = (key, s, len, v = velocity) => {
      if (s >= t0 + chordLength) return;
      out.push({ id: uid('n'), key, start: Math.round(s), length: Math.max(1, Math.round(Math.min(len, t0 + chordLength - s))), velocity: v });
    };
    switch (style) {
      case 'rhythm': {
        const { hits, steps } = parseRhythm(rhythm);
        const span = steps * STEP;
        for (let rep = 0; rep * span < chordLength; rep++) {
          hits.forEach((h, hi) => {
            const next = hits[hi + 1]?.step ?? steps;
            const len = (next - h.step) * STEP * gate;
            for (const k of notes) push(k, t0 + rep * span + h.step * STEP, len, velocity * (h.velocity / 0.8));
          });
        }
        break;
      }
      case 'arp-up':
      case 'arp-down':
      case 'arp-updown': {
        let seq = [...notes];
        if (style === 'arp-down') seq.reverse();
        if (style === 'arp-updown') seq = [...notes, ...notes.slice(1, -1).reverse()];
        let i = 0;
        for (let s = t0; s < t0 + chordLength; s += rate) push(seq[i++ % seq.length], s, rate * gate);
        break;
      }
      case 'broken': {
        push(notes[0], t0, chordLength * gate);
        for (const k of notes.slice(1)) push(k, t0 + PPQ, chordLength - PPQ);
        break;
      }
      case 'block':
      default:
        for (const k of notes) push(k, t0, chordLength * gate);
    }
  });
  return out;
}

/** Bassline following chord roots. rhythm is a step string restarted for every chord. */
export function bassFromChords(chords, { start = 0, chordLength = PPQ * 4, octave = 2, rhythm = 'x-------x-------', gate = 0.9, velocity = 0.85 } = {}) {
  const out = [];
  const { hits, steps } = parseRhythm(rhythm);
  const span = steps * STEP;
  // keep the line in one register: each root goes to the octave nearest the previous one, within a fifth below
  // to a seventh above the chosen octave's C (an 808 jumping a major 7th between chords sounds wrong)
  const lowest = (octave + 1) * 12 - 5;
  const highest = (octave + 1) * 12 + 11;
  let prev = null;
  chords.forEach((symbol, ci) => {
    if (isRest(symbol)) return;
    const { root: rootPc, bass } = parseChord(symbol);
    const pc = bass ?? rootPc;
    let root = (octave + 1) * 12 + pc;
    if (prev !== null) {
      root = prev + ((((pc - prev) % 12) + 18) % 12) - 6; // nearest pitch with this pitch class (tritone goes down)
      while (root < lowest) root += 12;
      while (root > highest) root -= 12;
    }
    prev = root;
    const t0 = start + ci * chordLength;
    for (let rep = 0; rep * span < chordLength; rep++) {
      hits.forEach((h, hi) => {
        const s = t0 + rep * span + h.step * STEP;
        if (s >= t0 + chordLength) return;
        const next = hits[hi + 1]?.step ?? steps;
        const len = Math.min((next - h.step) * STEP * gate, t0 + chordLength - s);
        out.push({ id: uid('n'), key: root, start: s, length: Math.max(1, Math.round(len)), velocity: velocity * (h.velocity / 0.8) });
      });
    }
  });
  return out;
}

const DEGREE_RE = /^(-?)([b#]?)(r|1|2|3|4|5|6|7|8|9|11|13)$/i;

/** Semitones above the chord root for a bass-line degree, using the chord's own 3rd/5th/7th when it has one. */
function degreeOffset(token, intervals) {
  const m = DEGREE_RE.exec(token);
  if (!m) return null;
  const [, down, acc, deg] = m;
  const has = (...xs) => xs.find((x) => intervals.includes(x));
  const base = {
    r: 0, 1: 0, 8: 12,
    2: 2, 9: 14,
    3: has(4, 3) ?? (has(2) !== undefined ? 2 : has(5) !== undefined ? 5 : 4),
    4: 5, 11: 17,
    5: has(7, 6, 8) ?? 7,
    6: 9, 13: 21,
    7: has(10, 11, 9) ?? 10
  }[deg.toLowerCase()];
  // an explicit accidental is taken literally against the major-scale degree (b3 = minor 3rd, b7 = minor 7th)
  const plain = { r: 0, 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9, 7: 11, 8: 12, 9: 14, 11: 17, 13: 21 }[deg.toLowerCase()];
  const value = acc ? plain + (acc === '#' ? 1 : -1) : base;
  if (down && deg === '8') return -12; // "-8" = the root an octave down (not the octave, lowered back to the root)
  return value - (down ? 12 : 0);
}

/**
 * Parse a bass line: space-separated tokens "degree:steps" with optional suffixes
 *   degrees  R (root, or the slash-chord bass) 3 5 7 (the chord's own 3rd/5th/7th) 2 4 6 9 11 13 8 (octave)
 *            b3 b5 b7 #4 … (literal), a leading "-" = an octave lower ("-5" = 5th below, "-8" = root an octave down)
 *   rests    "-" or "_";  ties "~" (extends the previous note)
 *   suffix   "!" accent, "?" ghost, "~" slide into the next note (overlaps it: mono 808s/synths glide)
 * e.g. "R:3 R:1 -:2 5:2 R:2~ 8:4 b7:2"
 */
export function parseBassLine(line) {
  const tokens = [];
  for (const raw of String(line).trim().split(/[\s,|]+/).filter(Boolean)) {
    // suffixes may follow the degree or the length: "R~:2" and "R:2~" both slide
    let accent = false; let ghost = false; let slide = false;
    const strip = (x) => {
      for (;;) {
        if (x.length > 1 && x.endsWith('!')) { accent = true; x = x.slice(0, -1); } else if (x.length > 1 && x.endsWith('?')) { ghost = true; x = x.slice(0, -1); } else if (x.length > 1 && x.endsWith('~')) { slide = true; x = x.slice(0, -1); } else return x;
      }
    };
    const [headRaw, lenRaw] = raw.split(':');
    const deg = strip(headRaw);
    const lenStr = lenRaw === undefined ? undefined : strip(lenRaw);
    const steps = lenStr === undefined ? 1 : Number(lenStr);
    // a 32nd note is the shortest useful bass note (and keeps a single call from generating millions of notes)
    if (!Number.isFinite(steps) || steps < 0.5) throw new Error(`Invalid length in bass token "${raw}": use at least 0.5 steps (a 32nd note)`);
    if (tokens.length >= 512) throw new Error('The bass line is too long (max 512 tokens): it repeats for every chord anyway');
    if (deg === '-' || deg === '_') tokens.push({ kind: 'rest', steps });
    else if (deg === '~') tokens.push({ kind: 'tie', steps });
    else if (DEGREE_RE.test(deg)) tokens.push({ kind: 'note', degree: deg, steps, accent, ghost, slide });
    else throw new Error(`Invalid bass token "${raw}". Use degrees R 3 5 7 8 b7 -5 …, "-" rests, "~" ties, e.g. "R:3 R:1 -:2 5:2 8:4"`);
  }
  if (!tokens.length) throw new Error('The bass line is empty');
  return tokens;
}

/**
 * Bassline from chords and a degree pattern (see parseBassLine) restarted for every chord. Roots stay in one
 * register like bassFromChords; other degrees are measured up from the chord root.
 */
export function bassLineFromChords(chords, line, { start = 0, chordLength = PPQ * 4, octave = 2, gate = 0.9, velocity = 0.85 } = {}) {
  const tokens = parseBassLine(line);
  const span = tokens.reduce((a, t) => a + t.steps, 0) * STEP;
  const lowest = (octave + 1) * 12 - 5;
  const highest = (octave + 1) * 12 + 11;
  let prev = null;
  const out = [];
  chords.forEach((symbol, ci) => {
    if (isRest(symbol)) return;
    const { root: rootPc, bass, intervals } = parseChord(symbol);
    const pc = bass ?? rootPc;
    let r = (octave + 1) * 12 + pc;
    if (prev !== null) {
      r = prev + ((((pc - prev) % 12) + 18) % 12) - 6;
      while (r < lowest) r += 12;
      while (r > highest) r -= 12;
    }
    prev = r;
    const chordRoot = r - ((pc - rootPc + 12) % 12); // the slash bass sits on top of the chord root
    const t0 = start + ci * chordLength;
    const end = t0 + chordLength;
    // a slide may run into the next chord's first note — but not past the end of the line (it would add a bar)
    const lastChord = chords.slice(ci + 1).every(isRest);
    let last = null;
    const finish = () => {
      if (!last) return;
      const len = last.slide ? last.nominal + STEP / 2 : Math.max(1, Math.round(last.nominal * gate));
      const cap = last.slide && !lastChord ? Infinity : end - last.note.start;
      last.note.length = Math.max(1, Math.round(Math.min(len, cap)));
      last = null;
    };
    for (let rep = 0; rep * span < chordLength; rep++) {
      let t = t0 + rep * span;
      for (const tok of tokens) {
        if (t >= end) break;
        if (tok.kind === 'tie') {
          if (last) last.nominal += tok.steps * STEP;
        } else {
          finish();
          if (tok.kind === 'note') {
            // root-type degrees follow the bass note (the slash bass of C/E); the others are counted from the chord root
            const rootLike = /^-?(r|1|8)$/i.test(tok.degree);
            const key = rootLike ? r + degreeOffset(tok.degree, intervals) : chordRoot + degreeOffset(tok.degree, intervals);
            const v = tok.accent ? 1 : tok.ghost ? velocity * 0.55 : velocity;
            const note = { id: uid('n'), key: Math.max(0, Math.min(127, key)), start: Math.round(t), length: 1, velocity: Math.min(1, v) };
            out.push(note);
            last = { note, nominal: tok.steps * STEP, slide: tok.slide };
          }
        }
        t += tok.steps * STEP;
      }
      finish();
    }
  });
  return out;
}

/**
 * Tokens of a compact melody string: note:lengthInSteps (default 1 step), "-" or "r" = a rest, optional suffixes (any
 * order) "!" = accent and "~" = slide. Lengths are checked strictly, so "C4:4x" is an error rather than a 4.
 */
function melodyTokens(str) {
  return String(str).trim().split(/[\s,]+/).filter(Boolean).map((tok) => {
    const flags = /[!~]*$/.exec(tok)[0];
    const [name, lenStr, extra] = tok.slice(0, tok.length - flags.length).split(':');
    if (!name || extra !== undefined || (lenStr !== undefined && !/^(\d+\.?\d*|\.\d+)$/.test(lenStr))) {
      throw new Error(`Invalid melody token "${tok}": use note:lengthInSteps with an optional ! (accent) or ~ (slide), e.g. "C5:2", "Eb5:4!", "D5:2~"`);
    }
    const len = (lenStr ? parseFloat(lenStr) : 1) * STEP;
    if (!Number.isFinite(len) || len <= 0) throw new Error(`Invalid melody token "${tok}"`);
    return { tok, name, len, rest: name === '-' || name.toLowerCase() === 'r', accent: flags.includes('!'), slide: flags.includes('~') };
  });
}

/** Total length (ticks) a melody string covers, rests included. */
export function melodyLength(str) {
  return Math.round(melodyTokens(str).reduce((t, x) => t + x.len, 0));
}

/**
 * Parse a compact melody string: "C5:2 D5:2 Eb5:4 -:2 G5:6"
 * Each token is note:lengthInSteps (default 1 step); "-" or "r" is a rest. Optional suffixes: "!" = accent, "~" = slide:
 * the note overlaps the next one by up to half a step (so swing can't open a gap, and light humanizing rarely does)
 * and a mono instrument with glide slides there — meend, slurs, bends. No overlap into a rest or the same pitch.
 */
export function melodyFromString(str, { start = 0, velocity = 0.8, gate = 0.95 } = {}) {
  const tokens = melodyTokens(str);
  const out = [];
  let t = start;
  tokens.forEach((x, i) => {
    if (!x.rest) {
      const next = tokens[i + 1];
      // never past the end of the next note (the span) and not into a repeat of the same key (that's a re-strike)
      const overlap = next && !next.rest && parseNote(next.name) !== parseNote(x.name) ? Math.min(STEP / 2, Math.round(next.len)) : 0;
      const length = x.slide
        ? Math.round(t + x.len) - Math.round(t) + overlap
        : Math.max(1, Math.round(x.len * gate));
      out.push({ id: uid('n'), key: parseNote(x.name), start: Math.round(t), length, velocity: x.accent ? 1 : velocity });
    }
    t += x.len;
  });
  return out;
}

/** Repeat a list of notes `times` times every `period` ticks. */
export function repeatNotes(notes, period, times) {
  const out = [];
  for (let i = 0; i < times; i++) for (const n of notes) out.push({ ...n, id: uid('n'), start: n.start + i * period });
  return out;
}

/** Quantize note starts (and optionally lengths) to a grid. */
export function quantizeNotes(notes, grid = STEP, { lengths = false, strength = 1 } = {}) {
  return notes.map((n) => {
    const q = Math.round(n.start / grid) * grid;
    const start = Math.round(n.start + (q - n.start) * strength);
    const length = lengths ? Math.max(grid, Math.round(n.length / grid) * grid) : n.length;
    return { ...n, start: Math.max(0, start), length };
  });
}

/** Randomize timing/velocity slightly for a human feel. */
export function humanizeNotes(notes, { timing = 4, velocity = 0.1, rand = Math.random } = {}) {
  return notes.map((n) => ({
    ...n,
    start: Math.max(0, Math.round(n.start + (rand() * 2 - 1) * timing)),
    velocity: Math.min(1, Math.max(0.05, n.velocity + (rand() * 2 - 1) * velocity))
  }));
}

/** Extend each note to the start of the next note (piano-roll "legato"). */
export function legatoNotes(notes) {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  return sorted.map((n, i) => {
    const next = sorted.slice(i + 1).find((m) => m.start > n.start);
    return next ? { ...n, length: next.start - n.start } : n;
  });
}

/** Hi-hat roll: `count` hits evenly spaced over `span` ticks starting at `start`, optional velocity ramp. */
export function rollNotes({ start, span, count, key = 60, from = 0.5, to = 0.9 }) {
  const out = [];
  const dt = span / count;
  for (let i = 0; i < count; i++) {
    out.push({ id: uid('n'), key, start: Math.round(start + i * dt), length: Math.max(1, Math.round(dt)), velocity: from + (to - from) * (count > 1 ? i / (count - 1) : 0) });
  }
  return out;
}
