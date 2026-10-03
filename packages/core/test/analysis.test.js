import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, createLevelMeter, encodeWav, decodeWav } from '../src/index.js';

const SR = 44100;
const make = (seconds, fn, ch = 2) => {
  const n = Math.round(seconds * SR);
  const chans = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) { const v = fn(i / SR, i); for (const c of chans) c[i] = v; }
  return { channels: chans, sampleRate: SR };
};

test('loudness of a -6 dBFS 1 kHz stereo sine is about -6 LUFS', () => {
  const a = analyzeAudio(make(3, (t) => 0.5 * Math.sin(2 * Math.PI * 997 * t)));
  assert.ok(Math.abs(a.lufs - -6) < 0.4, `lufs ${a.lufs}`);
  assert.ok(Math.abs(a.peakDb - -6) < 0.1);
  assert.ok(Math.abs(a.crestDb - 3) < 0.2);
  assert.equal(a.stereo.correlation, 1);
  assert.ok(a.spectrum.bandsPercent.mid > 90);
});

test('pitch detection finds A3 on a 220 Hz tone', () => {
  const a = analyzeAudio(make(1, (t) => 0.6 * Math.sin(2 * Math.PI * 220 * t) * Math.exp(-t * 2), 1));
  assert.equal(a.pitch.note, 'A3');
  assert.ok(Math.abs(a.pitch.cents) < 10);
});

test('tempo of a 120 BPM click track', () => {
  const a = analyzeAudio(make(8, (t) => {
    const ph = (t * 2) % 1; // 2 beats per second
    return ph < 0.02 ? Math.sin(2 * Math.PI * 1000 * t) * (1 - ph / 0.02) : 0;
  }, 1));
  assert.ok(a.tempo, 'tempo detected');
  const bpm = a.tempo.bpm;
  assert.ok(Math.abs(bpm - 120) < 2 || Math.abs(bpm - 60) < 1 || Math.abs(bpm - 240) < 3, `bpm ${bpm}`);
  assert.ok(a.onsets.count >= 14);
});

test('kick-like and hat-like one-shots are recognised', () => {
  const kick = analyzeAudio(make(0.4, (t) => Math.sin(2 * Math.PI * (50 + 150 * Math.exp(-t * 40)) * t) * Math.exp(-t * 8), 1));
  assert.equal(kick.kind, 'one-shot');
  assert.equal(kick.character, 'kick');
  let seed = 7;
  let prev = 0;
  const hat = analyzeAudio(make(0.08, (t) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const w = seed / 0x3fffffff - 1;
    const hp = w - prev; // crude high-pass
    prev = w;
    return 0.5 * hp * Math.exp(-t * 60);
  }, 1));
  assert.match(hat.character, /hat/);
});

test('key detection on an A minor chord loop', () => {
  const notes = [57, 60, 64, 45];
  const a = analyzeAudio(make(4, (t) => notes.reduce((s, m) => s + 0.15 * Math.sin(2 * Math.PI * 440 * 2 ** ((m - 69) / 12) * t), 0)));
  assert.ok(a.key);
  assert.ok(['A minor', 'C major'].includes(`${a.key.key} ${a.key.scale}`), `${a.key.key} ${a.key.scale}`);
});

test('WAV encode/decode roundtrip (16 + 24 bit)', () => {
  const src = make(0.1, (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t));
  for (const bitDepth of [16, 24]) {
    const wav = encodeWav(src.channels, SR, { bitDepth });
    const back = decodeWav(wav);
    assert.equal(back.sampleRate, SR);
    assert.equal(back.channels.length, 2);
    assert.equal(back.bitsPerSample, bitDepth);
    let maxErr = 0;
    for (let i = 0; i < src.channels[0].length; i++) maxErr = Math.max(maxErr, Math.abs(back.channels[0][i] - src.channels[0][i]));
    assert.ok(maxErr < (bitDepth === 16 ? 1e-4 : 1e-6));
  }
  assert.throws(() => decodeWav(new Uint8Array(20)));
});

test('segment loudness for mixdowns', () => {
  const a = analyzeAudio(make(4, (t) => (t < 2 ? 0.1 : 0.5) * Math.sin(2 * Math.PI * 500 * t)), { segmentSeconds: 2 });
  assert.equal(a.loudnessPerSegment.lufs.length, 2);
  assert.ok(a.loudnessPerSegment.lufs[1] - a.loudnessPerSegment.lufs[0] > 12);
});

