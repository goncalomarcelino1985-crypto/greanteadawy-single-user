import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeClip, clipLength, sliceClip, deleteRange, insertClip, silenceRange, fadeRange, gainRange, peakDb, normalizeRange,
  reverseRange, toMono, toStereo, removeDC, trimSilence, resampleClip, speedRange, stretchRange, nearestZeroCrossing,
  waveformPeaks, applyEdit, EDIT_OPS, trackPitch, findNotes, scaleSnapper, snapNotes, correctionCurve, analyzeMelody,
  autotune, pitchShiftClip, timeStretch, hzToMidi, noteCenter
} from '../src/index.js';

const SR = 44100;
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
const ramp = (n) => Float32Array.from({ length: n }, (_, i) => i + 1);
const clipOf = (...chans) => makeClip(chans, SR);

/** A voice-like tone (four harmonics) through a list of { hz (0 = rest), dur, vib (semitones) } notes. */
function voice(notes) {
  const x = new Float32Array(Math.round(notes.reduce((a, n) => a + n.dur, 0) * SR));
  let ph = 0;
  let i = 0;
  for (const n of notes) {
    const N = Math.round(n.dur * SR);
    for (let k = 0; k < N; k++, i++) {
      const f = n.hz ? n.hz * Math.pow(2, ((n.vib || 0) * Math.sin((2 * Math.PI * 5.5 * k) / SR)) / 12) : 0;
      ph += (2 * Math.PI * f) / SR;
      const env = n.hz ? Math.min(1, k / (0.01 * SR), (N - k) / (0.01 * SR)) : 0;
      x[i] = env * 0.3 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph));
    }
  }
  return x;
}
const pitchOf = (x) => median(trackPitch(x, SR).hz.filter(Boolean));
const cents = (a, b) => 1200 * Math.log2(a / b);

test('makeClip validates channels, lengths and sample rate', () => {
  assert.throws(() => makeClip([], SR), /1 or 2 channels/);
  assert.throws(() => makeClip([new Float32Array(3), new Float32Array(4)], SR), /same length/);
  assert.throws(() => makeClip([new Float32Array(3)], 100), /sample rate/);
  assert.throws(() => makeClip([new Float32Array(3), new Float32Array(3), new Float32Array(3)], SR), /1 or 2/);
  assert.ok(makeClip([[0, 1]], SR).channels[0] instanceof Float32Array);
});

test('slice, delete and insert keep lengths right and never touch the input', () => {
  const c = clipOf(ramp(1000));
  const before = c.channels[0].slice();
  assert.equal(clipLength(sliceClip(c, 100, 300)), 200);
  assert.equal(sliceClip(c, 100, 300).channels[0][0], 101);
  const d = deleteRange(c, 100, 300);
  assert.equal(clipLength(d), 800);
  assert.equal(d.channels[0][500], 701);
  const ins = insertClip(c, 500, clipOf(new Float32Array(50)));
  assert.equal(clipLength(ins), 1050);
  const rep = insertClip(c, 100, clipOf(new Float32Array(10)), 300); // replace 200 frames with 10
  assert.equal(clipLength(rep), 810);
  assert.deepEqual(c.channels[0], before);
});

test('paste conforms channel count and sample rate', () => {
  const stereo = clipOf(new Float32Array(100), new Float32Array(100));
  const mono22k = makeClip([new Float32Array(50).fill(0.5)], 22050);
  const out = insertClip(stereo, 50, mono22k);
  assert.equal(out.channels.length, 2);
  assert.equal(clipLength(out), 200); // 50 frames at 22.05 kHz = 100 at 44.1 kHz
});

test('silence, fades, gain and normalize', () => {
  const c = clipOf(new Float32Array(SR).fill(0.5));
  const s = silenceRange(c, 1000, 2000);
  assert.equal(s.channels[0][1500], 0);
  assert.equal(s.channels[0][5000], 0.5);
  const f = fadeRange(c, 0, 1000, 'in', 'scurve');
  assert.equal(f.channels[0][0], 0);
  assert.ok(Math.abs(f.channels[0][999] - 0.5) < 1e-6);
  assert.ok(f.channels[0][250] < 0.5 * 0.25); // s-curve starts slower than linear
  const o = fadeRange(c, 0, SR, 'out', 'linear');
  assert.ok(Math.abs(o.channels[0][SR - 1]) < 1e-6);
  assert.ok(Math.abs(peakDb(gainRange(c, 0, SR, 6)) - (20 * Math.log10(0.5) + 6)) < 1e-3);
  assert.ok(Math.abs(peakDb(normalizeRange(c, 0, SR, -1)) - -1) < 1e-3);
  assert.equal(peakDb(normalizeRange(clipOf(new Float32Array(10)), 0, 10)), -Infinity); // silence stays silent
});

