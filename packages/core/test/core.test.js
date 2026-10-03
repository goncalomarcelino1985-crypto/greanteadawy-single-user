import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNote, noteName, chordNotes, parseChord, scaleNotes,
  createDefaultProject, createProjectFromTemplate, TEMPLATES, applyOps, normalizeProject,
  parseStepString, toStepString, notesFromSteps, chordProgressionNotes, melodyFromString,
  songNotesInRange, patternLength, swingTicks, automationValueAt, STEP, PPQ,
  projectToMidi, parseMidi, summarizeProject, createsCycle, makeInstrument, describeInstruments, describeEffects,
  romanToChord, isRomanNumeral, prepareOps
} from '../src/index.js';

test('note parsing', () => {
  assert.equal(parseNote('C4'), 60);
  assert.equal(parseNote('A4'), 69);
  assert.equal(parseNote('C#4'), 61);
  assert.equal(parseNote('Db4'), 61);
  assert.equal(parseNote('Bb2'), 46);
  assert.equal(parseNote('B#3'), 60);
  assert.equal(parseNote('Cb4'), 59);
  assert.equal(parseNote('C-1'), 0);
  assert.equal(parseNote(64), 64);
  assert.equal(noteName(61), 'C#4');
  assert.throws(() => parseNote('H2'));
});

test('chords and scales', () => {
  assert.deepEqual(chordNotes('C', 4), [60, 64, 67]);
  assert.deepEqual(chordNotes('Am', 4), [69, 72, 76]);
  assert.deepEqual(chordNotes('Cmaj7', 4), [60, 64, 67, 71]);
  assert.deepEqual(chordNotes('C', 4, 1), [64, 67, 72]);
  assert.equal(chordNotes('C/E', 4)[0], 52);
  assert.deepEqual(parseChord('F#m7').intervals, [0, 3, 7, 10]);
  assert.deepEqual(scaleNotes('A', 'minor', 3, 1), [57, 59, 60, 62, 64, 65, 67, 69]);
  assert.throws(() => parseChord('Cxyz'));
});

test('step strings', () => {
  const { hits, steps } = parseStepString('x--- X--- o--- 5---');
  assert.equal(steps, 16);
  assert.deepEqual(hits.map((h) => h.step), [0, 4, 8, 12]);
  assert.equal(hits[1].velocity, 1);
  const notes = notesFromSteps('x-x-');
  assert.equal(toStepString(notes, 4, { group: 0 }), 'x-x-');
});

test('default project and ops', () => {
  let p = createDefaultProject({ name: 'T' });
  assert.equal(p.channels.length, 4);
  const kick = p.channels[0];
  const pat = p.patterns[0];
  p = applyOps(p, [
    { type: 'notes/set', patternId: pat.id, channelId: kick.id, notes: notesFromSteps('x---x---x---x---') },
    { type: 'project/update', patch: { bpm: 999 } },
    { type: 'channel/update', id: kick.id, patch: { volume: 2, instrument: { params: { decay: 0.9, bogus: 1 } } } }
  ]);
  assert.equal(p.patterns[0].notes[kick.id].length, 4);
  assert.equal(p.bpm, 400);
  assert.equal(p.channels[0].volume, 1.25);
  assert.equal(p.channels[0].instrument.params.decay, 0.9);
  assert.equal(p.channels[0].instrument.params.bogus, undefined);
  // structural sharing: untouched channels keep identity
  const p2 = applyOps(p, [{ type: 'channel/update', id: kick.id, patch: { pan: 0.5 } }]);
  assert.equal(p2.channels[1], p.channels[1]);
  assert.notEqual(p2.channels[0], p.channels[0]);
  // invalid ops throw
  assert.throws(() => applyOps(p, [{ type: 'nope' }]));
  assert.throws(() => applyOps(p, [{ type: 'channel/update', id: 'missing', patch: {} }]));
  // change instrument kind
  const p3 = applyOps(p, [{ type: 'channel/update', id: kick.id, patch: { instrument: { kind: 'bass808' } } }]);
  assert.equal(p3.channels[0].instrument.kind, 'bass808');
  assert.equal(p3.channels[0].rootKey, 36);
  // remove channel strips its notes
  const p4 = applyOps(p, [{ type: 'channel/remove', id: kick.id }]);
  assert.equal(p4.patterns[0].notes[kick.id], undefined);
});

test('mixer routing cycle detection', () => {
  let p = createDefaultProject();
  p = applyOps(p, [{ type: 'mixer/update', index: 1, patch: { output: 2 } }]);
  assert.equal(p.mixer[1].output, 2);
  assert.throws(() => applyOps(p, [{ type: 'mixer/update', index: 2, patch: { output: 1 } }]));
  assert.ok(createsCycle(p.mixer, 2, 1));
  assert.throws(() => applyOps(p, [{ type: 'mixer/update', index: 2, patch: { sends: [{ to: 1, amount: 0.5 }] } }]));
});

