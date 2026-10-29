// Optional ffmpeg integration: converts WAVs rendered in the browser (in a user's exports folder) to MP3, AAC, Ogg
// Vorbis, Opus, FLAC, Apple Lossless or AIFF. ffmpeg is found at FFMPEG_PATH or on the PATH; without it everything
// else keeps working and WAV stays the only export format.
//
// Safety: ffmpeg only ever reads a WAV we wrote and writes a new file next to it. Paths are passed as `file:` URLs
// with a file-only protocol whitelist and forced formats (no probing of playlists or other protocols), arguments are
// an array (no shell), the environment is stripped of secrets, and every run has a timeout and a concurrency limit.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { httpError } from './errors.js';

/**
 * Export formats. `encoders`: ffmpeg encoders that can make it, best first. Lossy formats take a bitrate (kbps);
 * lossless ones keep the WAV's bit depth.
 */
export const EXPORT_FORMATS = {
  wav: { label: 'WAV', ext: 'wav', native: true, lossless: true, description: 'Uncompressed PCM, 16-bit (dithered) or 24-bit — rendered in the browser, no ffmpeg needed' },
  mp3: { label: 'MP3', ext: 'mp3', encoders: ['libmp3lame'], muxer: 'mp3', maxChannels: 2, bitrates: [128, 160, 192, 256, 320], defaultBitrate: 320, description: 'Plays everywhere; lossy (LAME, constant bitrate)' },
  aac: { label: 'AAC (.m4a)', ext: 'm4a', encoders: ['libfdk_aac', 'aac'], muxer: 'ipod', maxChannels: 8, bitrates: [128, 192, 256, 320], defaultBitrate: 256, description: 'Apple/streaming lossy format, better than MP3 at the same bitrate' },
  ogg: { label: 'Ogg Vorbis', ext: 'ogg', encoders: ['libvorbis'], muxer: 'ogg', maxChannels: 6, bitrates: [128, 160, 192, 256, 320], defaultBitrate: 192, description: 'Open lossy format (games, web)' },
  opus: { label: 'Opus', ext: 'opus', encoders: ['libopus'], muxer: 'opus', maxChannels: 8, bitrates: [64, 96, 128, 160, 192, 256], defaultBitrate: 160, description: 'Most efficient lossy format (web, voice/music); 48 kHz' },
  flac: { label: 'FLAC', ext: 'flac', encoders: ['flac'], muxer: 'flac', maxChannels: 8, lossless: true, description: 'Lossless, about half the size of WAV; keeps 16/24-bit' },
  alac: { label: 'Apple Lossless (.m4a)', ext: 'm4a', suffix: '-alac', encoders: ['alac'], muxer: 'ipod', maxChannels: 7, lossless: true, description: 'Lossless for Apple Music/iTunes; keeps 16/24-bit' },
  aiff: { label: 'AIFF', ext: 'aiff', encoders: ['pcm_s24be', 'pcm_s16be'], muxer: 'aiff', lossless: true, description: 'Uncompressed PCM (Logic, Pro Tools, older Macs)' }
};
export const FORMAT_IDS = Object.keys(EXPORT_FORMATS);
export const EXPORT_EXTENSIONS = [...new Set(Object.values(EXPORT_FORMATS).map((f) => f.ext))];

const METADATA_KEYS = ['title', 'artist', 'album', 'genre', 'date', 'comment'];
const MAX_QUEUED_PER_USER = 3;
const SAFE_ENV_KEYS = ['PATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'];

/** Clean metadata: known keys only, single line, no control characters, ≤ 200 characters. */
export function cleanMetadata(meta = {}) {
  const out = {};
  for (const k of METADATA_KEYS) {
    const v = meta?.[k];
    if (v === undefined || v === null || v === '') continue;
    // eslint-disable-next-line no-control-regex
    const s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
    if (s) out[k] = s;
  }
  return out;
}