test('reverse, mono/stereo and DC removal', () => {
  const c = clipOf(ramp(10), ramp(10).map((v) => -v));
  assert.deepEqual([...reverseRange(c, 0, 4).channels[0].subarray(0, 5)], [4, 3, 2, 1, 5]);
  assert.equal(toMono(c).channels.length, 1);
  assert.equal(toMono(c).channels[0][3], 0);
  assert.equal(toStereo(clipOf(ramp(4))).channels.length, 2);
  const dc = removeDC(clipOf(new Float32Array(SR).fill(0.3)));
  assert.ok(Math.abs(dc.channels[0][SR - 1]) < 0.01);
});

test('trimSilence and nearestZeroCrossing', () => {
  const x = new Float32Array(SR);
  for (let i = 10000; i < 20000; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const t = trimSilence(clipOf(x), -50, 10);
  const len = clipLength(t);
  assert.ok(len > 10000 && len < 10000 + 0.025 * SR, `trimmed to ${len}`);
  const z = nearestZeroCrossing(clipOf(x), 10050);
  assert.ok(Math.abs(x[z]) < 0.05 || Math.sign(x[z]) !== Math.sign(x[z - 1]));
});

test('resample, speed and stretch change length as asked', () => {
  const c = clipOf(voice([{ hz: 220, dur: 1 }]));
  assert.equal(clipLength(resampleClip(c, 0.5)), SR / 2);
  const fast = speedRange(c, 0, SR, 2);
  assert.ok(Math.abs(clipLength(fast) - SR / 2) <= 1);
  assert.ok(Math.abs(cents(pitchOf(fast.channels[0]), 440)) < 10, 'speed 2 = an octave up');
  const slow = stretchRange(c, 0, SR, 0.5);
  assert.ok(Math.abs(clipLength(slow) - 2 * SR) <= 1);
  assert.ok(Math.abs(cents(pitchOf(slow.channels[0]), 220)) < 5, 'stretch keeps the pitch');
  assert.throws(() => speedRange(c, 0, SR, 10), /between 0.25 and 4/);
  assert.equal(timeStretch([new Float32Array(SR)], SR, 2)[0].length, SR / 2);
});

test('waveformPeaks gives min/max per column', () => {
  const p = waveformPeaks(clipOf(Float32Array.from({ length: 1000 }, (_, i) => (i < 500 ? 0.5 : -0.25))), 0, 1000, 2);
  assert.deepEqual([...p], [0.5, 0.5, -0.25, -0.25]);
});

test('trackPitch reads a steady tone within a few cents and finds no pitch in silence', () => {
  for (const hz of [98, 220, 659.25]) {
    const got = pitchOf(voice([{ hz, dur: 0.6 }]));
    assert.ok(Math.abs(cents(got, hz)) < 3, `${hz} Hz read as ${got}`);
  }
  const silent = trackPitch(new Float32Array(SR / 2), SR);
  assert.equal(silent.hz.filter(Boolean).length, 0);
});

test('findNotes keeps a wide vibrato as one note but splits a semitone step sung flat-to-sharp', () => {
  const x = voice([{ hz: 440, dur: 0.6, vib: 0.7 }, { hz: 523.25 * Math.pow(2, -30 / 1200), dur: 0.4 }, { hz: 493.88 * Math.pow(2, 25 / 1200), dur: 0.4 }]);
  const notes = findNotes(trackPitch(x, SR));
  assert.deepEqual(notes.map((n) => Math.round(n.center)), [69, 72, 71]);
});

test('findNotes splits a melody at rests and pitch changes, but keeps vibrato as one note', () => {
  const x = voice([{ hz: 261.63, dur: 0.4, vib: 0.4 }, { hz: 0, dur: 0.1 }, { hz: 293.66, dur: 0.3 }, { hz: 329.63, dur: 0.3 }]);
  const notes = findNotes(trackPitch(x, SR));
  assert.equal(notes.length, 3);
  assert.deepEqual(notes.map((n) => Math.round(n.center)), [60, 62, 64]);
  assert.ok(Math.abs(notes[2].startSec - 0.8) < 0.04, `third note starts at ${notes[2].startSec}`);
});

test('scale snapping: C major, pentatonic, chromatic and errors', () => {
  const major = scaleSnapper('C', 'major');
  assert.equal(major(61.4), 62); // C#+ → D
  assert.equal(major(60.4), 60);
  assert.equal(major(65.6), 65); // F#- → F (nearer than G)
  assert.equal(scaleSnapper('A', 'minorPentatonic')(70.2), 69); // Bb → A
  assert.equal(scaleSnapper()(61.4), 61);
  assert.throws(() => scaleSnapper('C', 'nope'), /Unknown scale/);
  assert.throws(() => scaleSnapper('H', 'major'), /Invalid key/);
  const snapped = snapNotes([{ center: 61.4, target: 61.4 }, { center: 61.4, target: 67, locked: true }], 'C', 'major');
  assert.deepEqual(snapped.map((n) => n.target), [62, 67]);
});

test('correctionCurve: speed glides in, 0 is instant, flatten irons out vibrato, bypass skips', () => {
  const hop = 0.005;
  const hz = new Float32Array(200).fill(440);
  for (let f = 0; f < 200; f++) hz[f] = 440 * Math.pow(2, (0.3 * Math.sin(f / 5)) / 12);
  const track = { hop, hz };
  const notes = [{ start: 0, end: 200, center: 69.4, target: 69 }];
  const instant = correctionCurve(track, notes, { speedMs: 0 });
  assert.ok(Math.abs(instant[0] - -0.4) < 1e-6);
  const slow = correctionCurve(track, notes, { speedMs: 100 });
  assert.ok(Math.abs(slow[0]) < 0.05 && Math.abs(slow[199] - -0.4) < 0.01);
  const half = correctionCurve(track, notes, { speedMs: 0, amount: 0.5 });
  assert.ok(Math.abs(half[10] - -0.2) < 1e-6);
  const flat = correctionCurve(track, notes, { speedMs: 0, flatten: 1 });
  for (let f = 0; f < 200; f++) assert.ok(Math.abs(hzToMidi(hz[f]) + flat[f] - 69) < 1e-4);
  const none = correctionCurve(track, [{ ...notes[0], bypass: true }], {});
  assert.equal(none.filter(Boolean).length, 0);
});

test('autotune pulls an out-of-tune melody onto C major', () => {
  const sharp = (hz, c) => hz * Math.pow(2, c / 1200);
  const x = voice([{ hz: sharp(261.63, 35), dur: 0.4, vib: 0.15 }, { hz: 0, dur: 0.1 }, { hz: sharp(293.66, -40), dur: 0.4 }, { hz: sharp(392, 30), dur: 0.4 }]);
  const r = autotune({ sampleRate: SR, channels: [x] }, { key: 'C', scale: 'major', speedMs: 0, flatten: 1 });
  assert.equal(r.notes.length, 3);
  assert.equal(r.scaleLabel, 'C major');
  assert.ok(r.maxMove > 0.3 && r.maxMove < 0.45);
  assert.equal(r.clip.channels[0].length, x.length);
  const after = findNotes(trackPitch(r.clip.channels[0], SR));
  assert.deepEqual(after.map((n) => Math.round(n.center)), [60, 62, 67]);
  for (const n of after) assert.ok(Math.abs(n.center - Math.round(n.center)) < 0.06, `note ${n.center} still off`);
});

test('analyzeMelody restricts notes to a range', () => {
  const x = voice([{ hz: 261.63, dur: 0.4 }, { hz: 0, dur: 0.1 }, { hz: 392, dur: 0.4 }]);
  const { notes } = analyzeMelody({ sampleRate: SR, channels: [x] }, { start: Math.round(0.6 * SR), end: x.length });
  assert.equal(notes.length, 1);
  assert.equal(Math.round(notes[0].center), 67);
});

test('pitchShiftClip moves a voice by semitones (PSOLA) and a chord by resample + stretch, keeping length', () => {
  const v = voice([{ hz: 220, dur: 1 }]);
  const up = pitchShiftClip({ sampleRate: SR, channels: [v] }, 0, v.length, 2);
  assert.equal(up.channels[0].length, v.length);
  assert.ok(Math.abs(cents(pitchOf(up.channels[0]), 220 * Math.pow(2, 2 / 12))) < 8);
  const chord = Float32Array.from({ length: SR }, (_, i) => 0.2 * (Math.sin((2 * Math.PI * 220 * i) / SR) + Math.sin((2 * Math.PI * 277.18 * i) / SR) + Math.sin((2 * Math.PI * 329.63 * i) / SR)) + 0.1 * (((i * 7919) % 101) / 101 - 0.5));
  const down = pitchShiftClip({ sampleRate: SR, channels: [chord, chord] }, 0, SR, -12);
  assert.equal(down.channels.length, 2);
  assert.equal(down.channels[0].length, SR);
  assert.ok(down.channels[0].every(Number.isFinite));
  // only the range moves
  const part = pitchShiftClip({ sampleRate: SR, channels: [v] }, SR / 2, SR, 5);
  assert.deepEqual(part.channels[0].subarray(0, SR / 2), v.subarray(0, SR / 2));
});

test('applyEdit runs named operations in seconds and rejects bad input', () => {
  const c = clipOf(voice([{ hz: 220, dur: 1 }]));
  assert.equal(clipLength(applyEdit(c, { op: 'trim', start: 0.25, end: 0.75 }).clip), SR / 2);
  assert.equal(clipLength(applyEdit(c, { op: 'delete', start: 0, end: 0.5 }).clip), SR / 2);
  assert.equal(clipLength(applyEdit(c, { op: 'stretch', rate: 2 }).clip), SR / 2);
  assert.equal(applyEdit(c, { op: 'fade_in' }).clip.channels[0][0], 0);
  assert.ok(Math.abs(peakDb(applyEdit(c, { op: 'normalize', peakDb: -3 }).clip) - -3) < 1e-3);
  assert.equal(applyEdit(c, { op: 'stereo' }).clip.channels.length, 2);
  assert.match(applyEdit(c, { op: 'pitch_correct', key: 'A', scale: 'minor' }).note, /1 notes? tuned to A minor/);
  assert.throws(() => applyEdit(c, { op: 'gain', db: 99 }), /between -48 and 48/);
  assert.throws(() => applyEdit(c, { op: 'pitch_shift', semitones: 30 }), /between -24 and 24/);
  assert.throws(() => applyEdit(c, { op: 'trim', start: 0.8, end: 0.2 }), /outside the sample/);
  assert.throws(() => applyEdit(c, { op: 'trim', start: 5 }), /outside the sample/);
  assert.throws(() => applyEdit(c, { op: 'explode' }), /Unknown edit/);
  for (const op of Object.keys(EDIT_OPS)) assert.ok(applyEdit(c, { op, start: 0.1, end: 0.3, db: 1, rate: 1.5, semitones: 1 }).clip, op);
});

const maxJump = (x) => { let m = 0; for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1])); return m; };
const mh = (m) => 440 * Math.pow(2, (m - 69) / 12);
const sharp = (hz, c) => hz * Math.pow(2, c / 1200);

