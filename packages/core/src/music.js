// Music theory helpers: note names, scales and chords.
// Convention: scientific pitch notation, C4 = MIDI 60 (middle C).

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function noteName(midi) {
  const m = Math.round(midi);
  return SHARP_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/** Parse a pitch class like "C", "F#", "Bb", "Ebb" -> 0..11 (or null). */
export function parsePitchClass(str) {
  const m = /^([A-Ga-g])([#b♯♭x]*)$/.exec(String(str).trim());
  if (!m) return null;
  let pc = LETTER_PC[m[1].toUpperCase()];
  for (const ch of m[2]) {
    if (ch === '#' || ch === '♯') pc += 1;
    else if (ch === 'x') pc += 2;
    else pc -= 1;
  }
  return ((pc % 12) + 12) % 12;
}

/**
 * Parse a note: MIDI number (60), numeric string ("60") or name ("C4", "F#3", "Bb-1").
 * Returns integer MIDI 0..127 or throws.
 */
export function parseNote(input, defaultOctave = 4) {
  if (typeof input === 'number' && Number.isFinite(input)) return clampMidi(Math.round(input));
  const s = String(input).trim();
  if (/^-?\d+$/.test(s)) return clampMidi(parseInt(s, 10));
  const m = /^([A-Ga-g][#b♯♭x]*)(-?\d+)?$/.exec(s);
  if (!m) throw new Error(`Invalid note "${input}". Use names like C4, F#3, Bb2 or MIDI numbers (C4 = 60).`);
  const pc = parsePitchClass(m[1]);
  const octave = m[2] !== undefined ? parseInt(m[2], 10) : defaultOctave;
  // Use the letter's natural octave so that e.g. B#3 = C4 and Cb4 = B3
  const letterPc = LETTER_PC[m[1][0].toUpperCase()];
  const accidental = pc - letterPc;
  const wrap = accidental > 6 ? -12 : accidental < -6 ? 12 : 0;
  return clampMidi((octave + 1) * 12 + letterPc + accidental + wrap);
}

function clampMidi(n) {
  if (n < 0 || n > 127) throw new Error(`Note ${n} is outside MIDI range 0..127`);
  return n;
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  // Japanese pentatonics (koto, shakuhachi, shamisen)
  hirajoshi: [0, 2, 3, 7, 8],
  inSen: [0, 1, 5, 7, 10],
  iwato: [0, 1, 5, 6, 10],
  yo: [0, 2, 5, 7, 9],
  // Indian thaats without a Western mode twin (Bilawal = major, Kalyan = lydian, Khamaj = mixolydian, Kafi = dorian,
  // Asavari = minor, Bhairavi = phrygian). They are played melodically over a drone, not harmonised in triads.
  bhairav: [0, 1, 4, 5, 7, 8, 11],
  todi: [0, 1, 3, 6, 7, 8, 11],
  purvi: [0, 1, 4, 6, 7, 8, 11],
  marwa: [0, 1, 4, 6, 7, 9, 11],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
};

/** Pitch classes (0..11) in a scale. */
export function scalePitchClasses(root, scale = 'minor') {
  const rootPc = typeof root === 'number' ? ((root % 12) + 12) % 12 : parsePitchClass(root);
  const steps = SCALES[scale];
  if (rootPc === null || rootPc === undefined) throw new Error(`Invalid key root "${root}"`);
  if (!steps) throw new Error(`Unknown scale "${scale}". Known: ${Object.keys(SCALES).join(', ')}`);
  return steps.map((s) => (rootPc + s) % 12);
}

/** MIDI notes of a scale, starting at root in the given octave, spanning N octaves. */
export function scaleNotes(root, scale = 'minor', octave = 4, octaves = 1) {
  const rootPc = parsePitchClass(root);
  const steps = SCALES[scale];
  if (rootPc === null || !steps) throw new Error(`Invalid scale ${root} ${scale}`);
  const base = (octave + 1) * 12 + rootPc;
  const out = [];
  for (let o = 0; o < octaves; o++) for (const s of steps) out.push(base + o * 12 + s);
  out.push(base + octaves * 12);
  return out.filter((n) => n >= 0 && n <= 127);
}

// Chord qualities -> semitone intervals from root
export const CHORD_TYPES = {
  '': [0, 4, 7],
  maj: [0, 4, 7],
  M: [0, 4, 7],
  m: [0, 3, 7],
  min: [0, 3, 7],
  '-': [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  '+': [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  sus: [0, 5, 7],
  5: [0, 7],
  6: [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  M7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  min7: [0, 3, 7, 10],
  mMaj7: [0, 3, 7, 11],
  mMaj9: [0, 3, 7, 11, 14],
  aug7: [0, 4, 8, 10],
  '+7': [0, 4, 8, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  '7sus4': [0, 5, 7, 10],
  add9: [0, 4, 7, 14],
  madd9: [0, 3, 7, 14],
  9: [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
  11: [0, 4, 7, 10, 14, 17],
  m11: [0, 3, 7, 10, 14, 17],
  13: [0, 4, 7, 10, 14, 21],
  maj13: [0, 4, 7, 11, 14, 21],
  m13: [0, 3, 7, 10, 14, 21]
};

/** Named chord shapes offered by the piano-roll chord stamp tool. */
export const STAMP_CHORDS = [
  ['Major', ''], ['Minor', 'm'], ['Dim', 'dim'], ['Aug', 'aug'], ['Sus2', 'sus2'], ['Sus4', 'sus4'],
  ['Power', '5'], ['Maj7', 'maj7'], ['Min7', 'm7'], ['Dom7', '7'], ['m7b5', 'm7b5'], ['Dim7', 'dim7'],
  ['Add9', 'add9'], ['Maj9', 'maj9'], ['Min9', 'm9'], ['Dom9', '9'], ['Min11', 'm11'], ['6th', '6']
];

/**
 * Parse a chord symbol: "Am", "F#m7", "Bbmaj7", "G7", "Dsus4", "C/E".
 * Returns { root: pitchClass, intervals: number[], bass: pitchClass|null }
 */
export function parseChord(symbol) {
  const s = String(symbol).trim();
  // root letter may be lower case ("am" = Am); a following "b" is a flat ("bbm7" = Bbm7)
  const m = /^([A-Ga-g][#b♯♭]?)([^/]*)(?:\/([A-Ga-g][#b♯♭]?))?$/.exec(s);
  if (!m) throw new Error(`Invalid chord "${symbol}". Use symbols like Am, F#m7, Bbmaj7, G7, Dsus4, C/E — or roman numerals (i, VI, bVII, V7/V) when the project has a key.`);
  const root = parsePitchClass(m[1]);
  const quality = m[2].trim();
  const intervals = CHORD_TYPES[quality];
  if (!intervals) {
    throw new Error(`Unknown chord quality "${quality}" in "${symbol}". Known: ${Object.keys(CHORD_TYPES).filter(Boolean).join(', ')}`);
  }
  const bass = m[3] ? parsePitchClass(m[3]) : null;
  return { root, intervals: [...intervals], bass };
}

/**
 * MIDI notes for a chord symbol. The root is placed in `octave` (C4 = 60).
 * inversion: 0 = root position, 1 = first inversion, ...
 * Slash bass notes are added an octave below the root.
 */
export function chordNotes(symbol, octave = 4, inversion = 0) {
  const { root, intervals, bass } = parseChord(symbol);
  const base = (octave + 1) * 12 + root;
  let notes = intervals.map((i) => base + i);
  for (let i = 0; i < inversion % notes.length; i++) {
    const n = notes.shift();
    notes.push(n + 12);
  }
  if (bass !== null) {
    let b = (octave + 1) * 12 + bass - 12;
    while (b >= notes[0]) b -= 12;
    notes = [b, ...notes];
  }
  return notes.filter((n) => n >= 0 && n <= 127);
}

/** Voice a chord close to a target center pitch, trying all inversions (keeps progressions in one register). */
export function voiceNear(notes, center = 64) {
  if (!notes.length) return notes;
  const sorted = [...notes].sort((a, b) => a - b);
  let best = sorted;
  let bestScore = Infinity;
  let cand = sorted;
  for (let inv = 0; inv < sorted.length; inv++) {
    const avg = cand.reduce((a, b) => a + b, 0) / cand.length;
    const shifted = cand.map((n) => n + Math.round((center - avg) / 12) * 12);
    const sAvg = shifted.reduce((a, b) => a + b, 0) / shifted.length;
    const score = Math.abs(sAvg - center) + (shifted[shifted.length - 1] - shifted[0]) * 0.01;
    if (score < bestScore && shifted.every((n) => n >= 0 && n <= 127)) {
      best = shifted;
      bestScore = score;
    }
    cand = [...cand.slice(1), cand[0] + 12];
  }
  return best;
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };
const ROMAN_RE = /^([b#♭♯]?)(vii|vi|v|iv|iii|ii|i|VII|VI|V|IV|III|II|I)(°|o|ø|\+|dim|aug)?(maj7|maj9|m7|7|9|11|13|6|sus2|sus4|add9)?$/;
const SHARP_SPELLING = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_SPELLING = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// semitones from the relative major's tonic to each mode's tonic
const MODE_OFFSET = { major: 0, majorPentatonic: 0, chromatic: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, minor: 9, harmonicMinor: 9, melodicMinor: 9, minorPentatonic: 9, blues: 9, locrian: 11 };

/** Does this key use sharps (G, D, A, E, B, F# major and their modes) rather than flats? */
function keyUsesSharps(key, scale) {
  const k = String(key).trim();
  if (/^[A-Ga-g]#/.test(k)) return true;
  if (/^[A-Ga-g]b/.test(k)) return false;
  const major = (parsePitchClass(k) - (MODE_OFFSET[scale] ?? MODE_OFFSET[sevenNoteScale(scale)] ?? 0) + 12) % 12;
  return [7, 2, 9, 4, 11, 6].includes(major);
}

/** "V7", "bVII", "ii°" — or a secondary chord like "V7/V" or "vii°/ii". */
export function isRomanNumeral(s) {
  const parts = String(s).trim().split('/');
  return parts.length <= 2 && parts.every((x) => ROMAN_RE.test(x));
}

const PARENT_SCALES = ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonicMinor', 'melodicMinor'];

/**
 * The 7-note scale roman numerals, diatonic chords and spelling are read in: 5/6-note scales borrow from the first
 * common 7-note scale that contains them.
 */
function sevenNoteScale(scale) {
  const steps = SCALES[scale];
  if (!steps) return 'major';
  if (steps.length === 7) return scale;
  // the first common 7-note scale that holds every note (in-sen → phrygian, iwato → locrian), else major/minor
  return PARENT_SCALES.find((p) => steps.every((x) => SCALES[p].includes(x))) || (steps.includes(3) ? 'minor' : 'major');
}

const LETTERS = 'CDEFGAB';

/**
 * A speller for a key: pitch class -> name. Notes of the (parent) 7-note scale get letter-correct names (F major → Bb,
 * A harmonic minor → G#, F# major → E#); anything else follows the key's sharp/flat preference.
 */
export function scaleSpelling(key = 'C', scale = 'major') {
  const table = keyUsesSharps(key, scale) ? SHARP_SPELLING : FLAT_SPELLING;
  const byPc = new Map();
  const m = /^([A-Ga-g])/.exec(String(key).trim());
  if (m && SCALES[scale] && parsePitchClass(key) !== null) {
    const first = LETTERS.indexOf(m[1].toUpperCase());
    scalePitchClasses(key, sevenNoteScale(scale)).forEach((pc, d) => {
      const letter = LETTERS[(first + d) % 7];
      const diff = ((pc - LETTER_PC[letter] + 18) % 12) - 6;
      // double sharps/flats read badly in a DAW: those degrees fall back to the plain enharmonic
      if (Math.abs(diff) <= 1) byPc.set(pc, letter + (diff === 1 ? '#' : diff === -1 ? 'b' : ''));
    });
  }
  return (pc) => {
    const p = ((Math.round(pc) % 12) + 12) % 12;
    return byPc.get(p) ?? table[p];
  };
}

/** Note name with octave from a scaleSpelling speller (keeps B#3 = MIDI 60 and Cb4 = MIDI 59 right). */
export function spelledNoteName(midi, spell) {
  const n = Math.round(midi);
  const name = spell(n);
  return name + (Math.floor(n / 12) - 1 + (name === 'B#' ? -1 : name === 'Cb' ? 1 : 0));
}

/**
 * Convert a roman numeral (e.g. "i", "VI", "bVII", "ii°", "V7", "IVmaj7") to a chord symbol in a key.
 * Upper case = major, lower case = minor, ° = diminished, + = augmented. The root comes from the
 * scale degree of `scale` (accidentals b/# shift it).
 */
export function romanToChord(numeral, key = 'C', scale = 'major') {
  const text = String(numeral).trim();
  const slash = text.split('/');
  if (slash.length === 2 && ROMAN_RE.test(slash[1])) {
    // secondary chord: "V7/V" = the V7 of the key whose tonic is this key's V
    const target = ROMAN_RE.exec(slash[1]);
    const tonicName = romanToChord(slash[1], key, scale).match(/^[A-G][#b]?/)[0];
    const targetMinor = target[2] === target[2].toLowerCase();
    return romanToChord(slash[0], tonicName, targetMinor ? 'harmonicMinor' : 'major');
  }
  const m = ROMAN_RE.exec(text);
  if (!m) throw new Error(`Invalid roman numeral "${numeral}"`);
  const [, acc, rn, qual = '', ext = ''] = m;
  const degree = ROMAN[rn.toLowerCase()];
  // Without an accidental the degree comes from the key's own scale (so "VI" in A minor = F);
  // with one it is relative to the major scale, as in common notation ("bVII" in A minor = G).
  const pcs = scalePitchClasses(key, acc ? 'major' : sevenNoteScale(scale));
  let pc = pcs[degree - 1];
  if (acc === 'b' || acc === '♭') pc = (pc + 11) % 12;
  if (acc === '#' || acc === '♯') pc = (pc + 1) % 12;
  const diminished = qual === '°' || qual === 'o' || qual === 'dim' || qual === 'ø';
  // vii° in a minor key is built on the raised leading tone (B° in C minor), as in classical harmony
  let raised = false;
  if (degree === 7 && diminished && !acc && (pc - pcs[0] + 12) % 12 === 10) {
    pc = (pc + 1) % 12;
    raised = true;
  }
  // spell the root the way the key is written (G# in A minor's vii°, Bb in C major's bVII); a scale with no Western
  // mode twin (the thaats) spells its own degrees by letter, like its scale does (D bhairav's II = Eb, not D#)
  if (!acc && !raised && MODE_OFFSET[sevenNoteScale(scale)] === undefined) {
    return `${scaleSpelling(key, scale)(pc)}${chordQuality(rn, qual, ext)}`;
  }
  const sharp = acc === '#' || acc === '♯' || raised || (!acc && keyUsesSharps(key, scale));
  return `${(sharp ? SHARP_SPELLING : FLAT_SPELLING)[pc]}${chordQuality(rn, qual, ext)}`;
}

/** Chord-symbol quality of a roman numeral: case = major/minor, then °/ø/+ and the extension. */
function chordQuality(rn, qual, ext) {
  const upper = rn === rn.toUpperCase();
  if (qual === '°' || qual === 'o' || qual === 'dim') return ext === '7' ? 'dim7' : 'dim';
  if (qual === 'ø') return 'm7b5';
  if (qual === '+' || qual === 'aug') return ext === '7' ? 'aug7' : 'aug';
  if (upper) return ext;
  if (ext.startsWith('sus')) return ext;
  if (ext === 'add9') return 'madd9';
  return { 7: 'm7', m7: 'm7', 9: 'm9', 11: 'm11', 13: 'm13', 6: 'm6', maj7: 'mMaj7', maj9: 'mMaj9' }[ext] || 'm';
}

/**
 * Diatonic triads/sevenths of a scale, e.g. C major -> C Dm Em F G Am Bdim. 5/6-note scales (pentatonics, blues,
 * hirajoshi…) use the 7-note scale that contains them — the same one roman numerals are read in. The thaats refuse:
 * some of their degrees have no major/minor/diminished/augmented triad.
 */
export function diatonicChords(key = 'C', scale = 'major', { sevenths = false } = {}) {
  const pcs = scalePitchClasses(key, sevenNoteScale(scale));
  if (pcs.length !== 7) throw new Error('Diatonic chords need a 7-note scale');
  const odd = pcs.some((root, d) => {
    const third = (pcs[(d + 2) % 7] - root + 12) % 12;
    const fifth = (pcs[(d + 4) % 7] - root + 12) % 12;
    return !((third === 4 && (fifth === 7 || fifth === 8)) || (third === 3 && (fifth === 7 || fifth === 6)));
  });
  if (odd) throw new Error(`The ${scale} scale has degrees without a major, minor, diminished or augmented triad: it is played melodically (over a drone such as a tanpura), not harmonised in triads. Use action "scale" for its notes.`);
  const spell = scaleSpelling(key, scale);
  const numerals = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii'];
  return pcs.map((root, d) => {
    const third = (pcs[(d + 2) % 7] - root + 12) % 12;
    const fifth = (pcs[(d + 4) % 7] - root + 12) % 12;
    const seventh = (pcs[(d + 6) % 7] - root + 12) % 12;
    let q = third === 4 && fifth === 7 ? '' : third === 3 && fifth === 7 ? 'm' : third === 3 && fifth === 6 ? 'dim' : third === 4 && fifth === 8 ? 'aug' : '';
    if (sevenths) {
      if (q === '') q = seventh === 11 ? 'maj7' : '7';
      else if (q === 'm') q = seventh === 10 ? 'm7' : 'mMaj7';
      else if (q === 'dim') q = seventh === 10 ? 'm7b5' : 'dim7';
    }
    const upper = third === 4;
    const numeral = (upper ? numerals[d].toUpperCase() : numerals[d]) + (q.startsWith('dim') || q === 'm7b5' ? '°' : q === 'aug' ? '+' : '');
    const chord = `${spell(root)}${q}`;
    return { degree: d + 1, numeral, chord, notes: chordNotes(chord, 4).map((n) => spelledNoteName(n, spell)) };
  });
}
