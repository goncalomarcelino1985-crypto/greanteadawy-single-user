// Physical-model note renderers (piano, guitar, bass, pizzicato and the world strings) are pure JS: check level, tuning,
// timbre and caching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudio, instrumentDefaults } from '@greanteadawy/core';
import { renderModel, modelOf, modelNote, layerOf, LAYERS, cachePut, cacheGet, noteCacheKey, pinNotes } from '../src/audio/models.js';

const SR = 44100;
const specFor = (kind, params = {}) => modelOf(kind, { ...instrumentDefaults(kind), ...params });
const db = (x) => 20 * Math.log10(x);

function stats(x) {
  let peak = 0;
  let s = 0;
  let bad = 0;
  const n = Math.round(SR * 0.3);
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) bad++;
    peak = Math.max(peak, Math.abs(x[i]));
    if (i < n) s += x[i] * x[i];
  }
  return { peak, attackRms: Math.sqrt(s / n), bad, last: Math.abs(x[x.length - 1]) };
}

const CASES = [
  ['piano', {}, [24, 48, 60, 72, 84, 96, 108], 15],
  ['guitar', {}, [40, 52, 64, 76], 6],
  ['guitar', { body: 'nylon' }, [45, 60], 6],
  ['guitar', { body: 'electric', mute: 0.8 }, [40, 64], 8],
  ['bass', {}, [28, 36, 48], 6],
  ['bass', { style: 'slap' }, [33, 40], 6],
  ['bass', { style: 'upright' }, [31, 43], 6],
  ['strings', { articulation: 'pizzicato' }, [43, 60, 79], 8],
  // world strings
  ['sitar', {}, [48, 60, 72], 6],
  ['sitar', { jawari: 1, sympathetic: 1, sa: 'D' }, [55, 67], 8],
  ['tanpura', {}, [48, 55], 6],
  ['santoor', {}, [60, 72, 84], 6],
  ['santoor', { hardness: 0, shimmer: 1 }, [67], 8],
  ['koto', {}, [50, 62, 74], 6],
  ['guzheng', {}, [55, 67, 79], 6],
  ['pipa', {}, [52, 64, 76], 6],
  ['shamisen', {}, [45, 57, 69], 6],
  ['shamisen', { thwack: 1, sawari: 1 }, [50], 8]
];

test('model notes: finite, levelled by their attack, in tune, ending at silence', () => {
  for (const [kind, params, keys, centsTol] of CASES) {
    const spec = specFor(kind, params);
    for (const key of keys) {
      const x = renderModel(spec.model, SR, key, 2, spec.p);
      const s = stats(x);
      const label = `${kind} ${JSON.stringify(params)} key ${key}`;
      assert.equal(s.bad, 0, `${label}: NaN/Infinity`);
      assert.ok(s.peak <= 0.95, `${label}: peak ${s.peak}`);
      // -18 dB over the first 300 ms, a little less when the soft limiter had to round off a spiky transient
      const attack = db(s.attackRms);
      assert.ok(attack < -16.5 && (attack > -19.5 || (s.peak > 0.75 && attack > -23)), `${label}: attack ${attack.toFixed(1)} dB`);
      assert.ok(s.last < 1e-3, `${label}: ends mid-waveform`);
      if (key <= 84) { // above C6 a real piano is stretch-tuned sharp too: pitch trackers hear the inharmonic partials
        const a = analyzeAudio({ channels: [x.subarray(0, Math.min(x.length, SR * 2))], sampleRate: SR });
        assert.ok(a.pitch, `${label}: no pitch`);
        assert.equal(a.pitch.midi, key, `${label}: heard ${a.pitch.note}`);
        assert.ok(Math.abs(a.pitch.cents) <= centsTol, `${label}: ${a.pitch.cents} cents`);
      }
    }
  }
});

test('model notes: harder velocity layers are brighter', () => {
  for (const [kind, key] of [['piano', 60], ['guitar', 52], ['bass', 36]]) {
    const spec = specFor(kind);
    const centroids = [0, LAYERS - 1].map((layer) => analyzeAudio({ channels: [renderModel(spec.model, SR, key, layer, spec.p).subarray(0, SR / 2)], sampleRate: SR, lite: true }).spectrum.centroidHz);
    assert.ok(centroids[1] > centroids[0] * 1.15, `${kind}: ${centroids}`);
  }
  assert.equal(layerOf(0), 0);
  assert.equal(layerOf(0.8), 3);
  assert.equal(layerOf(1), LAYERS - 1);
});

test('model specs: only note-shaping params key the cache; non-model articulations have none', () => {
  const a = specFor('piano', { gain: 0.3, release: 1, stereo: 0 });
  const b = specFor('piano', { gain: 1.5 });
  assert.equal(a.id, b.id); // gain/release/stereo are applied live
  assert.notEqual(specFor('piano', { brightness: 0.1 }).id, a.id);
  assert.equal(specFor('strings', { articulation: 'legato' }), null);
  assert.equal(specFor('strings', { articulation: 'pizzicato' }).model, 'pizzicato');
  assert.equal(modelOf('synth', instrumentDefaults('synth')), null);
});