test('effects ops', () => {
  let p = createDefaultProject();
  p = applyOps(p, [{ type: 'effect/add', index: 1, effect: { id: 'fx_test', type: 'reverb', params: { mix: 0.5, decay: 99 } } }]);
  assert.equal(p.mixer[1].effects[0].params.decay, 10);
  p = applyOps(p, [{ type: 'effect/update', index: 1, effectId: 'fx_test', patch: { enabled: false, params: { mix: 0.1 } } }]);
  assert.equal(p.mixer[1].effects[0].enabled, false);
  assert.equal(p.mixer[1].effects[0].params.mix, 0.1);
  p = applyOps(p, [{ type: 'automation/add', automation: { id: 'auto1', target: { type: 'effect', index: 1, effectId: 'fx_test', param: 'mix' }, points: [{ t: 0, v: 0 }, { t: 384, v: 1 }] } }]);
  assert.equal(p.automations.length, 1);
  p = applyOps(p, [{ type: 'effect/remove', index: 1, effectId: 'fx_test' }]);
  assert.equal(p.automations.length, 0);
});

test('song timeline with looping clips', () => {
  let p = createDefaultProject();
  const kick = p.channels[0];
  const pat = p.patterns[0];
  p = applyOps(p, [
    { type: 'notes/set', patternId: pat.id, channelId: kick.id, notes: notesFromSteps('x---x---x---x---') },
    { type: 'clip/add', clips: [{ kind: 'pattern', refId: pat.id, track: 0, start: 0, length: PPQ * 4 * 2 }] }
  ]);
  assert.equal(patternLength(p, p.patterns[0]), PPQ * 4);
  const evts = songNotesInRange(p, 0, PPQ * 8);
  assert.equal(evts.length, 8);
  assert.deepEqual(evts.map((e) => e.start), [0, 96, 192, 288, 384, 480, 576, 672]);
  // window in the middle
  assert.equal(songNotesInRange(p, 100, 400).length, 3);
  // offset clip
  p = applyOps(p, [{ type: 'clip/update', id: p.playlist.clips[0].id, patch: { offset: 96, start: 384 } }]);
  assert.equal(songNotesInRange(p, 0, 2000)[0].start, 384 + 0); // note at 96 now at clip start
  // muted track
  p = applyOps(p, [{ type: 'track/update', index: 0, patch: { mute: true } }]);
  assert.equal(songNotesInRange(p, 0, 2000).length, 0);
});

test('swing and automation values', () => {
  assert.equal(swingTicks(0, 1), 0);
  assert.equal(swingTicks(STEP, 1), STEP / 2);
  const a = { length: 100, points: [{ t: 0, v: 0 }, { t: 100, v: 1 }] };
  assert.equal(automationValueAt(a, 50), 0.5);
});

test('builders', () => {
  const chords = chordProgressionNotes(['C', 'Am'], { chordLength: PPQ * 4, octave: 4 });
  assert.equal(chords.length, 6);
  const arp = chordProgressionNotes(['C'], { style: 'arp-up', rate: STEP * 2, chordLength: PPQ * 4 });
  assert.equal(arp.length, 8);
  const mel = melodyFromString('C5:2 -:2 E5:4!');
  assert.equal(mel.length, 2);
  assert.equal(mel[1].start, STEP * 4);
  assert.equal(mel[1].velocity, 1);
});

test('all templates build and normalize', () => {
  for (const name of Object.keys(TEMPLATES)) {
    const p = createProjectFromTemplate(name);
    assert.ok(p.channels.length >= 0, name);
    const again = normalizeProject(JSON.parse(JSON.stringify(p)));
    assert.equal(again.channels.length, p.channels.length);
    if (!['default', 'empty'].includes(name)) {
      assert.ok(p.playlist.clips.length > 0, `${name} has arrangement`);
      assert.ok(songNotesInRange(p, 0, 100000).length > 10, `${name} has notes`);
    }
  }
});

test('midi roundtrip', () => {
  const p = createProjectFromTemplate('trap');
  const bytes = projectToMidi(p);
  const parsed = parseMidi(bytes);
  assert.equal(parsed.bpm, 140);
  assert.ok(parsed.tracks.length >= 5);
  const drums = parsed.tracks.filter((t) => t.isDrum);
  assert.ok(drums.length >= 3);
});

test('summary and catalogs', () => {
  const p = createProjectFromTemplate('house');
  const s = summarizeProject(p);
  assert.match(s, /Deep House/);
  assert.match(s, /x--- x---/);
  assert.ok(describeInstruments().length > 10);
  assert.ok(describeEffects().length > 8);
  assert.throws(() => makeInstrument('synth', 'Nope', {}, { strict: true }));
});

test('normalizeProject repairs bad effects, routing cycles and dangling clips', () => {
  const p = createDefaultProject();
  const raw = JSON.parse(JSON.stringify(p));
  raw.mixer[1].effects = [{ id: 'x', type: 'vocoder' }, { id: 'y', type: 'reverb', params: { mix: 5 } }];
  raw.mixer[2].output = 3;
  raw.mixer[3].output = 2;
  raw.mixer[4].sends = [{ to: 99, amount: 1 }];
  raw.channels[0].mixerTrack = 500;
  raw.playlist.clips = [{ id: 'c1', kind: 'pattern', refId: 'missing', track: 0, start: 0, length: 96 }];
  const n = normalizeProject(raw);
  assert.deepEqual(n.mixer[1].effects.map((e) => e.type), ['reverb']);
  assert.equal(n.mixer[1].effects[0].params.mix, 1);
  assert.ok(!(n.mixer[2].output === 3 && n.mixer[3].output === 2));
  assert.equal(n.mixer[4].sends.length, 0);
  assert.equal(n.channels[0].mixerTrack, 0);
  assert.equal(n.playlist.clips.length, 0);
});

