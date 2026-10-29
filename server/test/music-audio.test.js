import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { encodeWav, decodeWav, createEmptyProject, createClip } from '@greanteadawy/core';
import { inspectWav, estimatePulseTiming, planArrangement, prepareAudio, analyzeTiming, validateStemAlignment, renderArrangement } from '../src/music/audio.js';

async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gm-audio-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function project(clips) {
  const p = createEmptyProject({ bpm: 120 });
  p.mixer[0].effects = [];
  p.playlist.clips = clips;
  return p;
}
const clip = (fields = {}) => createClip({ kind: 'audio', refId: 'source', start: 0, length: 192, track: 0, ...fields });
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

test('WAV inspection counts exact frames without decoding or trusting a rounded duration', async (t) => {
  const dir = await temp(t), file = path.join(dir, 'odd.wav');
  const wav = encodeWav([new Float32Array(137), new Float32Array(137)], 44100, { bitDepth: 24 });
  await fs.writeFile(file, wav);
  const facts = await inspectWav(file);
  assert.equal(facts.frames, 137);
  assert.equal(facts.sampleRate, 44100);
  assert.equal(facts.bitsPerSample, 24);
  assert.equal(facts.channels, 2);
  assert.equal(facts.durationSeconds, 137 / 44100);
});

test('WAV inspection rejects truncated files and invalid frame alignment', async (t) => {
  const dir = await temp(t), file = path.join(dir, 'bad.wav');
  const wav = Buffer.from(encodeWav([new Float32Array(2), new Float32Array(2)], 44100));
  await fs.writeFile(file, wav.subarray(0, wav.length - 1));
  await assert.rejects(inspectWav(file), /truncado/);
  wav.writeUInt16LE(3, 32);
  await fs.writeFile(file, wav);
  await assert.rejects(inspectWav(file), /Codificação/);
});

test('arrangement plan preserves source offsets and gaps for a true section reorder', () => {
  const p = project([
    clip({ id: 'second-first', start: 0, offset: 768, length: 768 }),
    clip({ id: 'first-second', start: 768, offset: 0, length: 768 }),
    clip({ start: 1536, offset: 1536, length: 384, mute: true })
  ]);
  const before = JSON.stringify(p);
  const plan = planArrangement(p);
  assert.equal(plan.clips[0].offsetFrame, 176400);
  assert.equal(plan.clips[1].startFrame, 176400);
  assert.equal(plan.clips[1].offsetFrame, 0);
  assert.equal(plan.frames, 441000);
  assert.equal(plan.clips.length, 2);
  assert.equal(JSON.stringify(p), before);
});

test('arrangement refuses unsupported musical state instead of silently omitting it', () => {
  const p = project([clip()]);
  p.playlist.clips.push(createClip({ kind: 'pattern', refId: 'piano', start: 0, length: 192 }));
  assert.throws(() => planArrangement(p), /MIDI/);
  p.playlist.clips.pop();
  p.playlist.clips[0].rate = 1.01;
  assert.throws(() => planArrangement(p), /velocidade/);
  p.playlist.clips[0].rate = 1;
  p.mixer[0].effects = [{ kind: 'reverb', enabled: true }];
  assert.throws(() => planArrangement(p), /efeitos/);
  p.mixer[0].effects = [];
  p.playlist.clips[0].offset = NaN;
  assert.throws(() => planArrangement(p), /Offset/);
});

test('track mutes and fades retain a common export timeline', () => {
  const p = project([clip({ track: 0, length: 768, fadeIn: 384, fadeOut: 768 }), clip({ track: 1, start: 768, length: 768 })]);
  p.playlist.tracks[1].mute = true;
  const plan = planArrangement(p);
  assert.equal(plan.durationSeconds, 8);
  assert.equal(plan.clips.length, 1);
  assert.equal(plan.clips[0].fadeInFrames, 88200);
  assert.equal(plan.clips[0].fadeOutFrames, 88200);
});

test('tempo reports a measured pulse and uncertainty, never a confirmed musical downbeat', () => {
  // Unit-test impulses are not demonstration audio or a source-separation test.
  const rate = 1000, audio = new Float32Array(rate * 12);
  for (let time = 0.17; time < 12; time += 60 / 127) {
    const start = Math.round(time * rate);
    for (let i = 0; i < 18 && start + i < audio.length; i++) audio[start + i] = Math.exp(-i / 5);
  }
  const timing = estimatePulseTiming(audio, rate, { bpm: 127, confidence: 0.8 });
  assert.ok(Math.abs(timing.bpm - 127) < 0.2, JSON.stringify(timing));
  assert.ok(timing.confidence > 0.2 && timing.confidence <= 1);
  assert.ok(Math.abs(timing.beatPhaseSeconds - 0.17) < 0.015);
  assert.equal(timing.musicalDownbeatConfirmed, false);
  assert.equal(timing.halfDoubleTimeAmbiguous, true);
  assert.ok(timing.fittedBeats > 15);
  const silence = estimatePulseTiming(new Float32Array(5000), rate);
  assert.equal(silence.bpm, null);
  assert.equal(silence.confidence, 0);
});