test('PSOLA shifts an octave down (and up) to the right pitch without clicks or level loss', () => {
  const v = voice([{ hz: 220, dur: 1 }]);
  const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
  for (const d of [-12, -7, 12]) {
    const out = pitchShiftClip({ sampleRate: SR, channels: [v] }, 0, v.length, d).channels[0];
    const got = median(trackPitch(out, SR, { minHz: 40 }).hz.filter(Boolean));
    assert.ok(Math.abs(cents(got, 220 * Math.pow(2, d / 12))) < 10, `${d}: ${got} Hz`);
    assert.ok(maxJump(out) < 0.08, `${d}: jump ${maxJump(out)}`);
    assert.ok(Math.abs(20 * Math.log10(rms(out) / rms(v))) < 2, `${d}: level`);
  }
});

test('findNotes: vibrato of any usual rate and depth is one note, a scoop stays part of its note, fast runs split', () => {
  const one = (notes) => findNotes(trackPitch(voice(notes), SR)).map((n) => Math.round(n.center));
  for (const rate of [3.5, 4, 4.5, 5, 5.5, 7]) for (const vib of [0.3, 0.4, 0.5, 0.6, 1]) {
    const x = new Float32Array(Math.round(0.8 * SR));
    let ph = 0;
    for (let k = 0; k < x.length; k++) { ph += (2 * Math.PI * 440 * Math.pow(2, (vib * Math.sin((2 * Math.PI * rate * k) / SR)) / 12)) / SR; x[k] = 0.3 * Math.min(1, k / 441, (x.length - k) / 441) * (Math.sin(ph) + 0.5 * Math.sin(2 * ph)); }
    assert.deepEqual(findNotes(trackPitch(x, SR)).map((n) => Math.round(n.center)), [69], `vibrato ${rate} Hz ±${vib}`);
  }
  const scoop = new Float32Array(Math.round(0.6 * SR));
  let ph = 0;
  for (let k = 0; k < scoop.length; k++) { ph += (2 * Math.PI * mh(64 + Math.min(0, -2 * (1 - k / (0.08 * SR))))) / SR; scoop[k] = 0.3 * Math.min(1, k / 441, (scoop.length - k) / 441) * Math.sin(ph); }
  assert.deepEqual(findNotes(trackPitch(scoop, SR)).map((n) => Math.round(n.center)), [64]);
  const run = [60, 62, 64, 65, 67, 69, 71, 72];
  const notes = findNotes(trackPitch(voice(run.map((m) => ({ hz: mh(m), dur: 0.125 }))), SR));
  assert.deepEqual(notes.map((n) => Math.round(n.center)), run);
  for (const n of notes) assert.ok(Math.abs(n.center - Math.round(n.center)) < 0.05, `run note ${n.center}`);
  assert.deepEqual(one([64, 65, 64, 65].map((m) => ({ hz: mh(m), dur: 0.1 }))), [64, 65, 64, 65]);
});

