// Bounded audio work for the test service. Decoding, analysis and rendering run
// only on Linux; none of these operations fall back to the user's computer.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeAudio, PPQ } from '@greanteadawy/core';

const exec = promisify(execFile);
function failure(message, code = 'MUSIC_AUDIO_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}
async function safeAudio(task) {
  try { return await task(); }
  catch (error) {
    if (String(error.code || '').startsWith('MUSIC_')) throw error;
    if (error.code === 'EEXIST') throw failure('Já existe um ficheiro neste destino; não foi substituído.', 'MUSIC_OUTPUT_EXISTS');
    if (error.code === 'ENOENT') throw failure('O ficheiro de áudio necessário não está disponível.', 'MUSIC_INPUT_MISSING');
    const safe = failure('O processamento cloud do áudio não foi concluído.', 'MUSIC_AUDIO_FAILED');
    // Retain diagnostics for server-side debugging, never in JSON/public messages.
    Object.defineProperty(safe, 'cause', { value: error, enumerable: false });
    throw safe;
  }
}
export const inspectWav = (file) => safeAudio(() => inspectWavInternal(file));
export const prepareAudio = (options) => safeAudio(() => prepareAudioInternal(options));
export const analyzeTiming = (options) => safeAudio(() => analyzeTimingInternal(options));
export const validateStemAlignment = (options) => safeAudio(() => validateStemAlignmentInternal(options));
export const renderArrangement = (options) => safeAudio(() => renderArrangementInternal(options));
const RATE = 44100;
const MAX_SECONDS = 900;
const ANALYSIS_RATE = 8000;
const round = (n, digits = 6) => Math.round(n * 10 ** digits) / 10 ** digits;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const median = (values) => {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
};

function cloudOnly() {
  if (process.platform !== 'linux') throw failure('O processamento de áudio só é permitido na cloud Linux; não será executado no Mac.');
}

function finite(value, name, low, high) {
  if (!Number.isFinite(value) || value < low || value > high) throw failure(`${name} inválido`);
  return value;
}

async function ffmpeg(ffmpegPath, args) {
  cloudOnly();
  if (typeof ffmpegPath !== 'string' || !path.isAbsolute(ffmpegPath)) throw failure('FFmpeg cloud não configurado');
  await exec(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-threads', '1',
    '-filter_threads', '1', '-filter_complex_threads', '1', ...args], {
    timeout: 600_000, maxBuffer: 512 * 1024, env: { PATH: process.env.PATH, LANG: 'C' }
  });
}