test('heavy audio functions are explicitly unavailable on macOS', { skip: process.platform === 'linux' }, async () => {
  for (const [fn, args] of [[prepareAudio, {}], [analyzeTiming, {}], [validateStemAlignment, {}], [renderArrangement, {}]]) {
    await assert.rejects(fn(args), /cloud Linux/);
  }
});

const ffmpegPath = process.env.GM_AUDIO_TEST_FFMPEG;
const cloudTest = { skip: process.platform !== 'linux' || !ffmpegPath };

test('Linux FFmpeg preserves source bytes, reconstructs reordered clips and exports exact frames', cloudTest, async (t) => {
  const dir = await temp(t), input = path.join(dir, 'input.wav'), working = path.join(dir, 'working.wav');
  const a = new Float32Array(44100 * 2);
  for (let i = 0; i < a.length; i++) a[i] = Math.sin(i * 0.1) * (i < 44100 ? 0.1 : 0.4);
  const source = encodeWav([a, a], 44100, { dither: false });
  await fs.writeFile(input, source);
  await prepareAudio({ inputPath: input, outputPath: working, durationSeconds: 2, ffmpegPath });
  assert.equal(hash(await fs.readFile(input)), hash(source));
  await assert.rejects(prepareAudio({ inputPath: input, outputPath: input, durationSeconds: 2, ffmpegPath }), /original/);
  const output = path.join(dir, 'edited.wav');
  const p = project([clip({ start: 0, offset: 192, length: 192 }), clip({ start: 192, offset: 0, length: 192 })]);
  const result = await renderArrangement({ project: p, samples: new Map([['source', working]]), outputPath: output, ffmpegPath });
  assert.equal(result.frames, 88200);
  assert.equal(result.outputGain, 1);
  const rendered = decodeWav(await fs.readFile(output));
  const rms = (start) => Math.sqrt(rendered.channels[0].slice(start, start + 6000).reduce((sum, value) => sum + value * value, 0) / 6000);
  assert.ok(rms(10000) > rms(54100) * 3.5);
  assert.equal(hash(await fs.readFile(input)), hash(source));
  await assert.rejects(renderArrangement({ project: p, samples: new Map([['source', working]]), outputPath: output, ffmpegPath }), (error) => error.code === 'MUSIC_OUTPUT_EXISTS');
});

test('Linux alignment catches unequal frames and timing shifts, does not auto-correct them', cloudTest, async (t) => {
  const dir = await temp(t), mixturePath = path.join(dir, 'mix.wav'), stemPaths = [];
  const signal = new Float32Array(44100 * 2);
  let state = 789;
  for (let i = 0; i < signal.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; signal[i] = (state / 0x100000000 - 0.5) * 0.4; }
  await fs.writeFile(mixturePath, encodeWav([signal, signal], 44100, { dither: false }));
  for (let n = 0; n < 4; n++) {
    const file = path.join(dir, `stem-${n}.wav`), stem = signal.map((v) => v / 4);
    await fs.writeFile(file, encodeWav([stem, stem], 44100, { dither: false })); stemPaths.push(file);
  }
  const valid = await validateStemAlignment({ mixturePath, stemPaths, ffmpegPath });
  assert.equal(valid.valid, true);
  assert.equal(valid.correctionApplied, false);
  for (const file of stemPaths) {
    const shifted = signal.map((_, i) => i < 529 ? 0 : signal[i - 529] / 4);
    await fs.writeFile(file, encodeWav([shifted, shifted], 44100, { dither: false }));
  }
  await assert.rejects(validateStemAlignment({ mixturePath, stemPaths, ffmpegPath }), (error) => error.alignment && error.alignment.commonLagSeconds > 0.01);
  await fs.writeFile(stemPaths[0], encodeWav([signal.subarray(0, 100), signal.subarray(0, 100)], 44100));
  await assert.rejects(validateStemAlignment({ mixturePath, stemPaths, ffmpegPath }), /mesmos frames/);
});
