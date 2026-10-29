// Per-user sample library: uploaded audio files in <dataDir>/samples with technical metadata
// (codec, bitrate, sample rate, bit depth, channels, duration, tags) and an audio analysis
// (loudness, peak, spectrum, pitch, tempo, key, character) that Claude can use to pick and tune sounds.
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { parseBuffer } from 'music-metadata';
import { uid } from '@greanteadawy/core';
import { httpError } from './errors.js';
import { writeFileAtomic } from './fsutil.js';

const ALLOWED = {
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/vnd.wave': '.wav',
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3',
  'audio/ogg': '.ogg', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
  'audio/aac': '.aac', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/webm': '.webm',
  'audio/aiff': '.aiff', 'audio/x-aiff': '.aiff', 'audio/opus': '.opus'
};
const EXTS = new Set([...Object.values(ALLOWED), '.aif']);
// The served Content-Type is derived from the validated extension, never from the uploader
const MIME_BY_EXT = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.m4a': 'audio/mp4', '.webm': 'audio/webm', '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.opus': 'audio/ogg'
};
const MAX_ANALYSIS_BYTES = 64 * 1024;

const MAX_FOLDERS = 200;
const MAX_FOLDER_NAME = 40;
const MAX_BULK = 500;

const round = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

/** Technical metadata via music-metadata (works for all supported containers). */
export async function readAudioMetadata(buffer, mimeType) {
  try {
    const mm = await parseBuffer(buffer, { mimeType, size: buffer.length }, { duration: true, skipCovers: true });
    const f = mm.format || {};
    const c = mm.common || {};
    const bitrate = f.bitrate || (f.duration ? (buffer.length * 8) / f.duration : null);
    return {
      container: f.container || null,
      codec: f.codec || null,
      codecProfile: f.codecProfile || null,
      lossless: f.lossless ?? null,
      sampleRate: f.sampleRate || null,
      bitsPerSample: f.bitsPerSample || null,
      channels: f.numberOfChannels || null,
      bitrateKbps: bitrate ? Math.round(bitrate / 1000) : null,
      duration: round(f.duration, 3),
      tags: Object.fromEntries(Object.entries({
        title: c.title, artist: c.artist, album: c.album, genre: c.genre?.join(', '), bpm: c.bpm, key: c.key, comment: c.comment?.map((x) => (typeof x === 'string' ? x : x?.text)).filter(Boolean).join(' ')
      }).filter(([, v]) => v !== undefined && v !== null && v !== ''))
    };
  } catch (e) {
    return { error: `Could not read metadata: ${e.message}` };
  }
}

let analysisQueue = Promise.resolve();

/**
 * Decode + analyse a WAV in a worker thread. Resolves { seconds, analysis } or rejects with the decode error.
 * Analyses run one at a time (each can use several times the file size in memory).
 */
export function analyzeWavInWorker(buffer, opts) {
  const run = analysisQueue.catch(() => {}).then(() => runAnalysisWorker(buffer, opts));
  analysisQueue = run;
  return run;
}

function runAnalysisWorker(buffer, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const worker = new Worker(new URL('./analyze-worker.js', import.meta.url), {
      workerData: { bytes }, transferList: [bytes], resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('analysis timed out')); }, timeoutMs);
    worker.once('message', (m) => {
      clearTimeout(timer);
      worker.terminate();
      if (m.ok) resolve(m);
      else reject(new Error(m.error));
    });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
    worker.once('exit', (code) => { clearTimeout(timer); if (code) reject(new Error(`analysis stopped (exit ${code})`)); });
  });
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Characters as people count them (an emoji family or a flag is one). */
export const nameLength = (str) => [...graphemes.segment(str)].length;

// A name holds at least one letter, digit, symbol or punctuation mark; whatever else it holds (combining marks, joiners)
// only decorates those. Names are also capped in UTF-16 units: one "character" can be a long emoji sequence.
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;
const UNITS_PER_CHAR = 8;
const JOINERS = /[\u200c\u200d]/g;
// zero-width (non-)joiners only belong between two visible characters
const tidyJoiners = (s) => s.replace(/[\u200c\u200d]{2,}/g, (m) => m[0]).replace(/(^|\s)[\u200c\u200d]+|[\u200c\u200d]+(?=\s|$)/g, '$1').replace(/ {2,}/g, ' ').trim();