test('add ops are idempotent and auto-assign mixer inserts', () => {
  let p = createDefaultProject();
  const op = { type: 'channel/add', channel: { id: 'ch_same', name: 'Bass', kind: 'bass808', mixerTrack: 'auto' }, nameInsert: true };
  p = applyOps(p, [op, op, { type: 'channel/add', channel: { id: 'ch_two', name: 'Keys', kind: 'fm', mixerTrack: 'auto' }, nameInsert: true }]);
  const bass = p.channels.find((c) => c.id === 'ch_same');
  const keys = p.channels.find((c) => c.id === 'ch_two');
  assert.equal(p.channels.filter((c) => c.id === 'ch_same').length, 1);
  assert.equal(bass.mixerTrack, 5);
  assert.equal(keys.mixerTrack, 6);
  assert.equal(p.mixer[5].name, 'Bass');
  const clip = { kind: 'pattern', id: 'clip_1', refId: p.patterns[0].id, track: 0, start: 0, length: 384 };
  p = applyOps(p, [{ type: 'clip/add', clips: [clip] }, { type: 'clip/add', clips: [clip] }]);
  assert.equal(p.playlist.clips.length, 1);
});

test('roman numerals and diatonic chords', async () => {
  const { romanToChord, diatonicChords, isRomanNumeral } = await import('../src/index.js');
  assert.deepEqual(['i', 'VI', 'III', 'VII', 'bVII', 'V7', 'ii°'].map((r) => romanToChord(r, 'A', 'minor')), ['Am', 'F', 'C', 'G', 'G', 'E7', 'Bdim']);
  assert.deepEqual(['I', 'V', 'vi', 'IV', 'ii7'].map((r) => romanToChord(r, 'C', 'major')), ['C', 'G', 'Am', 'F', 'Dm7']);
  assert.equal(diatonicChords('C', 'major')[6].chord, 'Bdim');
  assert.ok(isRomanNumeral('bVII') && !isRomanNumeral('Am'));
});

test('roman numerals: 5/6-note scales, leading tone, extensions, secondary dominants', () => {
  assert.equal(romanToChord('VI', 'A', 'minorPentatonic'), 'F');
  assert.equal(romanToChord('VII', 'A', 'blues'), 'G');
  assert.equal(romanToChord('vii°7', 'C', 'minor'), 'Bdim7');
  assert.equal(romanToChord('i13', 'C', 'minor'), 'Cm13');
  assert.equal(romanToChord('imaj9', 'C', 'minor'), 'CmMaj9');
  assert.equal(romanToChord('V+7', 'C', 'major'), 'Gaug7');
  assert.equal(romanToChord('V7/V', 'C', 'major'), 'D7');
  assert.ok(isRomanNumeral('V7/vi'));
  assert.deepEqual(chordNotes('am', 4), chordNotes('Am', 4));
});

test('prepareOps makes replays deterministic', () => {
  const base = createProjectFromTemplate('default');
  const ops = prepareOps([
    { type: 'pattern/add', pattern: { name: 'X' } },
    { type: 'track/add', count: 2 },
    { type: 'mixer/add', count: 2 },
    { type: 'channel/add', channel: { name: 'S', kind: 'synth', mixerTrack: 'auto' } }
  ]);
  const a = applyOps(base, ops);
  const b = applyOps(base, ops);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(prepareOps(ops), ops, 'idempotent');
  const clipOps = prepareOps([{ type: 'clip/add', clips: [{ kind: 'pattern', refId: a.patterns[0].id, track: 40, start: 0, length: 384 }] }]);
  assert.equal(JSON.stringify(applyOps(a, clipOps)), JSON.stringify(applyOps(a, clipOps)));
});

test('normalizeProject survives malformed input', () => {
  const p = normalizeProject({ patterns: [null, { notes: { x: [null] } }], automations: [null, { target: { type: 'channel', id: 'nope', param: 'volume' } }], key: 42, scale: 'nonsense', name: { a: 1 }, channels: [{ id: 'a', instrument: { kind: 'kick' } }, { id: 'a', instrument: { kind: 'kick' } }], timeSig: [7, 3] });
  assert.equal(p.key, 'C');
  assert.equal(p.scale, 'minor');
  assert.equal(p.name, 'Untitled');
  assert.deepEqual(p.timeSig, [4, 4]);
  assert.equal(new Set(p.channels.map((c) => c.id)).size, 2);
  assert.equal(p.automations.length, 0);
  assert.throws(() => applyOps(p, [{ type: 'project/update', patch: { key: 'A minor' } }]), /Invalid key/);
});

test('diatonic chords and note names are spelled for the key', async () => {
  const { diatonicChords, scaleSpelling, spelledNoteName } = await import('../src/index.js');
  assert.deepEqual(diatonicChords('F', 'major').map((c) => c.chord), ['F', 'Gm', 'Am', 'Bb', 'C', 'Dm', 'Edim']);
  assert.deepEqual(diatonicChords('E', 'major').map((c) => c.chord), ['E', 'F#m', 'G#m', 'A', 'B', 'C#m', 'D#dim']);
  assert.equal(diatonicChords('A', 'harmonicMinor')[4].chord, 'E');
  assert.deepEqual(diatonicChords('A', 'harmonicMinor')[4].notes, ['E4', 'G#4', 'B4']);
  assert.deepEqual(diatonicChords('Eb', 'minor', { sevenths: true })[0].notes, ['Eb4', 'Gb4', 'Bb4', 'Db5']);
  const fs = scaleSpelling('F#', 'major');
  assert.equal(fs(5), 'E#');
  assert.equal(spelledNoteName(60, scaleSpelling('C#', 'major')), 'B#3');
  assert.equal(spelledNoteName(59, scaleSpelling('Gb', 'major')), 'Cb4');
  assert.equal(scaleSpelling('Zz', 'major')(1), 'Db'); // unknown key: plain flats, no throw
});