test('an in-tune fast run stays in tune after auto-tune', () => {
  const run = [60, 62, 64, 65, 67, 69, 71, 72];
  const x = voice(run.map((m) => ({ hz: mh(m), dur: 0.125 })));
  const r = autotune({ sampleRate: SR, channels: [x] }, { key: 'C', scale: 'major', speedMs: 0 });
  const after = findNotes(trackPitch(r.clip.channels[0], SR));
  assert.deepEqual(after.map((n) => Math.round(n.center)), run);
  for (const n of after) assert.ok(Math.abs(n.center - Math.round(n.center)) < 0.08, `note ${n.center}`);
});

test('auto-tune and pitch shift leave the audio outside what they change untouched, with crossfaded edges', () => {
  const x = voice([{ hz: 440, dur: 0.5 }, { hz: 0, dur: 0.3 }, { hz: sharp(440, 40), dur: 0.5 }, { hz: 0, dur: 0.3 }]);
  // only the second note is off: the first one and the silences stay bit-identical
  const r = autotune({ sampleRate: SR, channels: [x] }, { speedMs: 0, start: Math.round(0.8 * SR), end: Math.round(1.3 * SR) });
  const y = r.clip.channels[0];
  for (let i = 0; i < Math.round(0.7 * SR); i++) assert.equal(y[i], x[i]);
  assert.ok(Math.abs(median(trackPitch(y.subarray(Math.round(0.85 * SR), Math.round(1.25 * SR)), SR).hz.filter(Boolean)) - 440) < 2);
  const chord = Float32Array.from({ length: 2 * SR }, (_, i) => 0.2 * (Math.sin((2 * Math.PI * 220 * i) / SR) + Math.sin((2 * Math.PI * 277.18 * i) / SR) + Math.sin((2 * Math.PI * 329.63 * i) / SR)));
  const sh = pitchShiftClip({ sampleRate: SR, channels: [chord] }, Math.round(0.5 * SR), Math.round(1.5 * SR), 12).channels[0];
  assert.ok(maxJump(sh) < 0.12, `edges click: ${maxJump(sh)}`);
  assert.deepEqual(sh.subarray(0, Math.round(0.49 * SR)), chord.subarray(0, Math.round(0.49 * SR)));
});

