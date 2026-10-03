// Regenerates the Kalimba example's samples (modal synthesis of a metal tine): node make-samples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWav } from '@greanteadawy/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100;
const tine = (key) => {
  const f = 440 * Math.pow(2, (key - 69) / 12);
  const seconds = Math.min(3, 1.4 + (72 - key) * 0.05);
  const n = Math.round(SR * seconds);
  const x = new Float32Array(n);
  // a tine's modes: the fundamental, a strong inharmonic overtone (~5.9×) and a faint high one (~14×)
  const modes = [[1, 1, seconds * 0.5], [5.93, 0.25, 0.25], [14.1, 0.08, 0.06], [2, 0.06, 0.4]];
  for (const [r, a, tau] of modes) {
    if (f * r > SR * 0.45) continue;
    for (let i = 0; i < n; i++) x[i] += a * Math.sin((2 * Math.PI * f * r * i) / SR) * Math.exp(-i / SR / tau);
  }
  // thumb "click" and fades
  for (let i = 0; i < 200; i++) x[i] *= i / 200;
  for (let i = 0; i < 2000; i++) x[n - 1 - i] *= i / 2000;
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  for (let i = 0; i < n; i++) x[i] *= 0.7 / m;
  return x;
};
for (const [name, key] of [['c4', 60], ['g4', 67], ['c5', 72], ['c6', 84]]) {
  fs.writeFileSync(path.join(here, 'samples', `${name}.wav`), encodeWav([tine(key)], SR, { bitDepth: 16, seed: key }));
}
console.log('kalimba samples written');