test('notes/add: re-adding existing notes does not count against the per-channel cap', async () => {
  const { createDefaultProject: createProject, applyOps, MAX_NOTES_PER_CHANNEL } = await import('../src/index.js');
  let p = createProject({ name: 'cap' });
  const pat = p.patterns[0].id;
  const ch = p.channels[0].id;
  const notes = Array.from({ length: MAX_NOTES_PER_CHANNEL }, (_, i) => ({ key: 60 + (i % 12), start: Math.floor(i / 12) * 6, length: 6 }));
  p = applyOps(p, [{ type: 'notes/set', patternId: pat, channelId: ch, notes }]);
  p = applyOps(p, [{ type: 'notes/add', patternId: pat, channelId: ch, notes: notes.slice(0, 50).map((n) => ({ ...n, velocity: 0.5 })) }]);
  assert.equal(p.patterns[0].notes[ch].length, MAX_NOTES_PER_CHANNEL);
  assert.throws(() => applyOps(p, [{ type: 'notes/add', patternId: pat, channelId: ch, notes: [{ key: 30, start: 0, length: 6 }] }]), /Max 8192 notes/);
});

test('step strings group by the felt beat (dotted quarters in 6/8)', async () => {
  const { createDefaultProject, summarizeProject, stepsPerBeat, applyOps } = await import('../src/index.js');
  assert.equal(stepsPerBeat({ timeSig: [4, 4] }), 4);
  assert.equal(stepsPerBeat({ timeSig: [6, 8] }), 6);
  assert.equal(stepsPerBeat({ timeSig: [12, 8] }), 6);
  assert.equal(stepsPerBeat({ timeSig: [3, 4] }), 4);
  assert.equal(stepsPerBeat({ timeSig: [7, 8] }), 2);
  let p = applyOps(createDefaultProject({ name: 'six-eight' }), [{ type: 'project/update', patch: { timeSig: [6, 8] } }]);
  const hits = [0, 6, 12, 18].map((s) => ({ key: 60, start: s * 24, length: 24, velocity: 0.8 }));
  p = applyOps(p, [
    { type: 'pattern/update', id: p.patterns[0].id, patch: { length: 24 * 24 } },
    { type: 'notes/set', patternId: p.patterns[0].id, channelId: p.channels[0].id, notes: hits }
  ]);
  const drumLine = summarizeProject(p).split('\n').find((l) => l.includes('x----- x----- | x----- x-----'));
  assert.ok(drumLine, 'expected 6-step groups in a 6/8 summary');
});

test('voicings: drop2, shell, rootless, spread keep chord tones; progressions stay in register', async () => {
  const { applyVoicing, chordNotes, chordProgressionNotes, VOICINGS } = await import('../src/index.js');
  const cmaj7 = chordNotes('Cmaj7', 4); // C4 E4 G4 B4
  assert.deepEqual(applyVoicing(cmaj7, 'drop2', 0), [55, 60, 64, 71]); // G3 C4 E4 B4
  assert.deepEqual(applyVoicing(cmaj7, 'shell', 0), [60, 64, 71]);
  assert.deepEqual(applyVoicing(cmaj7, 'rootless', 0), [64, 67, 71, 74]); // E G B D
  const spread = applyVoicing(cmaj7, 'spread', 0);
  assert.equal(spread[0], 48);
  assert.ok(spread[spread.length - 1] - spread[0] > 24);
  for (const v of VOICINGS) {
    const notes = chordProgressionNotes(['Dm9', 'G7', 'Cmaj7', 'Am7'], { voicing: v });
    const avg = (s) => { const ks = notes.filter((n) => n.start === s).map((n) => n.key); return ks.reduce((a, b) => a + b, 0) / ks.length; };
    assert.ok(Math.abs(avg(0) - avg(384 * 3)) < 9, `${v} drifted`);
  }
  assert.throws(() => chordProgressionNotes(['C'], { voicing: 'wide' }), /Unknown voicing/);
});

test('bass lines: degrees follow the chord, slides overlap, ties extend, slash bass on R', async () => {
  const { bassLineFromChords, parseBassLine } = await import('../src/index.js');
  const notes = bassLineFromChords(['Am', 'C/E'], 'R:4 3:2 5:2 b7:2 8:2~ -8:4', { octave: 2, gate: 0.5 });
  const bar1 = notes.filter((n) => n.start < 384).map((n) => n.key);
  assert.deepEqual(bar1, [45, 48, 52, 55, 57, 33]); // A2 C3 E3 G3 A3 A1
  const slide = notes.find((n) => n.start === 10 * 24);
  assert.equal(slide.length, 2 * 24 + 12); // slide = full length + half a step overlap
  assert.equal(notes.find((n) => n.start === 0).length, 48); // gate 0.5 on 4 steps
  const bar2 = notes.filter((n) => n.start >= 384);
  assert.equal(bar2[0].key % 12, 4); // R of C/E is E
  assert.equal(bar2.find((n) => n.start === 384 + 4 * 24).key % 12, 4); // 3 of C = E
  const tie = bassLineFromChords(['Am'], 'R:2 ~:2 5:4', { gate: 1 });
  assert.equal(tie[0].length, 96);
  assert.throws(() => parseBassLine('R:0'), /Invalid length/);
  assert.throws(() => parseBassLine('X:2'), /Invalid bass token/);
});