test('edits that would empty the sample or pass 20 minutes are refused; odd scale names are unknown', () => {
  const c = clipOf(voice([{ hz: 220, dur: 0.5 }]));
  assert.throws(() => applyEdit(c, { op: 'delete' }), /leave the sample empty/);
  assert.throws(() => applyEdit(c, { op: 'trim', start: 0, end: 0.00001 }), /empty|outside/);
  assert.equal(clipLength(speedRange(c, 100, 100, 2)), clipLength(c));
  assert.throws(() => scaleSnapper('C', 'constructor'), /Unknown scale/);
  assert.throws(() => scaleSnapper('C', '__proto__'), /Unknown scale/);
  const dc = removeDC(clipOf(new Float32Array(1000).fill(0.4)));
  assert.ok(Math.abs(dc.channels[0][0]) < 1e-6 && Math.abs(dc.channels[0][10]) < 0.01);
});

test('correctionCurve: a bypassed note ends the glide, and note order does not matter', () => {
  const hop = 0.005;
  const track = { hop, hz: new Float32Array(300).fill(440) };
  const a = { start: 0, end: 100, center: 69, target: 71 };
  const b = { start: 100, end: 110, center: 69, target: 69, bypass: true };
  const c = { start: 112, end: 200, center: 69.3, target: 69 };
  const curve = correctionCurve(track, [a, b, c], { speedMs: 50 });
  assert.ok(Math.abs(curve[112]) < 0.05, `starts from its own pitch: ${curve[112]}`);
  assert.deepEqual(correctionCurve(track, [c, a, b], { speedMs: 50 }), curve);
});