/**
 * A display name made safe: Unicode NFC, no control or invisible format characters (bidi overrides, zero-width
 * spaces; the zero-width joiners that emoji and some scripts need stay, between visible characters), single spaces, no
 * pile-ups of combining marks, at most `max` characters (as people count them) and 8×max UTF-16 units. '' when nothing
 * visible is left.
 */
export function cleanName(name, max) {
  if (typeof name !== 'string') return '';
  const clean = tidyJoiners(name.normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/(?![\u200c\u200d])\p{Cf}/gu, '')
    .replace(/[\s\u3164\u115f\u1160\uffa0\u2800]+/g, ' ') // Hangul fillers and the blank braille cell look like nothing
    // 4 combining marks in a row are enough for any script; thousands only bloat the index
    .replace(/(\p{M}{4})\p{M}+/gu, '$1'));
  if (!VISIBLE.test(clean)) return '';
  if (!Number.isFinite(max) || (clean.length <= max * UNITS_PER_CHAR && nameLength(clean) <= max)) return clean;
  let out = '';
  let n = 0;
  for (const { segment } of graphemes.segment(clean)) {
    if (n >= max || out.length + segment.length > max * UNITS_PER_CHAR) break;
    out += segment;
    n++;
  }
  out = tidyJoiners(out);
  return VISIBLE.test(out) ? out : '';
}

/** How two names are compared for "already exists": joiners and case don't make a different name. */
export const nameKey = (name) => name.replace(JOINERS, '').toLowerCase();

/** Bytes of audio actually present in a WAV's data chunk, and the size of one block (frame) — null if not a RIFF/WAVE. */
export function wavDataInfo(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let blockAlign = 0;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 22 <= buf.length) blockAlign = buf.readUInt16LE(off + 20);
    if (id === 'data') return { dataBytes: Math.min(size, buf.length - off - 8), blockAlign };
    off += 8 + size + (size & 1);
  }
  return { dataBytes: 0, blockAlign };
}

// Headers can claim a length that isn't there (a file cut short after them): these check that a file holds at least one
// frame of audio, for the formats whose headers state a length.

/** Offset after any ID3v2 tags at `off`. */
function skipId3(buf, off = 0) {
  while (off + 10 <= buf.length && buf.toString('latin1', off, off + 3) === 'ID3') {
    const size = ((buf[off + 6] & 0x7f) << 21) | ((buf[off + 7] & 0x7f) << 14) | ((buf[off + 8] & 0x7f) << 7) | (buf[off + 9] & 0x7f);
    off += 10 + size + (buf[off + 5] & 0x10 ? 10 : 0);
  }
  return off;
}

/** FLAC: an audio frame (a frame header with a valid CRC, and data after it) after the metadata blocks. */
function flacHasFrames(buf) {
  let off = skipId3(buf);
  if (off + 4 > buf.length || buf.toString('latin1', off, off + 4) !== 'fLaC') return false;
  off += 4;
  for (;;) {
    if (off + 4 > buf.length) return false;
    const last = buf[off] & 0x80;
    off += 4 + buf.readUIntBE(off + 1, 3);
    if (last) break;
  }
  return flacFrameHeader(buf, off);
}

/** A FLAC frame header at `off` whose CRC-8 checks out (a sync code followed by junk doesn't). */
function flacFrameHeader(buf, off) {
  if (off + 6 > buf.length || buf[off] !== 0xff || (buf[off + 1] & 0xfe) !== 0xf8) return false;
  let end = off + 4;
  // the frame/sample number, UTF-8 style: the leading 1 bits of its first byte say how many bytes follow
  let extra = 0;
  for (let b = buf[end]; b & 0x80 && extra < 7; b <<= 1) extra++;
  end += Math.max(1, extra);
  const bs = buf[off + 2] >> 4;
  const sr = buf[off + 2] & 15;
  end += bs === 6 ? 1 : bs === 7 ? 2 : 0;
  end += sr === 12 ? 1 : sr === 13 || sr === 14 ? 2 : 0;
  if (end + 1 > buf.length) return false;
  let crc = 0;
  for (let i = off; i < end; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  // after the CRC-8: at least a minimal subframe (header + a constant 8-bit value) and the frame's CRC-16
  return crc === buf[end] && end + 5 <= buf.length;
}

const MP3_KBPS = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const MP3_RATES = [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]];