test('swing follows off-grid notes; channel groove fields and audio clip settings are ops', async () => {
  const { swingTicks, STEP: S, createDefaultProject, applyOps, normalizeProject } = await import('../src/index.js');
  assert.equal(swingTicks(S, 1), S / 2);
  assert.equal(swingTicks(S + 3, 1), ((S - 3) / S) * (S / 2)); // past the off-beat: ramps back to the next downbeat
  assert.ok(swingTicks(S - 2, 0.5) > 0); // a humanized off-beat keeps most of its swing
  let p = createDefaultProject();
  const ch = p.channels[1];
  p = applyOps(p, [{ type: 'channel/update', id: ch.id, patch: { nudge: 99, swingMix: 0.5 } }]);
  assert.equal(p.channels[1].nudge, 50);
  assert.equal(p.channels[1].swingMix, 0.5);
  p = applyOps(p, [{ type: 'clip/add', clips: [{ id: 'a1', kind: 'audio', refId: 'smp_x', track: 0, start: 0, length: 384, gain: 0.5, fadeIn: 24, rate: 1.1 }, { id: 'p1', kind: 'pattern', refId: p.patterns[0].id, track: 1, start: 0, length: 384 }] }]);
  const a = p.playlist.clips.find((c) => c.id === 'a1');
  assert.deepEqual([a.gain, a.fadeIn, a.fadeOut, a.rate], [0.5, 24, 0, 1.1]);
  assert.equal(p.playlist.clips.find((c) => c.id === 'p1').gain, undefined); // pattern clips have no audio fields
  p = applyOps(p, [{ type: 'clip/update', id: 'a1', patch: { fadeOut: 48, rate: 9 } }]);
  assert.equal(p.playlist.clips.find((c) => c.id === 'a1').fadeOut, 48);
  assert.equal(p.playlist.clips.find((c) => c.id === 'a1').rate, 4);
  assert.equal(normalizeProject(JSON.parse(JSON.stringify(p))).playlist.clips.find((c) => c.id === 'a1').gain, 0.5);
});

test('markers: add (idempotent), rename, move, remove; normalized and sorted', async () => {
  const { createDefaultProject, applyOps, prepareOps, normalizeProject, describeOps } = await import('../src/index.js');
  let p = createDefaultProject();
  const ops = prepareOps([{ type: 'marker/add', markers: [{ tick: 768, name: 'Hook' }, { tick: 0, name: 'Intro' }] }]);
  assert.ok(ops[0].markers.every((m) => m.id));
  p = applyOps(p, ops);
  p = applyOps(p, ops); // re-sent: no duplicates
  assert.deepEqual(p.markers.map((m) => m.name), ['Intro', 'Hook']);
  const hook = p.markers[1];
  p = applyOps(p, [{ type: 'marker/update', id: hook.id, patch: { name: 'Drop', tick: -5 } }]);
  assert.deepEqual(p.markers.map((m) => [m.name, m.tick]), [['Intro', 0], ['Drop', 0]].sort((a, b) => a[1] - b[1]));
  assert.match(describeOps(ops, p)[0], /Added marker Hook, Intro/);
  p = applyOps(p, [{ type: 'marker/remove', ids: [hook.id] }]);
  assert.equal(p.markers.length, 1);
  const raw = { ...p, markers: [{ tick: 'x', name: 5 }, null, { id: 'm', tick: 100, name: 'B' }, { id: 'm', tick: 50, name: 'A' }] };
  const n = normalizeProject(raw);
  assert.equal(n.markers.length, 3);
  assert.equal(new Set(n.markers.map((m) => m.id)).size, 3);
  assert.throws(() => applyOps(p, [{ type: 'marker/update', id: 'nope', patch: {} }]), /not found/);
});

test('effects: new params have safe defaults; pump source is a channel reference', async () => {
  const { createEffect, sanitizeParams, EFFECTS, describeEffects } = await import('../src/index.js');
  assert.equal(createEffect('limiter').params.ceiling, -1);
  assert.equal(createEffect('pump').params.source, null);
  assert.equal(createEffect('pump', { source: 'ch_1' }).params.source, 'ch_1');
  assert.equal(createEffect('eq').params.hpf, 20);
  assert.equal(createEffect('compressor').params.mix, 1);
  assert.equal(createEffect('stereo').params.monoBelow, 0);
  assert.equal(createEffect('reverb', { decay: 3 }).params.size, 0.5);
  assert.equal(sanitizeParams(EFFECTS.pump.params, { source: '' }).source, null);
  assert.equal(describeEffects().find((e) => e.type === 'pump').params.find((x) => x.key === 'source').type, 'channel');
});

test('templates: shared buses via sends and kick-triggered sidechains', async () => {
  const { createProjectFromTemplate } = await import('../src/index.js');
  for (const t of ['trap', 'house', 'boombap', 'lofi', 'techno']) {
    const p = createProjectFromTemplate(t);
    const reverbs = p.mixer.flatMap((m, i) => m.effects.filter((e) => e.type === 'reverb').map(() => i));
    assert.ok(reverbs.length <= 1, `${t}: one shared reverb`);
    for (const m of p.mixer) for (const s of m.sends) assert.ok(p.mixer[s.to], `${t}: send target exists`);
    for (const fx of p.mixer.flatMap((m) => m.effects)) if (fx.type === 'pump' && fx.params.source) assert.ok(p.channels.some((c) => c.id === fx.params.source));
  }
});

