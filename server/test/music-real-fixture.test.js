// Real, previously separated CC-BY music exercises the audio code. This does NOT
// represent a newly submitted MVSEP job or the user's requested Safe From Harm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEmptyProject, createClip, PPQ } from '@greanteadawy/core';
import { prepareAudio, analyzeTiming, validateStemAlignment, renderArrangement } from '../src/music/audio.js';

const ffmpegPath = process.env.GM_AUDIO_TEST_FFMPEG;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demo-output');
const enabled = process.platform === 'linux' && ffmpegPath;
const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

test('Linux: real licensed music stays aligned and a section reorder changes the exported WAV', { skip: !enabled }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gm-real-fixture-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const mixturePath = path.join(root, 'mixture.wav');
  const sourceHash = await hash(mixturePath);
  const stemPaths = Object.fromEntries(['drums', 'bass', 'vocals', 'other'].map(key => [key, path.join(root, `${key}.wav`)]));
  const aligned = await validateStemAlignment({ mixturePath, stemPaths, ffmpegPath });
  assert.equal(aligned.valid, true);
  assert.equal(aligned.frames, 30 * 44100);
  const timing = await analyzeTiming({ inputPath: mixturePath, drumsPath: stemPaths.drums, ffmpegPath });
  assert.ok(timing.bpm > 50 && timing.bpm < 200);
  assert.ok(timing.confidence >= 0 && timing.confidence <= 1);
  const copy = path.join(temp, 'excerpt.wav');
  const excerpt = await prepareAudio({ inputPath: mixturePath, outputPath: copy, startSeconds: 2, durationSeconds: 8, ffmpegPath });
  assert.equal(excerpt.frames, 8 * 44100);
  const project = createEmptyProject({ bpm: timing.bpm, tracks: 4, inserts: 0 });
  project.mixer[0].effects = [];
  const ticks = Math.round(4 * project.bpm * PPQ / 60);
  for (let track = 0; track < 4; track++) for (let block = 0; block < 2; block++) project.playlist.clips.push(createClip({
    kind: 'audio', refId: Object.keys(stemPaths)[track], track, start: block * ticks, offset: block * ticks, length: ticks
  }));
  const samples = new Map(Object.entries(stemPaths));
  const before = await renderArrangement({ project, samples, outputPath: path.join(temp, 'before.wav'), ffmpegPath });
  for (const clip of project.playlist.clips) clip.offset = clip.offset === 0 ? ticks : 0;
  const after = await renderArrangement({ project, samples, outputPath: path.join(temp, 'after.wav'), ffmpegPath });
  assert.equal(before.frames, after.frames);
  assert.ok(after.rms > 0.0001);
  assert.ok(after.peak <= 1);
  assert.notEqual(await hash(before.path), await hash(after.path));
  assert.equal(await hash(mixturePath), sourceHash);
});
