// Pure DSP helpers of the browser audio engine that can run in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressorAutoMakeupDb, shaperCurve, FLAT_Q } from '../src/audio/dsp.js';

test('compressor auto-makeup matches the Web Audio / Chromium algorithm', () => {
  // reference values measured on a real DynamicsCompressorNode (static gain of a quiet sine below threshold)
  assert.ok(Math.abs(compressorAutoMakeupDb(-18, 6, 4) - 6.95) < 0.05);
  assert.ok(Math.abs(compressorAutoMakeupDb(-60, 40, 20) - 19.08) < 0.05);
  assert.ok(Math.abs(compressorAutoMakeupDb(0, 0, 20)) < 0.01); // threshold at 0 dBFS: nothing to make up
  assert.ok(Math.abs(compressorAutoMakeupDb(-24, 6, 1)) < 0.05); // ratio 1: (almost) no compression
  for (const t of [-60, -30, -10, 0]) for (const k of [0, 6, 40]) for (const r of [1, 4, 20]) {
    const v = compressorAutoMakeupDb(t, k, r);
    assert.ok(Number.isFinite(v) && v >= -0.05, `${t}/${k}/${r} -> ${v}`);
  }
});

test('the limiter clip curve never exceeds its ceiling and is linear below its knee', () => {
  const c = Math.pow(10, -1 / 20);
  const curve = shaperCurve('clip', c);
  assert.ok(Math.max(...curve.map(Math.abs)) < c * 0.96);
  const mid = curve[Math.round((curve.length - 1) * (0.5 + 0.4 / 2))]; // x = 0.4
  assert.ok(Math.abs(mid - 0.4) < 0.002);
  assert.equal(FLAT_Q, -3.0103);
});