test('model cache: same note is rendered once; least recently used notes are evicted past the budget', () => {
  const spec = specFor('bass', { brightness: 0.123 });
  const first = modelNote(spec, SR, 40, 1);
  assert.equal(modelNote(spec, SR, 40, 1), first);
  assert.notEqual(modelNote(spec, SR, 40, 2), first);
  // fill the cache with large fake entries: the old note must go, the fresh ones stay
  const key = noteCacheKey(spec, SR, 40, 1);
  const pinnedKey = noteCacheKey(spec, SR, 40, 2);
  pinNotes([pinnedKey]); // a note the open project plays
  for (let i = 0; i < 5; i++) cachePut(`fake|${i}`, { length: 10_000_000 });
  assert.ok(cacheGet(key) === undefined, 'the least recently used note was evicted'); // (no deep diff of audio)
  assert.ok(cacheGet(pinnedKey) !== undefined, "the project's notes are spared while others can go");
  assert.ok(cacheGet('fake|4'));
  pinNotes([]);
});

/** Brightness of a stretch of audio: the spectral centroid from analyzeAudio (lite). */
const centroid = (x, from, to) => analyzeAudio({ channels: [x.subarray(Math.round(from * SR), Math.round(to * SR))], sampleRate: SR, lite: true }).spectrum.centroidHz;
const rms = (x, from, to) => {
  let s = 0;
  const a = Math.round(from * SR);
  const b = Math.min(x.length, Math.round(to * SR));
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};

test('world strings: the jawari keeps a sitar and tanpura buzzing through the note, not just on the pluck', () => {
  for (const [kind, key] of [['sitar', 60], ['tanpura', 48]]) {
    const plain = specFor(kind, { jawari: 0 });
    const buzz = specFor(kind);
    const a = renderModel(plain.model, SR, key, 2, plain.p);
    const b = renderModel(buzz.model, SR, key, 2, buzz.p);
    const late = [centroid(a, 1, 1.5), centroid(b, 1, 1.5)];
    assert.ok(late[1] > late[0] * 1.4, `${kind}: centroid a second in ${late}`);
  }
});

test('world strings: high notes ring as long as asked (the loop filters\' loss is compensated)', () => {
  for (const [kind, key] of [['santoor', 84], ['guzheng', 79], ['koto', 74]]) {
    const spec = specFor(kind);
    const x = renderModel(spec.model, SR, key, 2, spec.p);
    const drop = db(rms(x, 1, 1.25) / rms(x, 0.05, 0.3));
    assert.ok(drop > -40, `${kind} key ${key}: ${drop.toFixed(1)} dB a second in`);
  }
});

test('world strings: even the top of the range rings (C7–C8 are still ringing a quarter second in) and stays in tune', () => {
  for (const [kind, key] of [['santoor', 96], ['santoor', 108], ['koto', 108], ['guzheng', 104], ['sitar', 108], ['pipa', 100]]) {
    const spec = specFor(kind);
    const x = renderModel(spec.model, SR, key, 2, spec.p);
    const drop = db(rms(x, 0.2, 0.3) / rms(x, 0.02, 0.1));
    assert.ok(drop > -35, `${kind} key ${key}: ${drop.toFixed(1)} dB at 0.25 s`);
    // tuning by the DFT peak near the fundamental (pitch trackers struggle this high)
    const f0 = 440 * Math.pow(2, (key - 69) / 12);
    const n = 8192;
    const from = Math.round(SR * 0.05);
    let best = 0;
    let bestCents = 0;
    for (let c = -50; c <= 50; c++) {
      const hz = f0 * Math.pow(2, c / 1200);
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
        const ph = (2 * Math.PI * hz * i) / SR;
        re += x[from + i] * w * Math.cos(ph);
        im += x[from + i] * w * Math.sin(ph);
      }
      const m = Math.hypot(re, im);
      if (m > best) { best = m; bestCents = c; }
    }
    assert.ok(Math.abs(bestCents) <= 2, `${kind} key ${key}: ${bestCents} cents`);
  }
});

test('sitar: sympathetic strings ring for notes of the Sa scale, not for others', () => {
  const tail = (key, sympathetic) => {
    const spec = specFor('sitar', { sympathetic, sa: 'C' });
    const x = renderModel(spec.model, SR, key, 2, spec.p);
    return rms(x, 2.5, 3.5);
  };
  const inScale = tail(64, 1) / tail(64, 0); // E: a taraf string of C major
  const outside = tail(63, 1) / tail(63, 0); // D#: none
  assert.ok(inScale > outside * 1.5, `E ${inScale.toFixed(2)} vs D# ${outside.toFixed(2)}`);
});

test('model specs for the world strings: live params (gain, release, mono, glide) don\'t key the cache', () => {
  for (const kind of ['sitar', 'tanpura', 'santoor', 'koto', 'guzheng', 'pipa', 'shamisen']) {
    const a = specFor(kind, { gain: 0.2, release: 1 });
    assert.equal(a.model, kind);
    assert.equal(a.id, specFor(kind, { gain: 1.9, release: 0.05 }).id);
    assert.ok(!('mono' in a.p) && !('glide' in a.p) && !('gain' in a.p));
  }
  assert.notEqual(specFor('sitar', { sa: 'D' }).id, specFor('sitar').id);
});