test('auto mixer insert skips buses (inserts with effects or incoming sends)', async () => {
  const { createProjectFromTemplate, applyOps } = await import('../src/index.js');
  const p = createProjectFromTemplate('trap'); // 7 channels on inserts 1-7, Reverb and Delay buses on 8 and 9
  const next = applyOps(p, [{ type: 'channel/add', channel: { id: 'ch_new', name: 'New', kind: 'perc', mixerTrack: 'auto' } }]);
  assert.equal(next.channels.find((c) => c.id === 'ch_new').mixerTrack, 10);
});

test('new projects: master fader at 0 dB (it sits after the limiter); old projects keep theirs', async () => {
  const { createDefaultProject, createProjectFromTemplate, normalizeProject } = await import('../src/index.js');
  assert.equal(createDefaultProject().mixer[0].volume, 1);
  assert.equal(createProjectFromTemplate('house').mixer[0].volume, 1);
  assert.equal(createDefaultProject().mixer[1].volume, 0.8);
  const old = createDefaultProject();
  old.mixer[0].volume = 0.8;
  assert.equal(normalizeProject(JSON.parse(JSON.stringify(old))).mixer[0].volume, 0.8);
});

test('scales for the world collections: Japanese pentatonics and Indian thaats', async () => {
  const { scaleNotes, diatonicChords, scaleSpelling, noteName } = await import('../src/index.js');
  assert.deepEqual(scaleNotes('D', 'hirajoshi', 4, 1).map(noteName), ['D4', 'E4', 'F4', 'A4', 'A#4', 'D5']);
  assert.deepEqual(scaleNotes('C', 'bhairav', 4, 1).length, 8);
  // pentatonics read their chords and spelling from the 7-note scale that holds them
  assert.deepEqual(diatonicChords('A', 'hirajoshi').map((c) => c.chord), diatonicChords('A', 'minor').map((c) => c.chord));
  assert.deepEqual(diatonicChords('E', 'inSen').map((c) => c.chord), diatonicChords('E', 'phrygian').map((c) => c.chord));
  assert.equal(scaleSpelling('D', 'inSen')(3), 'Eb');
  assert.equal(scaleSpelling('E', 'iwato')(5), 'F');
  // thaats are melodic (over a drone): no misleading triads
  for (const raga of ['bhairav', 'todi', 'purvi', 'marwa']) assert.throws(() => diatonicChords('C', raga), /played melodically/);
  for (const sc of ['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian', 'harmonicMinor', 'melodicMinor']) assert.equal(diatonicChords('C', sc).length, 7);
});

test('world templates: Indian Fusion and East Asian Lo-fi use the collections; the tabla follows the key', async () => {
  const { createProjectFromTemplate, INSTRUMENTS } = await import('../src/index.js');
  const indian = createProjectFromTemplate('indian');
  assert.equal(indian.scale, 'bhairav');
  assert.ok(indian.channels.every((c) => ['indian'].includes(INSTRUMENTS[c.instrument.kind].category)));
  assert.deepEqual([...new Set(indian.channels.map((c) => c.instrument.kind))].sort(), ['bansuri', 'harmonium', 'sitar', 'tabla', 'tanpura']);
  // meend: some sitar notes run into the next one (mono + glide slides there)
  const sitar = indian.channels.find((c) => c.name === 'Sitar');
  const line = indian.patterns.find((p) => p.name === 'Sitar').notes[sitar.id];
  assert.ok(line.some((n, i) => line[i + 1] && n.start + n.length > line[i + 1].start));
  assert.ok(line.some((n, i) => line[i + 1] && n.start + n.length < line[i + 1].start));
  const inD = createProjectFromTemplate('indian', { key: 'D' });
  assert.ok(inD.channels.filter((c) => c.instrument.kind === 'tabla').every((c) => c.pitch === 2));
  assert.equal(inD.channels.find((c) => c.name === 'Sitar').instrument.params.sa, 'D'); // the taraf follows the key
  assert.equal(createProjectFromTemplate('indian', { key: 'Bb' }).channels.find((c) => c.name === 'Sitar').instrument.params.sa, 'A#');
  assert.equal(inD.patterns.find((p) => p.name === 'Tanpura').notes[inD.channels[0].id][0].key, 45); // G2 → A2
  const asia = createProjectFromTemplate('eastasian');
  assert.equal(asia.scale, 'hirajoshi');
  assert.equal(asia.swing, 0.3);
  for (const k of ['koto', 'shakuhachi', 'taiko', 'gong']) assert.ok(asia.channels.some((c) => c.instrument.kind === k), k);
  assert.deepEqual(asia.markers.map((m) => m.name), ['Intro', 'Verse', 'Taiko']);
});