/** Bit depth and sample rate from a WAV header (RIFF/WAVE, fmt chunk); null when it isn't a PCM/float WAV. */
export async function readWavInfo(file) {
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (bytesRead < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    for (let o = 12; o + 8 <= bytesRead;) {
      const id = head.toString('ascii', o, o + 4);
      const size = head.readUInt32LE(o + 4);
      if (id === 'fmt ' && o + 24 <= bytesRead) {
        // only plain PCM (1) or float (3), also inside WAVE_FORMAT_EXTENSIBLE: anything else (MP3-in-WAV, ADPCM…)
        // would make ffmpeg run a compressed-audio decoder on user data
        let tag = head.readUInt16LE(o + 8);
        const extensible = tag === 0xfffe && o + 34 <= bytesRead;
        if (extensible) tag = head.readUInt16LE(o + 32);
        const bitsPerSample = head.readUInt16LE(o + 22);
        const channels = head.readUInt16LE(o + 10);
        // speaker mask (WAVE_FORMAT_EXTENSIBLE): 0 = channels without speaker positions (ADM / object renders)
        const mask = extensible ? head.readUInt32LE(o + 28) : channels <= 2 ? null : 0;
        const base = { channels, sampleRate: head.readUInt32LE(o + 12), bitsPerSample, mask };
        if (tag === 1 && [8, 16, 24, 32].includes(bitsPerSample)) return { format: 'pcm', ...base };
        if (tag === 3 && [32, 64].includes(bitsPerSample)) return { format: 'float', ...base };
        return null;
      }
      o += 8 + size + (size % 2);
    }
    return null;
  } finally {
    await fh.close();
  }
}

