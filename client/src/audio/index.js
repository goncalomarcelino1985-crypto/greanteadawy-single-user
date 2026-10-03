// Realtime engine singleton. Browsers only allow audio after a user gesture,
// so the AudioContext is created lazily by ensureEngine() (called from click/key handlers).
import { AudioEngine } from './engine.js';

let engine = null;
const listeners = new Set();

export function getEngine() {
  return engine;
}

export function onEngineReady(fn) {
  listeners.add(fn);
  if (engine) fn(engine);
  return () => listeners.delete(fn);
}

export async function ensureEngine() {
  if (!engine) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    engine = new AudioEngine(ctx);
    for (const fn of listeners) fn(engine);
  }
  if (engine.ctx.state === 'suspended') {
    try { await engine.ctx.resume(); } catch { /* needs a gesture */ }
  }
  return engine;
}

