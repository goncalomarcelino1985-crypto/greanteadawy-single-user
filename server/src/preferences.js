// UI settings belong to the authenticated owner and are metadata in cloud snapshots.
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { writeFileAtomic } from './fsutil.js';
import { httpError, wrap } from './errors.js';

const MAX_BYTES = 64 * 1024;
const WINDOW_NAMES = new Set(['playlist', 'channelRack', 'pianoRoll', 'mixer', 'channelSettings', 'automation', 'help', 'settings', 'versions', 'spatial', 'generate', 'waveEditor', 'recorder']);
const SNAPS = new Set(['none', '1/64', '1/32', 'step', '1/8t', '1/8', 'beat', 'bar']);
const own = (o, k) => Object.hasOwn(o, k);
const object = (o) => o && typeof o === 'object' && !Array.isArray(o);
const bad = (key) => { throw httpError(400, `Invalid preference: ${key}`); };
const bool = (value, key) => typeof value === 'boolean' ? value : bad(key);
const number = (value, min, max, key, integer = false) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)) ? value : bad(key);

/** Reject unknown fields so this endpoint can never change credentials or project state. */
export function validatePreferences(raw) {
  if (!object(raw)) bad('document');
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_BYTES) throw httpError(413, 'Preferences exceed 64 KB');
  const allowed = new Set(['windows', 'snap', 'followClaude', 'metronome', 'browserOpen', 'kbOctave', 'recordQuantize', 'recorderPreferences', 'collapsedSampleFolders']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) bad(key);
  const out = {};
  for (const key of ['followClaude', 'metronome', 'browserOpen', 'recordQuantize']) if (own(raw, key)) out[key] = bool(raw[key], key);
  if (own(raw, 'snap')) out.snap = SNAPS.has(raw.snap) ? raw.snap : bad('snap');
  if (own(raw, 'kbOctave')) out.kbOctave = number(raw.kbOctave, 0, 8, 'kbOctave', true);
  if (own(raw, 'windows')) {
    if (!object(raw.windows)) bad('windows');
    out.windows = {};
    for (const [name, win] of Object.entries(raw.windows)) {
      if (!WINDOW_NAMES.has(name) || !object(win)) bad(`windows.${name}`);
      const clean = {};
      for (const [key, value] of Object.entries(win)) {
        if (['open', 'max'].includes(key)) clean[key] = bool(value, key);
        else if (['x', 'y'].includes(key)) clean[key] = number(value, -100000, 100000, key);
        else if (['w', 'h'].includes(key)) clean[key] = number(value, 1, 100000, key);
        else if (key === 'z') clean[key] = number(value, 0, Number.MAX_SAFE_INTEGER, key, true);
        else bad(`windows.${name}.${key}`);
      }
      out.windows[name] = clean;
    }
  }
  if (own(raw, 'recorderPreferences')) {
    const recorder = raw.recorderPreferences;
    if (!object(recorder)) bad('recorderPreferences');
    out.recorderPreferences = {};
    for (const [key, value] of Object.entries(recorder)) {
      let clean;
      if (['metronome', 'place', 'monitor', 'echo', 'noise', 'agc'].includes(key)) clean = bool(value, key);
      else if (key === 'deviceId') clean = typeof value === 'string' && value.length <= 512 ? value : bad(key);
      else if (key === 'channels') clean = number(value, 1, 2, key, true);
      else if (key === 'countIn') clean = number(value, 0, 2, key, true);
      else if (key === 'offsetMs') clean = number(value, -500, 500, key);
      else if (key === 'along') clean = ['song', 'pattern', 'none'].includes(value) ? value : bad(key);
      else bad(`recorderPreferences.${key}`);
      out.recorderPreferences[key] = clean;
    }
  }
  if (own(raw, 'collapsedSampleFolders')) {
    if (!Array.isArray(raw.collapsedSampleFolders) || raw.collapsedSampleFolders.length > 500 || raw.collapsedSampleFolders.some((id) => typeof id !== 'string' || !/^[\w-]{0,100}$/.test(id))) bad('collapsedSampleFolders');
    out.collapsedSampleFolders = [...new Set(raw.collapsedSampleFolders)];
  }
  return out;
}

export function createPreferencesRouter({ dataDir, auth, transaction = async (fn) => fn() }) {
  const router = express.Router();
  const locks = new Map();
  const fileFor = (userId) => {
    if (!/^[\w-]{1,100}$/.test(userId)) throw httpError(400, 'Invalid owner');
    return path.join(dataDir, 'preferences', `${userId}.json`);
  };
  async function read(userId) {
    let raw;
    try {
      const file = fileFor(userId);
      if ((await fs.stat(file)).size > MAX_BYTES + 1024) throw new Error('Invalid stored preferences size');
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return { revision: 0, preferences: {} };
      throw e;
    }
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error('Invalid stored preferences revision');
    return { revision: raw.revision, preferences: validatePreferences(raw.preferences) };
  }
  router.get('/preferences', auth.requireSession, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(await read(req.user.id));
  }));
  router.put('/preferences', auth.requireSession, express.json({ limit: '64kb' }), wrap(async (req, res) => {
    const { revision, preferences } = req.body || {};
    if (Buffer.byteLength(JSON.stringify(req.body || {})) > MAX_BYTES) throw httpError(413, 'Preferences exceed 64 KB');
    if (!Number.isSafeInteger(revision) || revision < 0) throw httpError(400, 'Preferences revision is required');
    const clean = validatePreferences(preferences);
    const owner = req.user.id;
    const prior = locks.get(owner) || Promise.resolve();
    const run = prior.catch(() => {}).then(() => transaction(async () => {
      const current = await read(owner);
      if (current.revision !== revision) throw httpError(409, 'Preferences changed in another tab. Reload before saving.');
      const document = { revision: revision + 1, preferences: clean };
      const file = fileFor(owner);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await writeFileAtomic(file, JSON.stringify(document), { mode: 0o600 });
      return document;
    }));
    locks.set(owner, run);
    try { res.set('Cache-Control', 'no-store').json(await run); }
    finally { if (locks.get(owner) === run) locks.delete(owner); }
  }));
  return router;
}