async function temporary(fn, parent = os.tmpdir()) {
  const directory = await fs.mkdtemp(path.join(parent, 'gm-audio-'));
  try { return await fn(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function publish(source, target) {
  // Never overwrite a user's original or an earlier export, even in a race.
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
}

/** Header-only inspection: exact PCM frame count, not an MP3 duration estimate. */
async function inspectWavInternal(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const header = Buffer.alloc(12);
    if ((await handle.read(header, 0, 12, 0)).bytesRead !== 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw failure('WAV RIFF inválido');
    const declared = header.readUInt32LE(4) + 8;
    if (declared > stat.size) throw failure('WAV truncado');
    let fmt, data;
    let position = 12, count = 0;
    while (position + 8 <= declared) {
      if (++count > 10000) throw failure('WAV contém demasiados blocos');
      const chunk = Buffer.alloc(8);
      await handle.read(chunk, 0, 8, position);
      const tag = chunk.toString('ascii', 0, 4), size = chunk.readUInt32LE(4);
      const body = position + 8;
      if (body + size > declared) throw failure('Bloco WAV truncado');
      if (tag === 'fmt ') {
        if (size < 16 || size > 65536 || fmt) throw failure('Formato WAV inválido');
        const bytes = Buffer.alloc(Math.min(size, 40));
        await handle.read(bytes, 0, bytes.length, body);
        let format = bytes.readUInt16LE(0);
        if (format === 0xfffe) {
          if (size < 40) throw failure('Formato WAV extensível incompleto');
          format = bytes.readUInt16LE(24);
        }
        fmt = { format, channels: bytes.readUInt16LE(2), sampleRate: bytes.readUInt32LE(4),
          blockAlign: bytes.readUInt16LE(12), bitsPerSample: bytes.readUInt16LE(14) };
        const supported = format === 1 ? [8, 16, 24, 32] : format === 3 ? [32, 64] : [];
        if (!supported.includes(fmt.bitsPerSample) || fmt.channels < 1 || fmt.channels > 64 || fmt.sampleRate < 1000 || fmt.sampleRate > 384000 || fmt.blockAlign !== fmt.channels * fmt.bitsPerSample / 8) throw failure('Codificação WAV não suportada');
      } else if (tag === 'data') {
        if (data) throw failure('Múltiplos blocos áudio não suportados');
        data = { dataOffset: body, dataBytes: size };
      }
      position = body + size + size % 2;
    }
    if (!fmt || !data || !data.dataBytes || data.dataBytes % fmt.blockAlign) throw failure('WAV sem frames PCM completos');
    const frames = data.dataBytes / fmt.blockAlign;
    return { path: file, bytes: stat.size, ...fmt, ...data, frames, totalFrames: frames,
      durationSeconds: frames / fmt.sampleRate };
  } finally { await handle.close(); }
}

/** Preserve the input bytes; decode once and trim the working copy at sample boundaries. */
async function prepareAudioInternal({ inputPath, outputPath, startSeconds = 0, durationSeconds, ffmpegPath }) {
  cloudOnly();
  finite(startSeconds, 'Início', 0, 24 * 3600);
  if (durationSeconds !== undefined) finite(durationSeconds, 'Duração', 0.01, MAX_SECONDS);
  const inputFormat = { '.wav': 'wav', '.mp3': 'mp3' }[path.extname(inputPath).toLowerCase()];
  if (!inputFormat) throw failure('A importação aceita apenas WAV ou MP3');
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw failure('O original não pode ser substituído');
  return temporary(async (dir) => {
    const wav = path.join(dir, 'working.wav');
    const begin = Math.round(startSeconds * RATE);
    const frames = durationSeconds === undefined ? undefined : Math.round(durationSeconds * RATE);
    const trim = `atrim=start_sample=${begin}${frames === undefined ? '' : `:end_sample=${begin + frames}`}`;
    await ffmpeg(ffmpegPath, ['-protocol_whitelist', 'file,pipe', '-f', inputFormat, '-i', inputPath, '-map', '0:a:0', '-vn',
      '-af', `aresample=${RATE},${trim},asetpts=PTS-STARTPTS`, '-ac', '2', '-ar', String(RATE),
      '-t', String(MAX_SECONDS + 1), '-c:a', 'pcm_s16le', wav]);
    const info = await inspectWav(wav);
    if (info.durationSeconds > MAX_SECONDS || (frames !== undefined && info.frames !== frames)) throw failure('A duração pedida excede o ficheiro ou o limite do teste');
    await publish(wav, outputPath);
    return { ...info, path: outputPath, sourcePreserved: true, startFrame: begin };
  });
}

async function readMono({ inputPath, startSeconds = 0, durationSeconds = 120, sampleRate = ANALYSIS_RATE, ffmpegPath }) {
  return temporary(async (dir) => {
    const raw = path.join(dir, 'analysis.f32');
    await ffmpeg(ffmpegPath, ['-protocol_whitelist', 'file,pipe', '-i', inputPath, '-map', '0:a:0', '-vn',
      '-ss', String(startSeconds), '-t', String(durationSeconds), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_f32le', '-f', 'f32le', raw]);
    const bytes = await fs.readFile(raw);
    if (!bytes.length || bytes.length % 4 || bytes.length > (durationSeconds + 1) * sampleRate * 4) throw failure('Descodificação de análise inválida');
    const mono = new Float32Array(bytes.length / 4);
    for (let i = 0; i < mono.length; i++) {
      mono[i] = bytes.readFloatLE(i * 4);
      if (!Number.isFinite(mono[i])) throw failure('Áudio contém amostras inválidas');
    }
    return mono;
  });
}

function regression(points) {
  const count = points.length;
  const mx = points.reduce((s, p) => s + p[0], 0) / count;
  const my = points.reduce((s, p) => s + p[1], 0) / count;
  let xx = 0, xy = 0;
  for (const [x, y] of points) { xx += (x - mx) ** 2; xy += (x - mx) * (y - my); }
  const period = xy / xx;
  return { period, phase: my - period * mx };
}

/** Fit beat attacks, with an explicit uncertainty report; this is not musical approval. */
export function estimatePulseTiming(mono, sampleRate, coarseTempo = null) {
  const hop = Math.max(1, Math.round(sampleRate * 0.005)), fps = sampleRate / hop;
  const energy = [];
  for (let i = 0; i + hop <= mono.length; i += hop) {
    let square = 0;
    for (let j = 0; j < hop; j++) square += mono[i + j] ** 2;
    energy.push(Math.sqrt(square / hop));
  }
  const env = energy.map((v, i) => Math.max(0, v - (energy[Math.max(0, i - 2)] + energy[Math.max(0, i - 3)]) / 2));
  const max = Math.max(0, ...env);
  if (mono.length < sampleRate * 4 || max < 1e-6) return { bpm: null, confidence: 0, beatPhaseSeconds: null, driftMs: null, alternatives: [], reason: 'Sem ataques suficientes para medir o pulso' };
  const mean = env.reduce((s, v) => s + v, 0) / env.length;
  const signal = env.map((v) => Math.max(0, v - mean));
  const low = Math.ceil(fps * 60 / 200), high = Math.floor(fps * 60 / 60);
  const acf = [];
  for (let lag = low - 1; lag <= high + 1; lag++) {
    let a = 0, b = 0, ab = 0;
    for (let i = 0; i + lag < signal.length; i++) {
      const x = signal[i], y = signal[i + lag];
      a += x * x; b += y * y; ab += x * y;
    }
    acf[lag] = ab / Math.max(1e-12, Math.sqrt(a * b));
  }
  const candidates = [];
  for (let lag = low; lag <= high; lag++) {
    if (acf[lag] < acf[lag - 1] || acf[lag] < acf[lag + 1]) continue;
    const den = acf[lag - 1] - 2 * acf[lag] + acf[lag + 1];
    const fine = lag + (den ? clamp(0.5 * (acf[lag - 1] - acf[lag + 1]) / den, -0.5, 0.5) : 0);
    const bpm = 60 * fps / fine;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const agreement = coarseTempo?.bpm && Math.abs(bpm - coarseTempo.bpm) < 2 ? 1.05 : 1;
    candidates.push({ bpm, period: fine / fps, correlation: acf[lag], score: acf[lag] * prior * agreement });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length || candidates[0].correlation < 0.08) return { bpm: null, confidence: 0, beatPhaseSeconds: null, driftMs: null, alternatives: [], reason: 'Pulso periódico insuficiente' };
  const chosen = candidates[0];
  const periodFrames = chosen.period * fps;
  let phaseFrame = 0, best = -Infinity;
  for (let phase = 0; phase < periodFrames; phase++) {
    let score = 0;
    for (let x = phase; x < signal.length; x += periodFrames) score += signal[Math.round(x)] || 0;
    if (score > best) { best = score; phaseFrame = phase; }
  }
  let points = [];
  for (let beat = 0, center = phaseFrame; center < signal.length; beat++, center += periodFrames) {
    let peak = -1, value = 0;
    for (let i = Math.max(1, Math.round(center - periodFrames * 0.13)); i <= Math.min(signal.length - 2, Math.round(center + periodFrames * 0.13)); i++) {
      if (signal[i] > value) { peak = i; value = signal[i]; }
    }
    if (peak < 0 || value < max * 0.06) continue;
    const den = signal[peak - 1] - 2 * value + signal[peak + 1];
    const sub = den ? clamp(0.5 * (signal[peak - 1] - signal[peak + 1]) / den, -0.5, 0.5) : 0;
    points.push([beat, (peak + sub) / fps]);
  }
  if (points.length < 6) return { bpm: round(chosen.bpm, 3), confidence: 0.1, beatPhaseSeconds: phaseFrame / fps, driftMs: null,
    alternatives: candidates.slice(0, 4).map((c) => round(c.bpm, 3)), reason: 'Poucas batidas fiáveis' };
  let fitted = regression(points);
  for (let pass = 0; pass < 2; pass++) {
    const residuals = points.map(([n, t]) => Math.abs(t - fitted.phase - n * fitted.period));
    const cutoff = Math.max(0.012, 3 * median(residuals));
    points = points.filter(([n, t]) => Math.abs(t - fitted.phase - n * fitted.period) <= cutoff);
    if (points.length < 6) break;
    fitted = regression(points);
  }
  if (!Number.isFinite(fitted.period) || fitted.period <= 0 || Math.abs(fitted.period / chosen.period - 1) > 0.04) fitted = { period: chosen.period, phase: phaseFrame / fps };
  const residuals = points.map(([n, t]) => t - fitted.phase - n * fitted.period);
  const jitter = Math.sqrt(residuals.reduce((s, v) => s + v * v, 0) / Math.max(1, residuals.length));
  const half = Math.floor(points.length / 2);
  const first = regression(points.slice(0, half)), second = regression(points.slice(half));
  const measuredSeconds = mono.length / sampleRate;
  const drift = Number.isFinite(first.period + second.period) ? (second.period - first.period) / fitted.period * measuredSeconds * 1000 : null;
  const coverage = points.length / (measuredSeconds / fitted.period);
  const confidence = clamp(chosen.correlation * Math.min(1, coverage) * Math.exp(-jitter / 0.025), 0, 1);
  const phase = ((fitted.phase % fitted.period) + fitted.period) % fitted.period;
  return { bpm: round(60 / fitted.period, 4), confidence: round(confidence, 3), beatPhaseSeconds: round(phase),
    driftMs: drift === null ? null : round(drift, 2), beatJitterMs: round(jitter * 1000, 2), fittedBeats: points.length,
    alternatives: candidates.slice(0, 4).map((c) => round(c.bpm, 3)), method: '5ms onset envelope, autocorrelation and robust beat-attack regression',
    halfDoubleTimeAmbiguous: true, musicalDownbeatConfirmed: false };
}

async function analyzeTimingInternal({ inputPath, drumsPath, ffmpegPath }) {
  cloudOnly();
  const mono = await readMono({ inputPath: drumsPath || inputPath, durationSeconds: 120, ffmpegPath });
  const analysis = analyzeAudio({ channels: [mono], sampleRate: ANALYSIS_RATE }, { maxTempoSeconds: 120 });
  const timing = estimatePulseTiming(mono, ANALYSIS_RATE, analysis.tempo);
  const warnings = ['O BPM e a fase são estimativas; a primeira batida de compasso requer confirmação musical.'];
  if (timing.confidence < 0.45) warnings.push('Confiança reduzida: confirma o BPM antes de editar à grelha.');
  if (timing.driftMs !== null && Math.abs(timing.driftMs) > 30) warnings.push('Variação de tempo detetada; uma grelha fixa pode não acompanhar toda a música.');
  return { ...timing, beatOffsetSeconds: timing.beatPhaseSeconds, analysisWindowSeconds: mono.length / ANALYSIS_RATE,
    timingSource: drumsPath ? 'drums' : 'mixture', coarseTempo: analysis.tempo, warnings,
    analysis: { ...analysis, tempo: timing.bpm ? { bpm: timing.bpm, confidence: timing.confidence } : null } };
}

function lagMetrics(reference, reconstructed, rate) {
  let bestLag = 0, best = -1;
  const correlation = (lag, stride) => {
    let ab = 0, aa = 0, bb = 0;
    const lo = Math.max(0, -lag), hi = Math.min(reference.length, reconstructed.length - lag);
    for (let i = lo; i < hi; i += stride) { const a = reference[i], b = reconstructed[i + lag]; ab += a * b; aa += a * a; bb += b * b; }
    return { correlation: ab / Math.max(1e-20, Math.sqrt(aa * bb)), gain: ab / Math.max(bb, 1e-20) };
  };
  const range = Math.round(rate * 0.1), coarse = 4;
  for (let lag = -range; lag <= range; lag += coarse) {
    const c = correlation(lag, coarse).correlation;
    if (c > best) { best = c; bestLag = lag; }
  }
  const center = bestLag;
  best = -Infinity;
  for (let lag = center - coarse + 1; lag <= center + coarse - 1; lag++) {
    const c = correlation(lag, 1).correlation;
    if (c > best) { best = c; bestLag = lag; }
  }
  const fit = correlation(bestLag, 1);
  let refSquare = 0, error = 0, rawError = 0, count = 0;
  for (let i = Math.max(0, -bestLag); i < Math.min(reference.length, reconstructed.length - bestLag); i++) {
    const a = reference[i], b = reconstructed[i + bestLag];
    refSquare += a * a; error += (a - fit.gain * b) ** 2; rawError += (a - b) ** 2; count++;
  }
  return { measuredLagSamples: bestLag, measuredLagSeconds: bestLag / rate, measurementSampleRate: rate,
    correlation: round(fit.correlation), fittedGain: round(fit.gain), referenceRms: Math.sqrt(refSquare / Math.max(1, count)),
    residualRms: Math.sqrt(rawError / Math.max(1, count)), relativeResidualAfterGainFit: Math.sqrt(error / Math.max(refSquare, 1e-20)) };
}

/** No silent padding, shifting or cropping of mismatched stems. */
async function validateStemAlignmentInternal({ mixturePath, stemPaths, ffmpegPath }) {
  cloudOnly();
  const paths = stemPaths instanceof Map ? [...stemPaths.values()] : Array.isArray(stemPaths) ? stemPaths : Object.values(stemPaths || {});
  if (paths.length !== 4 || new Set(paths.map((p) => path.resolve(p))).size !== 4) throw failure('São necessários quatro stems distintos');
  const mixture = await inspectWav(mixturePath);
  const stems = await Promise.all(paths.map(inspectWav));
  for (const item of [mixture, ...stems]) {
    if (item.sampleRate !== RATE || item.channels !== 2 || item.format !== 1 || item.bitsPerSample !== 16 || item.frames !== mixture.frames) throw failure('Stems não alinhados: exigidos WAV PCM16 estéreo 44,1kHz com exatamente os mesmos frames');
  }
  const duration = Math.min(6, mixture.durationSeconds);
  const starts = [...new Set([0, Math.max(0, (mixture.durationSeconds - duration) / 2), Math.max(0, mixture.durationSeconds - duration)])];
  const windows = [];
  for (const startSeconds of starts) {
    const reference = await readMono({ inputPath: mixturePath, startSeconds, durationSeconds: duration, ffmpegPath });
    const sum = new Float32Array(reference.length);
    for (const inputPath of paths) {
      const part = await readMono({ inputPath, startSeconds, durationSeconds: duration, ffmpegPath });
      if (part.length !== reference.length) throw failure('A descodificação dos stems perdeu o alinhamento');
      for (let i = 0; i < sum.length; i++) sum[i] += part[i];
    }
    const metrics = lagMetrics(reference, sum, ANALYSIS_RATE);
    if (metrics.referenceRms > 1e-5) windows.push({ startSeconds, durationSeconds: duration, ...metrics });
  }
  if (!windows.length) throw failure('Não há sinal suficiente para comprovar o alinhamento');
  const lags = windows.map((w) => w.measuredLagSeconds);
  const lagDrift = Math.max(...lags) - Math.min(...lags);
  const valid = windows.every((w) => Math.abs(w.measuredLagSeconds) <= 0.001 && w.correlation >= 0.85 && w.relativeResidualAfterGainFit < 0.55) && lagDrift <= 0.00075;
  const report = { valid, frames: mixture.frames, sampleRate: RATE, channels: 2, durationSeconds: mixture.durationSeconds,
    exactFrameCounts: true, commonLagSeconds: median(lags), lagDriftSeconds: lagDrift,
    measurementResolutionSeconds: 1 / ANALYSIS_RATE, windows, correctionApplied: false,
    limitation: 'Correlation checks timing of the stem sum; it does not approve separation quality or prove isolation of each instrument.' };
  if (!valid) {
    const error = failure('A separação não passou a verificação de sincronização; não foi corrigida automaticamente');
    error.alignment = report;
    throw error;
  }
  return report;
}

/** Pure render plan, shared by preflight and tests. No original sample is changed. */
export function planArrangement(project) {
  const bpm = finite(project?.bpm, 'BPM', 20, 400), tps = bpm * PPQ / 60;
  const clips = project.playlist?.clips, tracks = project.playlist?.tracks || [];
  if (!Array.isArray(clips) || !clips.length || clips.length > 128) throw failure('O arranjo precisa de 1–128 clips');
  if (project.spatial?.enabled) throw failure('O render cloud ainda não suporta áudio espacial');
  const master = project.mixer?.[0];
  if (master?.effects?.some((f) => f.enabled !== false) || (master?.pan || 0) !== 0 || master?.sends?.length) throw failure('O render cloud ainda não suporta efeitos, pan ou envios no master');
  const gain = master?.mute ? 0 : finite(master?.volume ?? 1, 'Volume master', 0, 1.25);
  let end = 0;
  const playable = [];
  for (const clip of clips) {
    const start = finite(clip.start, 'Início do clip', 0, MAX_SECONDS * tps);
    const length = finite(clip.length, 'Duração do clip', 1, MAX_SECONDS * tps);
    end = Math.max(end, start + length);
    if (clip.mute || tracks[clip.track]?.mute) continue;
    if (clip.kind !== 'audio') throw failure('O render cloud desta versão suporta apenas pistas áudio; MIDI e automações ainda não são renderizados');
    if ((clip.rate ?? 1) !== 1) throw failure('O render cloud ainda não suporta alterações de velocidade');
    if (typeof clip.refId !== 'string' || !clip.refId) throw failure('Clip sem ficheiro áudio');
    const offset = finite(clip.offset ?? 0, 'Offset', 0, MAX_SECONDS * tps);
    const fadeIn = Math.min(finite(clip.fadeIn ?? 0, 'Fade in', 0, MAX_SECONDS * tps), length);
    const fadeOut = Math.min(finite(clip.fadeOut ?? 0, 'Fade out', 0, MAX_SECONDS * tps), length - fadeIn);
    playable.push({ id: clip.id, sampleId: clip.refId, track: clip.track,
      startFrame: Math.round(start / tps * RATE), lengthFrames: Math.max(1, Math.round(length / tps * RATE)),
      offsetFrame: Math.round(offset / tps * RATE), fadeInFrames: Math.round(fadeIn / tps * RATE),
      fadeOutFrames: Math.round(fadeOut / tps * RATE), gain: finite(clip.gain ?? 1, 'Ganho do clip', 0, 4) });
  }
  const durationSeconds = finite(end / tps, 'Duração total', 0.001, MAX_SECONDS);
  return { clips: playable, frames: Math.round(durationSeconds * RATE), sampleRate: RATE, durationSeconds, masterGain: gain,
    limitations: ['Audio clips only; no synthesis, speed changes, spatial mix, automation or master effects.'] };
}

async function floatPeak(file) {
  const info = await inspectWav(file);
  if (info.format !== 3 || info.bitsPerSample !== 32) throw failure('Render intermédio não é PCM float32');
  const handle = await fs.open(file, 'r');
  let peak = 0, sum = 0, count = 0;
  try {
    const bytes = Buffer.alloc(256 * 1024);
    for (let offset = 0; offset < info.dataBytes;) {
      const length = Math.min(bytes.length, info.dataBytes - offset);
      const { bytesRead } = await handle.read(bytes, 0, length, info.dataOffset + offset);
      if (bytesRead !== length) throw failure('Render intermédio truncado');
      for (let i = 0; i < bytesRead; i += 4) {
        const value = bytes.readFloatLE(i);
        if (!Number.isFinite(value)) throw failure('Render contém áudio inválido');
        peak = Math.max(peak, Math.abs(value)); sum += value * value; count++;
      }
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  return { peak, rms: Math.sqrt(sum / Math.max(1, count)) };
}

async function renderArrangementInternal({ project, samples, outputPath, ffmpegPath }) {
  cloudOnly();
  const plan = planArrangement(project);
  if (!(samples instanceof Map)) throw failure('Mapa de samples inválido');
  const sourcePaths = [...new Set(plan.clips.map((clip) => samples.get(clip.sampleId)))];
  if (sourcePaths.some((p) => typeof p !== 'string')) throw failure('Falta um ficheiro usado no arranjo');
  const facts = new Map();
  for (const file of sourcePaths) {
    if (path.resolve(file) === path.resolve(outputPath)) throw failure('O original não pode ser substituído');
    const info = await inspectWav(file);
    if (info.sampleRate !== RATE || info.channels !== 2) throw failure('Os samples do arranjo têm de ser WAV estéreo 44,1kHz');
    facts.set(file, info);
  }
  return temporary(async (dir) => {
    const args = [], filters = [], labels = [];
    // A separate bounded decoder input per clip permits repeated/reordered regions.
    for (const [i, clip] of plan.clips.entries()) {
      const file = samples.get(clip.sampleId), info = facts.get(file);
      if (clip.offsetFrame >= info.frames) throw failure('Um corte começa depois do fim do sample');
      const frames = Math.min(clip.lengthFrames, info.frames - clip.offsetFrame);
      const edge = Math.min(Math.round(RATE * 0.003), Math.floor(frames / 3));
      const fadeIn = Math.min(clip.fadeInFrames || edge, frames);
      const fadeOut = Math.min(clip.fadeOutFrames || edge, frames - fadeIn);
      args.push('-protocol_whitelist', 'file,pipe', '-i', file);
      const fades = [...(fadeIn > 0 ? [`afade=t=in:ss=0:ns=${fadeIn}`] : []), ...(fadeOut > 0 ? [`afade=t=out:ss=${frames - fadeOut}:ns=${fadeOut}`] : [])];
      filters.push(`[${i}:a]atrim=start_sample=${clip.offsetFrame}:end_sample=${clip.offsetFrame + frames},asetpts=PTS-STARTPTS,` +
        [...fades, `volume=${clip.gain}`, `adelay=${clip.startFrame}S:all=1`].join(',') + `[c${i}]`);
      labels.push(`[c${i}]`);
    }
    if (labels.length) filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0:dropout_transition=0,volume=${plan.masterGain},apad=whole_len=${plan.frames},atrim=end_sample=${plan.frames}[out]`);
    else filters.push(`anullsrc=r=${RATE}:cl=stereo,atrim=end_sample=${plan.frames}[out]`);
    const graph = path.join(dir, 'filters.txt'), intermediate = path.join(dir, 'mix-float.wav'), final = path.join(dir, 'mix.wav');
    await fs.writeFile(graph, filters.join(';\n'));
    await ffmpeg(ffmpegPath, [...args, '-filter_complex_script', graph, '-map', '[out]', '-ac', '2', '-ar', String(RATE), '-c:a', 'pcm_f32le', intermediate]);
    const levels = await floatPeak(intermediate);
    const ceiling = 10 ** (-1 / 20), outputGain = levels.peak > ceiling ? ceiling / levels.peak : 1;
    await ffmpeg(ffmpegPath, ['-protocol_whitelist', 'file,pipe', '-i', intermediate, '-af', `volume=${outputGain}`, '-c:a', 'pcm_s16le', final]);
    const info = await inspectWav(final);
    if (info.frames !== plan.frames) throw failure('A exportação não preservou a duração do arranjo');
    await publish(final, outputPath);
    return { ...info, path: outputPath, sourcePreserved: true, renderedClips: plan.clips.length,
      preSafetyPeak: levels.peak, outputGain, outputGainDb: outputGain ? 20 * Math.log10(outputGain) : null,
      peak: levels.peak * outputGain, rms: levels.rms * outputGain, safety: 'One constant gain for the complete mix, only if peak would exceed −1dBFS; no per-stem normalization.',
      limitations: plan.limitations };
  });
}