test('findNotes copes with tracker jitter in fast runs and very wide vibrato; PSOLA follows note changes closely', () => {
  const hop = 0.005;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.2; // ±0.1 semitone per frame
  const seq = [60, 64, 67, 64, 60, 64, 67, 72, 67, 64, 60];
  for (const ms of [80, 120, 200]) {
    const n = Math.round((seq.length * ms) / 1000 / hop);
    const hz = Float32Array.from({ length: n }, (_, f) => mh(seq[Math.min(seq.length - 1, Math.floor((f * hop * 1000) / ms))] + rnd()));
    assert.deepEqual(findNotes({ hz, hop }).map((x) => Math.round(x.center)), seq, `${ms} ms notes`);
  }
  const wide = Float32Array.from({ length: 400 }, (_, f) => mh(60 + 1.0 * Math.sin(2 * Math.PI * 6 * f * hop)));
  assert.equal(findNotes({ hz: wide, hop }).length, 1);
  // a run left in tune by auto-tune keeps its note boundaries (the output is analysed again in the editor)
  const run = voice([60, 62, 64, 65].map((m) => ({ hz: mh(m), dur: 0.125 })));
  const tuned = autotune({ sampleRate: SR, channels: [run] }, { speedMs: 0, flatten: 1 }).clip.channels[0];
  assert.deepEqual(findNotes(trackPitch(tuned, SR)).map((x) => Math.round(x.center)), [60, 62, 64, 65]);
});

test('pitch shifting never clips, works at every length, and high tones take the clean path', () => {
  const v = voice([{ hz: 220, dur: 0.8 }]);
  let pk = 0;
  for (const x of v) pk = Math.max(pk, Math.abs(x));
  const loud = v.map((x) => (x / pk) * 0.89); // normalised to -1 dBFS
  for (const d of [-7, -12, -24]) {
    const out = pitchShiftClip({ sampleRate: SR, channels: [loud] }, 0, loud.length, d).channels[0];
    assert.ok(out.every((x) => Math.abs(x) <= 0.98), `${d} clips`);
  }
  for (const n of [44101, 44105, 5]) {
    const noise = Float32Array.from({ length: n }, (_, i) => (((i * 7919) % 211) / 211 - 0.5) * 0.5);
    assert.equal(applyEdit({ sampleRate: SR, channels: [noise] }, { op: 'pitch_shift', semitones: 24 }).clip.channels[0].length, n);
  }
  // 1.76 kHz up an octave: the strongest frequency of the result is 3.52 kHz
  const x = Float32Array.from({ length: SR / 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 1760 * i) / SR));
  const y = pitchShiftClip({ sampleRate: SR, channels: [x] }, 0, x.length, 12).channels[0];
  const power = (f) => { let re = 0; let im = 0; for (let i = 4410; i < 4410 + 8192; i++) { re += y[i] * Math.cos((2 * Math.PI * f * i) / SR); im += y[i] * Math.sin((2 * Math.PI * f * i) / SR); } return re * re + im * im; };
  assert.ok(power(3520) > 50 * power(1760), 'the tone moved an octave up');
});

/** Legato singing: one continuous tone (no fades between notes) gliding from note to note over `glide` seconds. */
function legato(seq, dur, glide) {
  const N = Math.round(dur * SR);
  const x = new Float32Array(seq.length * N);
  let ph = 0;
  for (let i = 0; i < x.length; i++) {
    const k = Math.floor(i / N);
    const into = (i - k * N) / SR;
    const left = ((k + 1) * N - i) / SR;
    let m = seq[k];
    if (k > 0 && into < glide / 2) m = seq[k] + (seq[k - 1] - seq[k]) * (0.5 - into / glide);
    if (k + 1 < seq.length && left < glide / 2) m = seq[k] + (seq[k + 1] - seq[k]) * (0.5 - left / glide);
    ph += (2 * Math.PI * mh(m)) / SR;
    x[i] = Math.min(1, i / 441, (x.length - i) / 441) * 0.3 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph));
  }
  return x;
}

test('legato notes with sung 20–60 ms transitions are separate notes, and auto-tune keeps them in tune', () => {
  const runs = [[[60, 62, 64, 65, 67, 69, 71, 72], 0.15], [[60, 64, 67, 72, 67, 64, 60], 0.3], [[60, 72, 60], 0.2], [[64, 67], 0.25]];
  for (const [seq, dur] of runs) {
    for (const glide of [0, 0.02, 0.04, 0.06]) {
      const notes = findNotes(trackPitch(legato(seq, dur, glide), SR));
      const what = `${seq.join('-')} × ${dur * 1000} ms, ${glide * 1000} ms glides`;
      assert.deepEqual(notes.map((n) => Math.round(n.center)), seq, what);
      for (const n of notes) assert.ok(Math.abs(n.center - Math.round(n.center)) < 0.08, `${what}: note at ${n.center}`);
    }
  }
  // in-tune legato through the Tight-like setting (fast glide) comes out where it went in
  const seq = [60, 72, 67, 64, 65, 62, 60];
  const r = autotune({ sampleRate: SR, channels: [legato(seq, 0.2, 0.04)] }, { key: 'C', scale: 'major', speedMs: 10 });
  const after = findNotes(trackPitch(r.clip.channels[0], SR));
  assert.deepEqual(after.map((n) => Math.round(n.center)), seq);
  for (const n of after) assert.ok(Math.abs(n.center - Math.round(n.center)) < 0.1, `tuned note at ${n.center}`);
});