test('genre templates: reverbs on send buses, kick sidechains, every part inside its pattern, heard and in the scale', async () => {
  const { createProjectFromTemplate, INSTRUMENTS, scalePitchClasses } = await import('../src/index.js');
  const genres = ['drill', 'afrobeats', 'reggaeton', 'dnb', 'synthwave', 'disco', 'neosoul', 'bossanova', 'cinematic', 'beatbox'];
  for (const t of genres) {
    const p = createProjectFromTemplate(t);
    const fed = new Set(p.mixer.flatMap((m) => m.sends.map((s) => s.to)));
    p.mixer.forEach((m, i) => {
      if (m.effects.some((e) => e.type === 'reverb')) assert.ok(fed.has(i), `${t}: reverb on ${m.name} is not a send bus`);
    });
    const kick = p.channels.find((c) => c.name === 'Kick');
    for (const fx of p.mixer.flatMap((m) => m.effects)) if (fx.type === 'pump') assert.equal(fx.params.source, kick?.id, `${t}: pump keyed by the kick`);
    const placed = p.patterns.filter((pt) => p.playlist.clips.some((c) => c.refId === pt.id));
    for (const pt of p.patterns) for (const n of Object.values(pt.notes).flat()) assert.ok(n.start + n.length <= pt.length, `${t}: ${pt.name} runs past its end`);
    for (const c of p.channels) assert.ok(placed.some((pt) => pt.notes[c.id]?.length), `${t}: ${c.name} never plays`);
    // bossa nova's II7 and bII7 are chromatic on purpose
    if (t === 'bossanova') continue;
    const pcs = scalePitchClasses(p.key, p.scale);
    for (const c of p.channels.filter((ch) => INSTRUMENTS[ch.instrument.kind].melodic)) {
      for (const n of p.patterns.flatMap((pt) => pt.notes[c.id] || [])) assert.ok(pcs.includes(n.key % 12), `${t}: ${c.name} plays ${n.key} outside ${p.key} ${p.scale}`);
    }
  }
  assert.equal(createProjectFromTemplate('dnb').bpm, 174);
  assert.equal(createProjectFromTemplate('drill', { key: 'A' }).key, 'A');
});

test('template labels state the tempo their project is built at', async () => {
  const { TEMPLATES, createProjectFromTemplate } = await import('../src/index.js');
  for (const [id, t] of Object.entries(TEMPLATES)) {
    if (id === 'default' || id === 'empty') continue;
    const { bpm } = createProjectFromTemplate(id);
    assert.equal(t.bpm, bpm, id);
    assert.ok(t.label.includes(`(${bpm} BPM`), `${id}: "${t.label}" should say ${bpm} BPM`);
  }
});

test('melody strings: "~" slides into the next note, "!" accents, junk after a length is refused', async () => {
  const { melodyFromString, romanToChord } = await import('../src/index.js');
  const { melodyLength } = await import('../src/index.js');
  // a slide overlaps the next note by half a step (swing/humanize can't open a gap); before a rest it just fills its length
  const m = melodyFromString('C4:4~ Db4:2!~ C4:2~ -:2 E4:1.5', { gate: 0.9 });
  assert.deepEqual(m.map((n) => [n.start, n.length, n.velocity]), [[0, 108, 0.8], [96, 60, 1], [144, 48, 0.8], [240, 32, 0.8]]);
  assert.equal(melodyLength('C4:4~ Db4:2!~ C4:2~ -:2 E4:1.5'), 276);
  assert.equal(melodyLength('C4:4!~ D4:.5 r'), 96 + 12 + 24);
  // the overlap never runs past the next note, and a slide into the same pitch is a plain re-strike
  assert.deepEqual(melodyFromString('C4:2~ D4:.25').map((n) => n.start + n.length), [54, 54]);
  assert.deepEqual(melodyFromString('C4:2~ C4:2').map((n) => n.length), [48, 46]);
  for (const bad of ['C4:4x', 'C4:2:2', 'C4:', 'C4:-1', 'C5:1e4', 'C5:1/2', ':2']) {
    assert.throws(() => melodyFromString(bad), /Invalid melody token/);
    assert.throws(() => melodyLength(bad), /Invalid melody token/);
  }
  // thaat numerals spell their roots like the scale (D bhairav = D Eb F# G A Bb C#)
  assert.equal(romanToChord('II', 'D', 'bhairav'), 'Eb');
  assert.equal(romanToChord('iv', 'D', 'bhairav'), 'Gm');
  assert.equal(romanToChord('bII', 'D', 'bhairav'), 'Eb');
  assert.equal(romanToChord('II', 'D', 'major'), 'E'); // unchanged elsewhere
  assert.equal(romanToChord('VI', 'A', 'minor'), 'F');
});

test('instrument catalog: every kind sits in a listed category, and no category is empty', async () => {
  const { INSTRUMENTS, INSTRUMENT_KINDS, INSTRUMENT_CATEGORIES } = await import('../src/index.js');
  const cats = new Set(INSTRUMENT_CATEGORIES.map(([c]) => c));
  assert.equal(cats.size, INSTRUMENT_CATEGORIES.length);
  for (const kind of INSTRUMENT_KINDS) {
    assert.ok(cats.has(INSTRUMENTS[kind].category), `${kind}: unknown category ${INSTRUMENTS[kind].category}`);
  }
  for (const [cat] of INSTRUMENT_CATEGORIES) assert.ok(INSTRUMENT_KINDS.some((k) => INSTRUMENTS[k].category === cat), `${cat} is empty`);
});