function run(bin, args, { timeoutMs, maxOutput = 1 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k];
    let child;
    try {
      child = spawn(bin, args, { shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { if (out.length < maxOutput) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 8192) err += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error(`ffmpeg took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`), { code: 'ETIMEDOUT' }));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(Object.assign(new Error(err.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with code ${code}`), { code: 'EFFMPEG' }));
    });
  });
}

/**
 * config: { path ('' = "ffmpeg" on the PATH, 'off' = disabled), timeoutSec, maxJobs }
 * Returns { status({ refresh }), formats(), convert({ input, format, bitrate, metadata }) }.
 */
export function createFfmpeg({ path: configured = '', timeoutSec = 300, maxJobs = 2 } = {}) {
  const disabled = /^(off|none|false|0|disabled)$/i.test(configured);
  const bin = configured && !disabled ? configured : 'ffmpeg';
  let cached = null;
  let detecting = null;
  let active = 0;
  const waiting = [];
  const queued = new Map(); // owner → conversions running or waiting

  async function detect() {
    if (disabled) return { available: false, disabled: true, reason: 'Disabled by FFMPEG_PATH=off', encoders: [] };
    try {
      const v = await run(bin, ['-hide_banner', '-version'], { timeoutMs: 10000 });
      const version = /ffmpeg version (\S+)/.exec(v.out)?.[1] || 'unknown';
      const e = await run(bin, ['-hide_banner', '-encoders'], { timeoutMs: 10000 });
      // after the legend and a "------" line: " A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3) (codec mp3)"
      const list = e.out.includes('------') ? e.out.slice(e.out.indexOf('------')) : e.out;
      const encoders = [...list.matchAll(/^\s*A[.\w]{5}\s+([\w-]+)/gm)].map((m) => m[1]);
      return { available: true, version, encoders, source: configured && !disabled ? 'FFMPEG_PATH' : 'PATH' };
    } catch (err) {
      // (no configured path in the message: it is shown to every signed-in user)
      const reason = err.code === 'ENOENT'
        ? (configured ? 'the program FFMPEG_PATH points to was not found' : 'ffmpeg is not installed or not on the PATH')
        : `ffmpeg failed to start (${err.code || 'error'})`;
      return { available: false, reason, encoders: [] };
    }
  }

  async function status({ refresh = false } = {}) {
    if (refresh) cached = null;
    if (!cached) {
      detecting ??= detect().finally(() => { detecting = null; });
      cached = { ...(await detecting), checkedAt: new Date().toISOString() };
    }
    return cached;
  }

  /** Every format with whether it can be made right now (and which encoder would make it). */
  async function formats() {
    const st = await status();
    return FORMAT_IDS.map((id) => {
      const f = EXPORT_FORMATS[id];
      const encoder = f.native ? null : f.encoders.find((x) => st.encoders.includes(x)) || null;
      return {
        id, label: f.label, ext: f.ext, lossless: !!f.lossless, description: f.description,
        available: f.native || (st.available && !!encoder), encoder,
        ...(f.bitrates ? { bitrates: f.bitrates, defaultBitrate: f.defaultBitrate } : {}),
        ...(!f.native && !st.available ? { reason: st.reason } : !f.native && !encoder ? { reason: `this ffmpeg has no ${f.encoders.join('/')} encoder` } : {})
      };
    });
  }

  // at most maxJobs conversions at once; a finished one hands its slot straight to the next in line
  async function slot() {
    if (active < maxJobs) { active++; return; }
    await new Promise((resolve) => waiting.push(resolve));
  }
  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  /**
   * Convert `input` (an absolute path to a WAV in an exports folder) into `format`, written next to it under a fresh
   * name. Returns { name, path, bytes, format, encoder, bitrate?, bitDepth? }.
   */
  async function convert({ owner = null, ...job }) {
    // one user can't fill the queue: counted before anything else happens (no await before this)
    if (owner && (queued.get(owner) || 0) >= MAX_QUEUED_PER_USER) throw httpError(429, 'Too many conversions waiting — try again when the current ones have finished');
    if (owner) queued.set(owner, (queued.get(owner) || 0) + 1);
    try {
      return await convertNow(job);
    } finally {
      if (owner) {
        const n = (queued.get(owner) || 1) - 1;
        if (n > 0) queued.set(owner, n);
        else queued.delete(owner);
      }
    }
  }

  async function convertNow({ input, format, bitrate, metadata = {}, fileExists }) {
    const f = Object.hasOwn(EXPORT_FORMATS, format) ? EXPORT_FORMATS[format] : null;
    if (!f) throw httpError(400, `Unknown format "${format}". Formats: ${FORMAT_IDS.join(', ')}`);
    if (f.native) throw httpError(400, 'WAV is rendered directly — no conversion needed');
    const st = await status();
    if (!st.available) throw httpError(409, `ffmpeg is not available (${st.reason}). Install ffmpeg or set FFMPEG_PATH; WAV export still works.`);
    const encoder = f.encoders.find((x) => st.encoders.includes(x));
    if (!encoder) throw httpError(409, `This ffmpeg build has no encoder for ${f.label} (${f.encoders.join(' or ')})`);
    let kbps = null;
    if (f.bitrates) {
      kbps = bitrate === undefined || bitrate === null ? f.defaultBitrate : Number(bitrate);
      if (!f.bitrates.includes(kbps)) throw httpError(400, `${f.label} bitrate must be one of ${f.bitrates.join(', ')} kbps`);
    }
    const info = await readWavInfo(input);
    if (!info) throw httpError(400, 'Only PCM/float WAV renders can be converted');
    if (f.maxChannels && info.channels > f.maxChannels) {
      throw httpError(422, `${f.label} holds at most ${f.maxChannels} channel${f.maxChannels > 1 ? 's' : ''}; this render has ${info.channels}. Use ${info.channels <= 8 ? 'FLAC, ' : ''}WAV or AIFF for it${f.maxChannels === 2 ? ', or a stereo/binaural render' : ''}.`);
    }
    // lossy surround codecs need known speaker positions (5.1, 7.1); ADM/object renders have none: lossless only
    if (!f.lossless && info.channels > 2 && !info.mask) {
      throw httpError(422, `This WAV has ${info.channels} channels without speaker positions (an ADM/object render): only FLAC (≤ 8 channels), Apple Lossless (≤ 7) or AIFF keep them.`);
    }
    const bits = info.bitsPerSample >= 24 ? 24 : 16;
    // the input's own PCM decoder, forced: ffmpeg never probes or picks a decoder from user data
    const decoder = info.format === 'float' ? (info.bitsPerSample === 64 ? 'pcm_f64le' : 'pcm_f32le') : { 8: 'pcm_u8', 16: 'pcm_s16le', 24: 'pcm_s24le', 32: 'pcm_s32le' }[info.bitsPerSample];

    const codec = ['-c:a', encoder];
    if (kbps) codec.push('-b:a', `${kbps}k`);
    if (format === 'mp3') codec.push('-id3v2_version', '3', '-write_xing', '1');
    if (format === 'aac') codec.push('-movflags', '+faststart');
    if (format === 'opus') codec.push('-ar', '48000', '-vbr', 'on');
    if (format === 'flac') codec.push('-compression_level', '8', '-sample_fmt', bits === 24 ? 's32' : 's16', ...(bits === 24 ? ['-bits_per_raw_sample', '24'] : []));
    if (format === 'alac') codec.push('-sample_fmt', bits === 24 ? 's32p' : 's16p', ...(bits === 24 ? ['-bits_per_raw_sample', '24'] : []));
    if (format === 'aiff') codec[1] = bits === 24 && st.encoders.includes('pcm_s24be') ? 'pcm_s24be' : 'pcm_s16be';
    const meta = cleanMetadata({ comment: 'Made with GreanTeaDawy', ...metadata });
    const metaArgs = Object.entries(meta).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);

    let outPath = null;
    let started = false;
    const dir = path.dirname(input);
    try {
      await slot();
      started = true;
      // reserve a fresh output name next to the input once it's our turn (exclusive create: never overwrites)
      const base = path.basename(input, path.extname(input)) + (f.suffix || '');
      let out = null;
      for (let i = 1; i < 1000 && !out; i++) {
        const name = `${base}${i > 1 ? `-${i}` : ''}.${f.ext}`;
        if (fileExists && await fileExists(path.join(dir, name))) continue;
        try {
          await (await fs.open(path.join(dir, name), 'wx')).close();
          out = name;
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
        }
      }
      if (!out) throw httpError(409, 'Too many exports with that name');
      outPath = path.join(dir, out);
      const args = [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-protocol_whitelist', 'file', '-f', 'wav', '-c:a', decoder, '-i', `file:${input}`,
        '-map', '0:a:0', '-map_metadata', '-1', '-vn', '-threads', '2',
        ...codec, ...metaArgs,
        '-f', f.muxer, `file:${outPath}`
      ];
      await run(bin, args, { timeoutMs: timeoutSec * 1000 });
      const { size } = await fs.stat(outPath);
      if (!size) throw new Error('ffmpeg wrote an empty file');
      return { name: out, path: outPath, bytes: size, format, encoder: codec[1], ...(kbps ? { bitrate: kbps } : { bitDepth: format === 'opus' ? null : bits }) };
    } catch (e) {
      if (outPath) await fs.rm(outPath, { force: true }).catch(() => {});
      if (e.status) throw e;
      // ffmpeg's own message, without the server's folder names
      const msg = String(e.message || e).split(dir + path.sep).join('').split(dir).join('').replace(/file:/g, '').slice(0, 300);
      throw httpError(e.code === 'ETIMEDOUT' ? 504 : 422, `Conversion to ${f.label} failed: ${msg}`);
    } finally {
      if (started) release();
    }
  }

  return { status, formats, convert, get configuredPath() { return configured; } };
}