test('vibrato in legato phrases stays inside each note; audio that starts or ends on a note is shifted to its edges', () => {
  // continuous phase, 0.7 s notes with 40 ms slides and a 4–5 Hz vibrato of ±0.4–0.5 starting after 0.1 s
  const phrase = (seq, rate, depth) => {
    const N = Math.round(0.7 * SR);
    const x = new Float32Array(seq.length * N);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const k = Math.floor(i / N);
      const into = (i - k * N) / SR;
      const left = ((k + 1) * N - i) / SR;
      let m = seq[k];
      if (k > 0 && into < 0.02) m = seq[k] + (seq[k - 1] - seq[k]) * (0.5 - into / 0.04);
      if (k + 1 < seq.length && left < 0.02) m = seq[k] + (seq[k + 1] - seq[k]) * (0.5 - left / 0.04);
      m += depth * Math.min(1, Math.max(0, (into - 0.1) / 0.15)) * Math.sin(2 * Math.PI * rate * i / SR);
      ph += (2 * Math.PI * mh(m)) / SR;
      x[i] = Math.min(1, i / 441, (x.length - i) / 441) * 0.3 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph));
    }
    return x;
  };
  for (const [rate, depth] of [[4, 0.5], [4.5, 0.5], [5, 0.4]]) {
    for (const seq of [[60, 62, 64, 62, 60], [64, 67, 65, 64]]) {
      assert.deepEqual(findNotes(trackPitch(phrase(seq, rate, depth), SR)).map((n) => Math.round(n.center)), seq, `${seq.join('-')} with ${rate} Hz ±${depth}`);
    }
  }
  // a held note with a regular vibrato is corrected as one note (its swings are not tuned one by one)
  const held = phrase([64], 4, 0.5);
  assert.equal(autotune({ sampleRate: SR, channels: [held] }, { key: 'C', scale: 'major' }).notes.length, 1);
  // a note from the very first sample: shifted from the start (the tracker can't centre its first frames there)
  const x = voice([{ hz: 220, dur: 0.5 }]);
  for (let i = 0; i < 441; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR); // no fade-in
  const y = pitchShiftClip({ sampleRate: SR, channels: [x] }, 0, x.length, 7).channels[0];
  const early = trackPitch(y.slice(0, Math.round(0.06 * SR)), SR, { minHz: 100 }).hz.filter(Boolean);
  assert.ok(early.length && early.every((h) => Math.abs(cents(h, 220 * 2 ** (7 / 12))) < 30), `first 60 ms: ${early.map((h) => h.toFixed(0)).join(' ')}`);
  const tuned = autotune({ sampleRate: SR, channels: [x.map((v, i) => 0.3 * Math.sin((2 * Math.PI * sharp(220, -40) * i) / SR))] }, { speedMs: 0 }).clip.channels[0];
  const start = trackPitch(tuned.slice(0, Math.round(0.06 * SR)), SR, { minHz: 100 }).hz.filter(Boolean);
  assert.ok(start.length && start.every((h) => Math.abs(cents(h, 220)) < 15), `tuned start: ${start.map((h) => h.toFixed(1)).join(' ')}`);
});

test('slowing down holds the edges (a loop stays seamless), rate 1 is exact, and band-limiting never clips', () => {
  const n = 4 * 4410;
  const loop = Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 10 * i) / n) + 0.2 * Math.sin((2 * Math.PI * 30 * i) / n));
  for (const rate of [0.5, 0.75]) {
    const out = speedRange(clipOf(loop), 0, n, rate).channels[0];
    assert.ok(Math.abs(out[out.length - 1] - loop[n - 1]) < 0.01, `rate ${rate}: last ${out[out.length - 1]} vs ${loop[n - 1]}`);
    assert.ok(Math.abs(out[0] - out[out.length - 1]) < 0.02, `rate ${rate}: seam`);
  }
  assert.deepEqual(resampleClip(clipOf(loop), 1).channels[0], loop);
  const square = Float32Array.from({ length: SR }, (_, i) => (Math.floor(i / 50) % 2 ? 1 : -1));
  for (const rate of [0.5, 0.8, 2]) {
    const out = speedRange(clipOf(square), 0, SR, rate).channels[0];
    assert.ok(peakDb({ sampleRate: SR, channels: [out] }) <= 0.001, `rate ${rate} peaks at ${peakDb({ sampleRate: SR, channels: [out] })} dB`);
  }
});