test('world collections: flutes, beatbox, Indian and East Asian instruments are complete and valid', async () => {
  const { INSTRUMENTS, instrumentDefaults, sanitizeParams } = await import('../src/index.js');
  const collections = {
    flutes: ['flute', 'panflute', 'recorder', 'whistle', 'ocarina'],
    beatbox: ['bbkick', 'bbsnare', 'bbhat', 'bbbass', 'bbfx'],
    indian: ['sitar', 'tanpura', 'tabla', 'bansuri', 'shehnai', 'santoor', 'harmonium'],
    eastasian: ['koto', 'guzheng', 'pipa', 'shamisen', 'erhu', 'shakuhachi', 'dizi', 'suona', 'taiko', 'gong']
  };
  const drums = new Set(['bbkick', 'bbsnare', 'bbhat', 'bbfx', 'tabla', 'taiko', 'gong']);
  // instruments that slide between overlapping notes out of the box (meend, slurs, bends)
  const legato = ['whistle', 'bbbass', 'sitar', 'bansuri', 'shehnai', 'erhu', 'shakuhachi', 'dizi', 'suona'];
  for (const [category, kinds] of Object.entries(collections)) {
    assert.deepEqual(Object.keys(INSTRUMENTS).filter((k) => INSTRUMENTS[k].category === category), kinds);
    for (const kind of kinds) {
      const def = INSTRUMENTS[kind];
      assert.equal(def.melodic, !drums.has(kind), `${kind} melodic`);
      if (!def.melodic) assert.equal(def.defaultKey, 60, `${kind}: drums play at their natural pitch on C4`);
      assert.ok(def.description.length > 60, `${kind} needs a description Claude can use`);
      assert.match(def.color, /^#[0-9a-f]{6}$/);
      const defaults = instrumentDefaults(kind);
      for (const p of def.params) {
        if (p.type === 'number') assert.ok(p.default >= p.min && p.default <= p.max && p.min < p.max, `${kind}.${p.key} range/default`);
        if (p.type === 'select') assert.ok(p.options.includes(p.default), `${kind}.${p.key} default is an option`);
      }
      assert.equal(new Set(def.params.map((p) => p.key)).size, def.params.length, `${kind}: duplicate param`);
      assert.ok(Object.keys(def.presets).length >= 2, `${kind} has presets`);
      assert.deepEqual(Object.values(def.presets)[0], {}, `${kind}: the first preset is the default sound`);
      for (const [name, values] of Object.entries(def.presets)) {
        const inst = makeInstrument(kind, name, {}, { strict: true });
        assert.equal(inst.preset, name);
        assert.deepEqual(sanitizeParams(def.params, values, { strict: true }), values, `${kind} preset ${name}`);
        assert.equal(Object.keys(inst.params).length, Object.keys(defaults).length);
      }
      if (legato.includes(kind)) assert.equal(defaults.mono, true, `${kind} slides by default`);
    }
  }
  assert.throws(() => makeInstrument('tabla', null, { stroke: 'tirakita' }, { strict: true }), /na, tin, tun, te, ge, ke, dha, dhin/);
  assert.throws(() => makeInstrument('sitar', null, { sa: 'H' }, { strict: true }), /must be one of/);
  assert.throws(() => makeInstrument('gong', null, { bend: 2 }, { strict: true }), /between -1 and 1/);
  assert.throws(() => makeInstrument('flute', null, { buzz: 0.5 }, { strict: true }), /Unknown parameter "buzz"/); // only the dizi has a membrane
  assert.equal(makeInstrument('dizi', 'Xiao').params.buzz, 0);
  assert.equal(makeInstrument('tabla', 'Dha').params.stroke, 'dha');
  const listed = describeInstruments();
  for (const kinds of Object.values(collections)) for (const k of kinds) assert.ok(listed.find((d) => d.kind === k)?.presets.length);
});

test('band instruments: every param, preset and category is valid (piano, epiano, organ, guitar, bass, strings)', async () => {
  const { INSTRUMENTS, instrumentDefaults, sanitizeParams } = await import('../src/index.js');
  const band = { piano: 'keys', epiano: 'keys', organ: 'keys', guitar: 'guitar', bass: 'bass', strings: 'strings' };
  for (const [kind, category] of Object.entries(band)) {
    const def = INSTRUMENTS[kind];
    assert.equal(def.category, category);
    assert.equal(def.melodic, true);
    assert.ok(def.description.length > 40, `${kind} needs a description Claude can use`);
    const defaults = instrumentDefaults(kind);
    for (const p of def.params) {
      if (p.type === 'number') assert.ok(p.default >= p.min && p.default <= p.max, `${kind}.${p.key} default in range`);
      if (p.type === 'select') assert.ok(p.options.includes(p.default), `${kind}.${p.key} default is an option`);
    }
    for (const [name, values] of Object.entries(def.presets)) {
      // presets must pass strict validation (what MCP uses) and only name real params
      const inst = makeInstrument(kind, name, {}, { strict: true });
      assert.equal(inst.preset, name);
      assert.deepEqual(sanitizeParams(def.params, values, { strict: true }), values, `${kind} preset ${name}`);
      assert.equal(Object.keys(inst.params).length, Object.keys(defaults).length);
    }
  }
  assert.throws(() => makeInstrument('organ', null, { db8: 9 }, { strict: true }), /between 0 and 8/);
  assert.throws(() => makeInstrument('strings', null, { articulation: 'tremolo' }, { strict: true }), /legato, staccato, pizzicato/);
  assert.equal(makeInstrument('organ', null, { db4: 6.6 }).params.db4, 7); // drawbars are whole steps
  const kinds = describeInstruments().map((d) => d.kind);
  for (const k of Object.keys(band)) assert.ok(kinds.includes(k));
});