/** Length in bytes of the MPEG audio frame whose header is at `o`, or 0 when there is none. */
function mp3Frame(buf, o) {
  if (o + 4 > buf.length || buf[o] !== 0xff || (buf[o + 1] & 0xe0) !== 0xe0) return 0;
  const ver = (buf[o + 1] >> 3) & 3; // 3 = MPEG 1, 2 = MPEG 2, 0 = MPEG 2.5
  const layer = 4 - ((buf[o + 1] >> 1) & 3); // 1..3 (4 = reserved)
  const bri = buf[o + 2] >> 4;
  const sri = (buf[o + 2] >> 2) & 3;
  const pad = (buf[o + 2] >> 1) & 1;
  if (ver === 1 || layer === 4 || bri === 0 || bri === 15 || sri === 3) return 0;
  const v1 = ver === 3;
  const kbps = MP3_KBPS[`${v1 ? 1 : 2}-${!v1 && layer === 3 ? 2 : layer}`][bri];
  const sr = MP3_RATES[ver][sri];
  if (layer === 1) return (Math.floor((12000 * kbps) / sr) + pad) * 4;
  return Math.floor(((layer === 3 && !v1 ? 72000 : 144000) * kbps) / sr) + pad;
}

/**
 * MP3: a whole audio frame — after the Xing/Info/VBRI frame that only describes the stream, when there is one. With
 * `chained` the frame must also be followed by two more frames of the same stream (same version, layer and sample
 * rate), or the end of the file or a tag: a frame-like pattern in random bytes, a WAV, an Ogg, a zip or a binary isn't.
 * A header that doesn't chain is skipped, not fatal: a file cut mid-frame, or with junk in front, has false syncs
 * before its first real frame.
 */
function mp3HasAudio(buf, { chained = false } = {}) {
  const start = skipId3(buf);
  const limit = Math.min(buf.length - 4, start + 65536);
  for (let o = start; o < limit; o++) {
    const len = mp3Frame(buf, o);
    if (!len || o + len > buf.length) continue;
    const same = (e) => mp3Frame(buf, e) > 0 && (buf[e + 1] & 0xfe) === (buf[o + 1] & 0xfe) && (buf[e + 2] & 0x0c) === (buf[o + 2] & 0x0c);
    const end = (e) => e === buf.length || /^(TAG|APETAGEX|ID3)/.test(buf.toString('latin1', e, e + 8));
    const followed = (e) => !chained || end(e) || (same(e) && (end(e + mp3Frame(buf, e)) || same(e + mp3Frame(buf, e))));
    if (/Xing|Info|VBRI/.test(buf.toString('latin1', o + 4, Math.min(o + len, o + 48)))) {
      const next = mp3Frame(buf, o + len);
      if (next > 0 && o + len + next <= buf.length && followed(o + len + next)) return true;
      continue;
    }
    if (followed(o + len)) return true;
  }
  return false;
}

/** AIFF/AIFC: sample data in the SSND chunk. */
function aiffHasAudio(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'FORM') return false;
  for (let off = 12; off + 8 <= buf.length;) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32BE(off + 4);
    if (id === 'SSND') return Math.min(size, buf.length - off - 8) > 8;
    off += 8 + size + (size & 1);
  }
  return false;
}

/** False when the file can't hold any audio although its header says otherwise (true for formats not checked here). */
function holdsAudio(ext, buf) {
  if (ext === '.flac') return flacHasFrames(buf);
  if (ext === '.mp3') return mp3HasAudio(buf, { chained: true });
  if (ext === '.aiff' || ext === '.aif') return aiffHasAudio(buf);
  return true;
}

/** A de-duplicated list of sample ids from a request (bounded). */
function uniqueIds(ids) {
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'ids must be a non-empty array of sample ids');
  if (ids.length > MAX_BULK) throw httpError(400, `At most ${MAX_BULK} samples at a time`);
  if (ids.some((x) => typeof x !== 'string')) throw httpError(400, 'ids must be sample id strings');
  return [...new Set(ids)];
}

/**
 * Where samples are used in the user's projects: { [sampleId]: [{ projectId, projectName, channels: [names], clips: n }] }.
 * Sampler channels refer to a sample by params.sampleId, audio clips by refId.
 */