test('a short note is not merged into a neighbour that holds several notes (auto-tune keeps in-tune leaps in tune)', () => {
  // legato with 60 ms slides and a 5.5 Hz ±0.5 vibrato from 50 ms into each note
  const sung = (seq, dur, extra = () => 0) => {
    const N = Math.round(dur * SR);
    const x = new Float32Array(seq.length * N);
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const k = Math.floor(i / N);
      const into = (i - k * N) / SR;
      const left = ((k + 1) * N - i) / SR;
      let m = seq[k] + extra(k, into);
      if (k > 0 && into < 0.03) m = seq[k] + (seq[k - 1] - seq[k]) * (0.5 - into / 0.06);
      if (k + 1 < seq.length && left < 0.03) m = seq[k] + (seq[k + 1] - seq[k]) * (0.5 - left / 0.06);
      m += 0.5 * Math.min(1, Math.max(0, (into - 0.05) / 0.1)) * Math.sin(2 * Math.PI * 5.5 * i / SR);
      ph += (2 * Math.PI * mh(m)) / SR;
      x[i] = Math.min(1, i / 441, (x.length - i) / 441) * 0.3 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph));
    }
    return x;
  };
  const check = (seq, dur, extra) => {
    const x = sung(seq, dur, extra);
    const out = autotune({ sampleRate: SR, channels: [x] }, { key: 'C', scale: 'major' }).clip.channels[0];
    const N = Math.round(dur * SR);
    const before = trackPitch(x, SR);
    const after = trackPitch(out, SR);
    seq.forEach((m, k) => {
      const mid = (t) => median([...t.hz.subarray(Math.round((k * N + 0.06 * SR) / SR / t.hop), Math.round(((k + 1) * N - 0.06 * SR) / SR / t.hop))].filter(Boolean).map(hzToMidi));
      assert.ok(Math.abs(mid(after) - mid(before)) < 0.2, `${seq.join('-')}: note ${k + 1} moved from ${mid(before).toFixed(2)} to ${mid(after).toFixed(2)}`);
    });
  };
  check([60, 72, 60, 72], 0.2);
  check([57, 69, 57, 69], 0.2);
});

test('a short in-tune note after a note with vibrato keeps its own pitch; noteCenter leaves out slides from neighbours', () => {
  // E4 0.6 s with a 5.5 Hz ±0.7 vibrato, then G4 sung in tune for 150–250 ms (20 ms slide)
  for (const g4 of [0.15, 0.2, 0.25]) {
    const n1 = Math.round(0.6 * SR);
    const x = new Float32Array(n1 + Math.round(g4 * SR));
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      let m = i < n1 ? 64 + 0.7 * Math.min(1, Math.max(0, (t - 0.1) / 0.15)) * Math.sin(2 * Math.PI * 5.5 * t) : 67;
      const d = (i - n1) / SR;
      if (Math.abs(d) < 0.01) m = 64 + 3 * (0.5 + d / 0.02);
      ph += (2 * Math.PI * mh(m)) / SR;
      x[i] = Math.min(1, i / 441, (x.length - i) / 441) * 0.3 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph));
    }
    assert.deepEqual(findNotes(trackPitch(x, SR)).map((n) => Math.round(n.center)), [64, 67], `G4 for ${g4} s`);
    const r = autotune({ sampleRate: SR, channels: [x] }, { speedMs: 0 });
    const tail = trackPitch(r.clip.channels[0].slice(n1 + Math.round(0.03 * SR)), SR, { minHz: 100 }).hz.filter(Boolean);
    assert.ok(Math.abs(median(tail.map(hzToMidi)) - 67) < 0.1, `G4 for ${g4} s after robotic auto-tune: ${median(tail.map(hzToMidi))}`);
  }
  // a note's slide from the note before is left out, a free end counts
  const hop = 0.005;
  const hz = Float32Array.from({ length: 60 }, (_, f) => mh(f < 6 ? 60 + f : 66));
  assert.ok(Math.abs(noteCenter({ hz, hop }, 0, 60, { slideIn: true }) - 66) < 1e-6);
  assert.equal(noteCenter({ hz, hop }, 0, 60).toFixed(3), noteCenter({ hz, hop }, 0, 60, { slideIn: false }).toFixed(3));
});