test('streaming level meter (chunked) agrees with the full analysis', () => {
  // bass + hats-ish noise bursts, panned slightly so width is non-zero
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const n = SR * 6;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const bass = 0.4 * Math.sin(2 * Math.PI * 55 * t) * ((t * 2) % 1 < 0.5 ? 1 : 0.3);
    const hat = (t * 8) % 1 < 0.05 ? 0.15 * rnd() : 0;
    L[i] = bass + hat;
    R[i] = bass + 0.5 * hat;
  }
  const full = analyzeAudio({ channels: [L, R], sampleRate: SR }, { lite: true });
  const meter = createLevelMeter(SR);
  for (let s = 0; s < n; s += 22050) meter.push([L.subarray(s, s + 22050), R.subarray(s, s + 22050)]);
  const m = meter.result();
  assert.ok(Math.abs(m.lufs - full.lufs) < 0.3, `lufs ${m.lufs} vs ${full.lufs}`);
  assert.equal(m.peakDb, full.peakDb);
  assert.ok(Math.abs(m.rmsDb - full.rmsDb) < 0.15);
  assert.ok(Math.abs(m.stereoWidth - full.stereo.width) < 0.02);
  assert.ok(Math.abs(m.bandsPercent.sub - full.spectrum.bandsPercent.sub) < 8, `${m.bandsPercent.sub} vs ${full.spectrum.bandsPercent.sub}`);
  assert.ok(m.bandsPercent.sub > 50);
  assert.ok(Math.abs(m.duration - 6) < 0.01);
});

test('level meter on silence and on tiny chunks', () => {
  const meter = createLevelMeter(SR);
  for (let i = 0; i < 20; i++) meter.push([new Float32Array(128), new Float32Array(128)]);
  const m = meter.result();
  assert.equal(m.lufs, -200);
  assert.equal(m.centroidHz, 0);
  assert.equal(createLevelMeter(SR).result().lufs, -200);
});

test('NaN samples are flagged, not fatal; one-sided stereo reports balance', () => {
  const L = new Float32Array(SR);
  for (let i = 0; i < SR; i++) L[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const R = new Float32Array(SR);
  const a = analyzeAudio({ channels: [L, R], sampleRate: SR });
  assert.equal(a.stereo.correlation, 0);
  assert.equal(a.stereo.balanceDb, 60);
  L[100] = NaN;
  const b = analyzeAudio({ channels: [L, R], sampleRate: SR });
  assert.equal(b.invalidSamples, 1);
  assert.ok(b.lufs > -20, `lufs ${b.lufs}`);
  assert.match(b.summary, /invalid/);
});

test('short audio loudness is not biased by the partial last block', () => {
  const n = Math.round(SR * 0.15);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 997 * i) / SR);
  const a = analyzeAudio({ channels: [x, x], sampleRate: SR });
  assert.ok(Math.abs(a.lufs - -6) < 0.6, `lufs ${a.lufs}`);
});

test('true peak catches inter-sample overs; low-end peak, width and loudness range', async () => {
  const { analyzeAudio, createLevelMeter, envelopeTimes } = await import('../src/index.js');
  const n = SR * 4;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = 0.9 * Math.sin(2 * Math.PI * (SR / 4) * (i / SR) + Math.PI / 4); // samples miss the crest by 3 dB
    R[i] = 0.5 * Math.sin(2 * Math.PI * 55 * (i / SR));
  }
  const a = analyzeAudio({ channels: [L, R], sampleRate: SR });
  assert.ok(a.peakDb < -3.5 && a.truePeakDb > -1.3, `${a.peakDb} / ${a.truePeakDb}`);
  assert.ok(Math.abs(a.spectrum.lowPeakHz - 55) <= 3, String(a.spectrum.lowPeakHz));
  assert.match(a.spectrum.lowPeakNote, /^A1/);
  assert.equal(a.stereo.lowWidth, 1); // the 55 Hz is only on one side
  const m = createLevelMeter(SR, { truePeak: true });
  for (let i = 0; i < n; i += 4096) m.push([L.subarray(i, i + 4096), R.subarray(i, i + 4096)]);
  const r = m.result();
  assert.ok(Math.abs(r.truePeakDb - a.truePeakDb) < 0.2);
  assert.equal(r.lowWidth, 1);
  // loudness range: 5 s quiet then 5 s loud ≈ 20 dB apart
  const lr = make(10, (t) => (t < 5 ? 0.05 : 0.5) * Math.sin(2 * Math.PI * 440 * t));
  const ra = analyzeAudio(lr);
  assert.ok(ra.loudnessRangeLu > 15, String(ra.loudnessRangeLu));
  // envelope of a decaying hit
  const hit = make(1, (t) => Math.exp(-t * 20) * Math.sin(2 * Math.PI * 200 * t));
  const e = envelopeTimes(hit);
  assert.ok(e.attackMs <= 10);
  assert.ok(e.decay20Ms > 80 && e.decay20Ms < 160, String(e.decay20Ms)); // -20 dB at ln(10)/20 s ≈ 115 ms
});

test('16-bit WAV is dithered (reproducibly), 24-bit and dither:false are exact', async () => {
  const { encodeWav, decodeWav } = await import('../src/index.js');
  const quiet = new Float32Array(2000).fill(0.2 / 32768); // a fifth of an LSB: truncation would make it silence
  const a = encodeWav([quiet], SR);
  assert.deepEqual(a, encodeWav([quiet], SR));
  const back = decodeWav(a).channels[0];
  assert.ok(back.some((x) => x !== 0), 'dither keeps very quiet signals alive');
  assert.ok(decodeWav(encodeWav([quiet], SR, { dither: false })).channels[0].every((x) => x === 0));
  assert.throws(() => encodeWav([quiet], SR, { bitDepth: 8 }), /16 or 24/);
});