export async function sampleUsage(store, ownerId, ids) {
  const want = new Set(ids);
  const out = Object.fromEntries(ids.map((id) => [id, []]));
  for (const meta of await store.list(ownerId)) {
    let p;
    try { p = await store.getOwned(meta.id, ownerId); } catch { continue; }
    const hits = new Map();
    const hit = (id) => {
      if (!hits.has(id)) hits.set(id, { projectId: p.id, projectName: p.name, channels: [], clips: 0 });
      return hits.get(id);
    };
    for (const ch of p.channels || []) {
      const sid = ch.instrument?.kind === 'sampler' ? ch.instrument.params?.sampleId : null;
      if (sid && want.has(sid)) hit(sid).channels.push(ch.name);
    }
    for (const c of p.playlist?.clips || []) if (c.kind === 'audio' && want.has(c.refId)) hit(c.refId).clips++;
    for (const [id, u] of hits) out[id].push(u);
  }
  return out;
}

/** "used in 2 projects (Beat 1: channel Vox, 3 clips; …)" — or '' when unused. */
export function describeUsage(list) {
  if (!list?.length) return '';
  const parts = list.map((u) => `${u.projectName}: ${[u.channels.length ? `channel${u.channels.length > 1 ? 's' : ''} ${u.channels.join(', ')}` : '', u.clips ? `${u.clips} clip${u.clips > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ')}`);
  return `used in ${list.length} project${list.length > 1 ? 's' : ''} (${parts.join('; ')})`;
}

/** Keep client-provided analysis JSON small and plain. */
function sanitizeAnalysis(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw httpError(400, 'analysis must be an object');
  const json = JSON.stringify(a);
  if (json.length > MAX_ANALYSIS_BYTES) throw httpError(413, 'analysis is too large');
  return JSON.parse(json);
}

/**
 * Audio that doesn't state its length is accepted only where that is normal: a browser recording's WebM, a streamed
 * FLAC, a very short MP3 of a frame or two (their frames are checked by holdsAudio). Zero-frame FLAC/M4A/Opus files
 * also state no length, or a negative one.
 */
const unknownLengthOk = (ext) => ext === '.webm' || ext === '.flac' || ext === '.mp3';

export class SampleLibrary extends EventEmitter {
  constructor(dataDir, { cloud = null } = {}) {
    super();
    this.dir = path.join(dataDir, 'samples');
    this.indexPath = path.join(this.dir, 'index.json');
    // folders live in their own file so an older version can still read index.json
    this.foldersPath = path.join(this.dir, 'folders.json');
    this.items = [];
    this.folders = [];
    this.replacing = new Map(); // sample id -> the replacement in progress
    this.writing = Promise.resolve();
    this.cloud = cloud;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    const readJson = async (file) => {
      try {
        const v = JSON.parse(await fs.readFile(file, 'utf8'));
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    };
    this.items = await readJson(this.indexPath);
    this.folders = (await readJson(this.foldersPath)).filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string');
    // a sample whose folder is gone (hand-edited files) is simply unfiled
    const ids = new Set(this.folders.map((f) => f.id));
    for (const s of this.items) if (s.folderId && !ids.has(s.folderId)) s.folderId = null;
    return this;
  }

  save(ownerId) {
    const json = JSON.stringify(this.items, null, 2);
    const folders = JSON.stringify(this.folders, null, 2);
    this.writing = this.writing.catch(() => {}).then(() => Promise.all([writeFileAtomic(this.indexPath, json), writeFileAtomic(this.foldersPath, folders)]));
    this.emit('changed', ownerId);
    return this.writing;
  }

  // ---- folders: each sample is in at most one folder (none = "Unfiled")

  /** One user's folders, A–Z, each with the number of samples in it. */
  listFolders(ownerId) {
    const counts = new Map();
    for (const s of this.list(ownerId)) if (s.folderId) counts.set(s.folderId, (counts.get(s.folderId) || 0) + 1);
    return this.folders
      .filter((f) => f.ownerId === ownerId)
      .map((f) => ({ id: f.id, name: f.name, count: counts.get(f.id) || 0, createdAt: f.createdAt }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  }

  getFolder(id, ownerId) {
    const f = this.folders.find((x) => x.id === id);
    if (!f || f.ownerId !== ownerId) throw httpError(404, `Folder ${id} not found`);
    return f;
  }

  folderName(name, ownerId, exceptId) {
    const raw = typeof name === 'string' ? cleanName(name, Infinity) : '';
    if (!raw) throw httpError(400, 'A folder needs a name (visible characters)');
    if (nameLength(raw) > MAX_FOLDER_NAME) throw httpError(400, `Folder names are at most ${MAX_FOLDER_NAME} characters`);
    if (raw.length > MAX_FOLDER_NAME * UNITS_PER_CHAR) throw httpError(400, 'That folder name is too long (long emoji sequences count as several characters)');
    const key = nameKey(raw);
    if (key === 'unfiled') throw httpError(400, '"Unfiled" is reserved for samples that are not in a folder');
    const dup = this.folders.find((f) => f.ownerId === ownerId && f.id !== exceptId && nameKey(f.name) === key);
    if (dup) throw httpError(409, `There is already a folder called "${dup.name}"`);
    return raw;
  }

  async addFolder(ownerId, name) {
    if (!ownerId) throw new Error('addFolder() needs an ownerId');
    const clean = this.folderName(name, ownerId);
    if (this.folders.filter((f) => f.ownerId === ownerId).length >= MAX_FOLDERS) throw httpError(400, `You can have at most ${MAX_FOLDERS} folders`);
    const folder = { id: uid('fld'), ownerId, name: clean, createdAt: new Date().toISOString() };
    this.folders.push(folder);
    await this.save(ownerId);
    return { ...folder, count: 0 };
  }

  /** Rename a folder; returns it as listFolders shows it. */
  async renameFolder(id, ownerId, name) {
    const f = this.getFolder(id, ownerId);
    f.name = this.folderName(name, ownerId, id);
    await this.save(ownerId);
    return this.listFolders(ownerId).find((x) => x.id === id);
  }

  /** The name of a folder of this user, or null (unfiled, or a folder deleted meanwhile). */
  folderNameOf(folderId, ownerId) {
    return this.folders.find((f) => f.id === folderId && f.ownerId === ownerId)?.name || null;
  }

  /** Delete a folder; its samples are kept and become unfiled. Returns how many samples moved. */
  async removeFolder(id, ownerId) {
    this.getFolder(id, ownerId);
    let moved = 0;
    for (const s of this.items) if (s.ownerId === ownerId && s.folderId === id) { s.folderId = null; moved++; }
    this.folders = this.folders.filter((f) => f.id !== id);
    await this.save(ownerId);
    return moved;
  }

  /** A folder id that is safe to store for this user (null = unfiled); 404 for someone else's folder. */
  checkFolderId(folderId, ownerId) {
    if (folderId === null || folderId === undefined || folderId === '') return null;
    if (typeof folderId !== 'string') throw httpError(400, 'folderId must be a string or null');
    return this.getFolder(folderId, ownerId).id;
  }

  /** Move samples into a folder (null = unfiled). All ids are checked before anything moves. */
  async move(ids, ownerId, folderId) {
    const list = uniqueIds(ids).map((id) => this.get(id, ownerId));
    const fid = this.checkFolderId(folderId, ownerId);
    for (const s of list) s.folderId = fid;
    await this.save(ownerId);
    return list.length;
  }

  /** Samples of one user (ownerId undefined = all). */
  list(ownerId) {
    return ownerId === undefined ? this.items : this.items.filter((s) => s.ownerId === ownerId);
  }

  get(id, ownerId) {
    const s = this.items.find((x) => x.id === id);
    if (!s || (ownerId !== undefined && s.ownerId !== ownerId)) throw httpError(404, `Sample ${id} not found`);
    return s;
  }

  filePath(id, ownerId) {
    return path.join(this.dir, this.get(id, ownerId).file);
  }

  async ensureFile(id, ownerId) {
    const file = this.filePath(id, ownerId);
    if (this.cloud) await this.cloud.ensureFile(file);
    return file;
  }

  mimeOf(id, ownerId) {
    return MIME_BY_EXT[path.extname(this.get(id, ownerId).file).toLowerCase()] || 'application/octet-stream';
  }

  /**
   * Check an uploaded file and read what the server can about it (metadata; full analysis for WAV), then write it.
   * Empty files, "WAVs" that aren't, and audio without a single frame are refused before anything is written — a
   * replacement must never leave a sample silent. (A WAV in an encoding the server can't read, e.g. µ-law, is kept for
   * the browser to decode.)
   */
  async ingest(id, buffer, originalName, mime) {
    let ext = path.extname(originalName || '').toLowerCase();
    if (!EXTS.has(ext)) ext = ALLOWED[mime] || '';
    if (!ext) throw httpError(400, 'Unsupported audio type. Use wav, mp3, ogg, opus, flac, aiff, aac/m4a or webm.');
    if (!buffer?.length) throw httpError(400, 'The file is empty');
    const metadata = await readAudioMetadata(buffer, MIME_BY_EXT[ext]);
    let analysis = null;
    let duration = metadata.duration || null;
    if (ext === '.wav') {
      try {
        const r = await analyzeWavInWorker(buffer);
        duration = round(r.seconds, 3);
        analysis = r.analysis;
      } catch (e) {
        // an encoding only the browser can decode (µ-law, ADPCM…) is fine — if it holds any audio at all (a "fact" chunk
        // can claim a length that the data chunk doesn't have)
        const data = wavDataInfo(buffer);
        const hasAudio = metadata.duration > 0 && data && data.dataBytes >= Math.max(1, data.blockAlign);
        if (!/Unsupported WAV encoding/.test(e.message) || !hasAudio) throw httpError(400, `Not a usable WAV file: ${/Unsupported WAV encoding/.test(e.message) ? 'no audio in it' : e.message}`);
        metadata.decodeError = e.message;
      }
      if (analysis && !(duration > 0)) throw httpError(400, 'The WAV file has no audio in it');
    } else if (metadata.error || !metadata.container || !(metadata.duration > 0 || (metadata.duration == null && unknownLengthOk(ext))) || !holdsAudio(ext, buffer)) {
      throw httpError(400, `Not a playable ${ext.slice(1).toUpperCase()} file`);
    }
    const file = `${id}${ext}`;
    await writeFileAtomic(path.join(this.dir, file), buffer);
    // analysis stays null until analysed (non-WAV files are analysed by the browser after upload)
    return { file, mime: MIME_BY_EXT[ext], size: buffer.length, duration, metadata, analysis };
  }

  async add({ buffer, originalName, mime, ownerId, folderId = null, name }) {
    if (!ownerId) throw new Error('add() needs an ownerId');
    this.checkFolderId(folderId, ownerId);
    const id = uid('smp');
    const facts = await this.ingest(id, buffer, originalName, mime);
    // the folder may have been deleted while the file was analysed: then the sample is unfiled
    const fid = folderId && this.folders.some((f) => f.id === folderId && f.ownerId === ownerId) ? folderId : null;
    const fallback = path.basename(originalName || facts.file, path.extname(originalName || facts.file));
    const item = {
      id,
      ownerId,
      name: cleanName(name, 80) || cleanName(fallback, 80) || id,
      folderId: fid,
      rev: 1,
      ...facts,
      createdAt: new Date().toISOString()
    };
    this.items.unshift(item);
    await this.save(ownerId);
    return item;
  }

  /**
   * Replace a sample's audio (the wave editor's "Replace original"): same id, so every project that uses it plays the
   * new audio. `rev` goes up, which is what clients add to the file URL (the file itself is cached as immutable).
   */
  async replaceFile(id, ownerId, upload) {
    this.get(id, ownerId);
    // one replacement per sample at a time (two with different extensions would orphan a file)
    const prev = this.replacing.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.replaceNow(id, ownerId, upload));
    this.replacing.set(id, run);
    try {
      return await run;
    } finally {
      if (this.replacing.get(id) === run) this.replacing.delete(id);
    }
  }

  async replaceNow(id, ownerId, { buffer, originalName, mime }) {
    const s = this.get(id, ownerId);
    const oldFile = s.file;
    const facts = await this.ingest(id, buffer, originalName, mime);
    if (!this.items.includes(s)) {
      // deleted while the new audio was checked: don't leave its file behind (the delete already took the old one)
      await fs.rm(path.join(this.dir, facts.file), { force: true });
      throw httpError(404, `Sample ${id} not found`);
    }
    Object.assign(s, facts, { rev: (s.rev || 1) + 1, updatedAt: new Date().toISOString() });
    await this.save(ownerId);
    if (oldFile !== s.file) {
      const previous = path.join(this.dir, oldFile);
      await fs.rm(previous, { force: true });
      this.cloud?.forgetFile(previous);
    }
    return s;
  }

  /**
   * Rename, move, or store the browser's analysis. Everything is checked before anything changes. An analysis or
   * duration sent with `rev` is refused (409) when the audio was replaced since the browser loaded it.
   */
  async update(id, ownerId, patch) {
    const s = this.get(id, ownerId);
    const folderId = 'folderId' in patch ? this.checkFolderId(patch.folderId, s.ownerId) : undefined;
    const name = typeof patch.name === 'string' ? cleanName(patch.name, 80) : '';
    if (typeof patch.name === 'string' && !name) throw httpError(400, 'A sample needs a name (visible characters)');
    const audioFacts = patch.analysis !== undefined || patch.duration !== undefined;
    if (audioFacts && patch.rev !== undefined && patch.rev !== (s.rev || 1)) {
      throw httpError(409, 'The sample was replaced while it was being analysed — analyse it again');
    }
    const analysis = patch.analysis === undefined || patch.analysis === null ? patch.analysis : { ...sanitizeAnalysis(patch.analysis), analyzedBy: 'browser', analyzedAt: new Date().toISOString() };
    if (folderId !== undefined) s.folderId = folderId;
    if (name) s.name = name;
    if (Number.isFinite(patch.duration) && patch.duration > 0 && patch.duration < 36000) s.duration = round(patch.duration, 3);
    if (analysis !== undefined) {
      s.analysis = analysis;
      if (!s.duration && Number.isFinite(s.analysis?.duration)) s.duration = s.analysis.duration;
    }
    await this.save(s.ownerId);
    return s;
  }

  // Deletes take the records out first, synchronously: a replacement finishing meanwhile then sees the sample is gone
  // and removes its own new file (replaceNow), instead of the delete removing a file name that no longer applies. The
  // index is saved before the files go, so a file that can't be removed is at worst left over, never still listed.
  async remove(id, ownerId) {
    const s = this.get(id, ownerId);
    this.items = this.items.filter((x) => x !== s);
    await this.save(s.ownerId);
    await this.removeFiles([s]);
  }

  async removeFiles(list) {
    for (const s of list) {
      const file = path.join(this.dir, s.file);
      if (this.cloud) {
        await fs.rm(file, { force: true });
        this.cloud.forgetFile(file);
      } else await fs.rm(file, { force: true }).catch(() => {});
    }
  }

  /** Delete several samples (all ids are checked first, so a bad id deletes nothing). Returns how many went. */
  async removeMany(ids, ownerId) {
    const list = uniqueIds(ids).map((id) => this.get(id, ownerId));
    const gone = new Set(list);
    this.items = this.items.filter((x) => !gone.has(x));
    await this.save(ownerId);
    await this.removeFiles(list);
    return list.length;
  }

  /** Where these samples (all checked to be the user's) are used in the user's projects — see sampleUsage. */
  async usage(store, ids, ownerId) {
    return sampleUsage(store, ownerId, uniqueIds(ids).map((id) => this.get(id, ownerId).id));
  }

  /** Everything of a deleted user: samples (files too) and folders. */
  async removeOwner(ownerId) {
    const list = this.list(ownerId);
    this.items = this.items.filter((x) => x.ownerId !== ownerId);
    this.folders = this.folders.filter((f) => f.ownerId !== ownerId);
    await this.save(ownerId);
    await this.removeFiles(list);
  }

  async claimOrphans(ownerId) {
    let n = 0;
    for (const s of this.items) if (!s.ownerId) { s.ownerId = ownerId; n++; }
    if (n) await this.save(ownerId);
    return n;
  }
}

/** Compact, Claude-friendly view of a sample (folder = its folder's name, or null when unfiled). */
export function describeSample(s, folder = null) {
  const m = s.metadata || {};
  const a = s.analysis;
  return {
    id: s.id,
    name: s.name,
    folder,
    file: { format: m.container || path.extname(s.file).slice(1), codec: m.codec, lossless: m.lossless, sizeKB: Math.round(s.size / 1024) },
    audio: { duration: s.duration, sampleRate: m.sampleRate, bitsPerSample: m.bitsPerSample, channels: m.channels, bitrateKbps: m.bitrateKbps },
    tags: m.tags && Object.keys(m.tags).length ? m.tags : undefined,
    analysis: a || 'not analysed yet (open the studio in a browser or call analyze_sample)'
  };
}
