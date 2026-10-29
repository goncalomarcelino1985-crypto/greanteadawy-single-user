// Private, temporary workbench. Never mounted in production or the durable cloud store.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import crypto from 'node:crypto';
import { createEmptyProject, createClip, uid, PPQ } from '@greanteadawy/core';
import { cleanName } from '../samples.js';
import { writeFileAtomic } from '../fsutil.js';
import { httpError, wrap } from '../errors.js';
import { createMvsepProvider } from './mvsep.js';
import { prepareAudio, inspectWav, analyzeTiming, validateStemAlignment, renderArrangement } from './audio.js';

const LABELS = { drums: 'Bateria', bass: 'Baixo', vocals: 'Voz', other: 'Restantes instrumentos' };
const BUSY = new Set(['preparing', 'queued', 'separating', 'validating']);
// 560 s of canonical stereo PCM16 fits MVSEP's 100,000,000-byte free input cap.
const LIMITS = { maxUploadMb: 50, maxDurationSeconds: 560 };
const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const digest = async (file) => {
  const hash = crypto.createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
const safeFailure = (error) => error?.publicMessage || (/^MUSIC_|^MVSEP_/.test(error?.code || '') ? error.message : 'A operação não terminou. O original foi preservado; não há resultado validado novo.');

export async function createMusicRouter({ config, auth, samples, store, users, providerFactory = createMvsepProvider, audio = { prepareAudio, inspectWav, analyzeTiming, validateStemAlignment, renderArrangement }, fetchImpl = fetch }) {
  if (!config.singleUser || config.storageMode !== 'local') throw new Error('Music workbench requires the isolated single-user test store');
  const options = config.musicWorkbench;
  const dir = path.resolve(config.dataDir, 'music-jobs');
  await fs.mkdir(dir, { recursive: true });
  const jobs = new Map();
  const providers = new Map(); // Session-only secret: no environment, JSON, database, browser storage or logs.
  let active = null;
  const save = async (job) => {
    job.updatedAt = new Date().toISOString();
    await writeFileAtomic(path.join(dir, job.id, 'job.json'), JSON.stringify(job, null, 2));
  };
  for (const name of await fs.readdir(dir)) {
    if (!/^music_[\w-]+$/.test(name)) continue;
    try {
      const job = JSON.parse(await fs.readFile(path.join(dir, name, 'job.json'), 'utf8'));
      if (job.id !== name || !job.ownerId) continue;
      if (BUSY.has(job.status)) { job.status = 'failed'; job.error = 'Processo interrompido. Não foi reenviado automaticamente ao fornecedor.'; }
      if (job.renderStatus === 'rendering') job.renderStatus = 'failed';
      jobs.set(job.id, job);
    } catch { /* Preserve unreadable files; never delete/recreate them. */ }
  }
  const fileUrl = (job, file) => `/api/music/jobs/${encodeURIComponent(job.id)}/files/${encodeURIComponent(file)}`;
  const view = (job) => ({ id: job.id, name: job.name, status: job.status, message: job.message, error: job.error,
    original: { name: job.original.name, bytes: job.original.bytes, sha256: job.original.sha256, url: fileUrl(job, job.original.file) },
    clip: job.clip ? { ...job.clip, url: fileUrl(job, 'source.wav') } : null,
    analysis: job.analysis, alignment: job.alignment,
    stems: (job.stems || []).map((stem) => ({ key: stem.key, name: LABELS[stem.key], sha256: stem.sha256, frames: stem.frames, url: fileUrl(job, `${stem.key}.wav`) })),
    projectId: job.projectId || null, renderStatus: job.renderStatus, renderError: job.renderError,
    edited: job.edited ? { ...job.edited, url: fileUrl(job, job.edited.file) } : null,
    createdAt: job.createdAt, updatedAt: job.updatedAt, provider: 'MVSEP', model: 'htdemucs_ft', temporary: true });
  const own = (req) => { const job = jobs.get(req.params.id); if (!job || job.ownerId !== req.user.id) throw httpError(404, 'Importação não encontrada.'); return job; };
  const caps = (ownerId) => ({ available: providers.has(ownerId), provider: 'MVSEP', model: 'htdemucs_ft', limits: LIMITS,
    reason: providers.has(ownerId) ? null : 'Entra numa conta MVSEP Free e liga a chave nesta sessão para separar. O original pode ser importado antes.',
    temporary: true, processing: 'cloud', paidFallback: false });
  const requireIdle = () => { if (active) throw httpError(409, 'Já há uma operação em curso. Aguarda a conclusão.'); };
  const r = express.Router();
  r.use(auth.requireUser);
  r.use(express.json({ limit: '16kb' }));
  r.get('/capabilities', (req, res) => res.json(caps(req.user.id)));
  r.post('/provider', auth.requireSession, wrap(async (req, res) => {
    requireIdle();
    if (typeof req.body?.token !== 'string' || req.body.token.length < 12 || req.body.token.length > 512 || /\s/.test(req.body.token)) throw httpError(400, 'Chave MVSEP inválida.');
    const provider = providerFactory({ token: req.body.token });
    await provider.checkFreeAccount();
    providers.set(req.user.id, provider);
    res.json(caps(req.user.id));
  }));
  r.get('/jobs', (req, res) => res.json([...jobs.values()].filter((j) => j.ownerId === req.user.id).reverse().map(view)));
  r.get('/jobs/:id', wrap(async (req, res) => {
    const job = own(req);
    const result = view(job);
    if (job.projectId) result.projectRevision = (await store.getOwned(job.projectId, req.user.id)).rev;
    res.json(result);
  }));

  const upload = multer({ storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => cb(null, `incoming-${crypto.randomUUID()}.part`)
  }), limits: { files: 1, fileSize: LIMITS.maxUploadMb * 1024 * 1024, fields: 2, fieldSize: 100 },
  fileFilter: (req, file, cb) => cb(null, Object.hasOwn(MIME, path.extname(file.originalname).toLowerCase())) });
  r.post('/jobs', (req, res, next) => { try { requireIdle(); next(); } catch (e) { next(e); } }, upload.single('file'), wrap(async (req, res) => {
    if (!req.file || !req.file.size) throw httpError(400, 'Escolhe um ficheiro WAV ou MP3, até 50 MB.');
    requireIdle();
    const id = uid('music');
    active = id;
    try {
    const folder = path.join(dir, id);
    await fs.mkdir(folder, { recursive: false });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const originalFile = `original${ext}`;
    const originalPath = path.join(folder, originalFile);
    // Rename only the new upload. Source on the user's device and previous jobs are never touched.
    await fs.rename(req.file.path, originalPath);
    const startSeconds = req.body.startSeconds === undefined || req.body.startSeconds === '' ? 0 : Number(req.body.startSeconds);
    const durationSeconds = req.body.durationSeconds === undefined || req.body.durationSeconds === '' ? undefined : Number(req.body.durationSeconds);
    const job = { id, ownerId: req.user.id, name: cleanName(req.file.originalname, 100), status: 'preparing',
      createdAt: new Date().toISOString(), original: { file: originalFile, name: cleanName(req.file.originalname, 160), bytes: req.file.size, sha256: await digest(originalPath) },
      message: 'Original preservado. A preparar a cópia de trabalho na cloud.', stems: [] };
    jobs.set(id, job); await save(job);
    active = id;
    void (async () => {
      try {
        if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 36000 || (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > LIMITS.maxDurationSeconds))) throw Object.assign(new Error('Intervalo inválido: escolhe até 9 minutos e 20 segundos de áudio.'), { code: 'MUSIC_RANGE' });
        const info = await audio.prepareAudio({ inputPath: originalPath, outputPath: path.join(folder, 'source.wav'), startSeconds, durationSeconds, ffmpegPath: options.ffmpegPath });
        if (info.durationSeconds > LIMITS.maxDurationSeconds + 0.01) throw Object.assign(new Error('O excerto ultrapassa os 9 minutos e 20 segundos deste teste. Importa novamente com um intervalo mais curto; o original continua preservado.'), { code: 'MUSIC_DURATION' });
        job.clip = { startSeconds, durationSeconds: info.durationSeconds, frames: info.frames, sampleRate: info.sampleRate, channels: info.channels, sha256: await digest(path.join(folder, 'source.wav')) };
        job.analysis = await audio.analyzeTiming({ inputPath: path.join(folder, 'source.wav'), ffmpegPath: options.ffmpegPath });
        job.analysis.beatOffsetSeconds = job.analysis.beatPhaseSeconds;
        job.status = 'imported'; job.message = 'Original preservado e cópia preparada. Pronto para separar na cloud.';
      } catch (e) { job.status = 'failed'; job.error = safeFailure(e); }
      finally { active = null; await save(job); }
    })();
    res.status(202).json(view(job));
    } catch (error) { active = null; throw error; }
  }));

  async function downloadWav(url, destination) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !['mvsep.com', 'de.mvsep.com', 'de2.mvsep.com', 'sg.mvsep.com'].includes(u.hostname) || u.username || u.password || u.port) throw httpError(502, 'Endereço de resultado não permitido.');
    const response = await fetchImpl(u, { redirect: 'error', signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw httpError(502, 'Não foi possível receber um dos stems.');
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, enc, cb) { bytes += chunk.length; cb(bytes > 120 * 1024 * 1024 ? new Error('Stem exceeds limit') : null, chunk); } });
    const handle = await fs.open(destination, 'wx');
    try { await pipeline(response.body, limiter, handle.createWriteStream()); } finally { await handle.close().catch(() => {}); }
    return audio.inspectWav(destination);
  }
  async function importSample(file, name, ownerId) {
    const info = await audio.inspectWav(file);
    const id = uid('smp');
    // Validated PCM is copied without a second full-song DSP pass or large memory buffer.
    await fs.copyFile(file, path.join(samples.dir, `${id}.wav`), constants.COPYFILE_EXCL);
    const size = (await fs.stat(file)).size;
    const item = { id, ownerId, name, folderId: null, file: `${id}.wav`, mime: 'audio/wav', rev: 1, size,
      duration: info.durationSeconds, metadata: { container: 'WAVE', codec: 'PCM', lossless: true, sampleRate: info.sampleRate, channels: info.channels, bitsPerSample: info.bitsPerSample },
      analysis: null, createdAt: new Date().toISOString() };
    samples.items.unshift(item); await samples.save(ownerId); return item;
  }
  r.post('/jobs/:id/separate', wrap(async (req, res) => {
    requireIdle();
    const job = own(req);
    if (job.status !== 'imported') throw httpError(409, 'Esta importação não está pronta ou já foi enviada. Não há reenvio automático.');
    const provider = providers.get(req.user.id);
    if (!provider) throw httpError(409, caps(req.user.id).reason);
    await provider.checkFreeAccount();
    requireIdle(); active = job.id;
    job.status = 'queued'; job.message = 'A enviar a cópia de trabalho ao MVSEP Free. A aguardar processamento.'; await save(job);
    void (async () => {
      const folder = path.join(dir, job.id);
      try {
        const result = await provider.separate({ inputPath: path.join(folder, 'source.wav'), onProgress: (progress) => {
          job.status = ['queued', 'waiting', 'submitting', 'distributing'].includes(progress.status) ? 'queued' : 'separating';
          job.message = job.status === 'queued' ? 'Na fila gratuita do MVSEP.' : 'O modelo está a separar a música na cloud.';
        } });
        job.status = 'validating'; job.message = 'A receber os quatro WAVs e verificar o alinhamento.'; await save(job);
        const stemPaths = {};
        for (const key of Object.keys(LABELS)) {
          stemPaths[key] = path.join(folder, `${key}.wav`);
          const info = await downloadWav(result.files[key], stemPaths[key]);
          job.stems.push({ key, frames: info.frames, sha256: await digest(stemPaths[key]) });
        }
        job.alignment = await audio.validateStemAlignment({ mixturePath: path.join(folder, 'source.wav'), stemPaths, ffmpegPath: options.ffmpegPath });
        job.alignment.verified = true;
        job.analysis = await audio.analyzeTiming({ inputPath: path.join(folder, 'source.wav'), drumsPath: stemPaths.drums, ffmpegPath: options.ffmpegPath });
        job.analysis.beatOffsetSeconds = job.analysis.beatPhaseSeconds;
        const bpm = Number.isFinite(job.analysis.bpm) && job.analysis.bpm >= 20 && job.analysis.bpm <= 400 ? job.analysis.bpm : 120;
        const project = createEmptyProject({ name: job.name.replace(/\.(wav|mp3)$/i, '') + ' — stems', bpm, tracks: 4, inserts: 0 });
        project.mixer[0].effects = [];
        for (const [index, key] of Object.keys(LABELS).entries()) {
          const sample = await importSample(stemPaths[key], `${job.name.slice(0, 45)} — ${LABELS[key]}`, job.ownerId);
          project.playlist.tracks[index].name = LABELS[key];
          project.playlist.clips.push(createClip({ kind: 'audio', refId: sample.id, track: index, start: 0, offset: 0,
            length: Math.ceil(job.clip.durationSeconds * bpm * PPQ / 60), rate: 1, gain: 1 }));
        }
        const created = await store.create({ ownerId: job.ownerId, project });
        await store.saveVersion(created.id, job.ownerId, 'Separação original — antes de editar', { source: 'api' });
        job.projectId = created.id; job.status = 'ready'; job.message = 'Quatro stems reais verificados. Abre a DAW para reconstruir o arranjo.';
        job.provenance = { provider: 'MVSEP', model: result.model, processing: 'cloud', completedAt: new Date().toISOString(), paidFallback: false, publiclyListed: false };
        if (await digest(path.join(folder, job.original.file)) !== job.original.sha256) throw new Error('Original hash mismatch');
      } catch (e) { job.status = 'failed'; job.error = safeFailure(e); }
      finally { active = null; await save(job); }
    })();
    res.status(202).json(view(job));
  }));
  r.post('/jobs/:id/open', wrap(async (req, res) => {
    const job = own(req); if (job.status !== 'ready' || !job.projectId) throw httpError(409, 'Ainda não existem quatro stems validados.');
    await store.getOwned(job.projectId, req.user.id);
    await users.update(req.user.id, { activeProjectId: job.projectId });
    res.json({ projectId: job.projectId, url: '/' });
  }));
  r.post('/jobs/:id/render', wrap(async (req, res) => {
    requireIdle(); const job = own(req);
    if (job.status !== 'ready') throw httpError(409, 'A separação ainda não foi validada.');
    const project = structuredClone(await store.getOwned(job.projectId, req.user.id));
    const files = new Map();
    for (const clip of project.playlist.clips.filter((clip) => clip.kind === 'audio')) files.set(clip.refId, await samples.ensureFile(clip.refId, req.user.id));
    requireIdle(); active = job.id; job.renderStatus = 'rendering'; job.renderError = null; await save(job);
    void (async () => {
      try {
        const file = `edited-${crypto.randomUUID()}.wav`;
        const rendered = await audio.renderArrangement({ project, samples: files, outputPath: path.join(dir, job.id, file), ffmpegPath: options.ffmpegPath });
        job.edited = { file, revision: project.rev, sha256: await digest(path.join(dir, job.id, file)), createdAt: new Date().toISOString(),
          durationSeconds: rendered.durationSeconds, gain: rendered.outputGain, gainDb: rendered.outputGainDb, processing: 'cloud' };
        job.renderStatus = 'ready';
      } catch (e) { job.renderStatus = 'failed'; job.renderError = safeFailure(e); }
      finally { active = null; await save(job); }
    })();
    res.status(202).json(view(job));
  }));
  r.get('/jobs/:id/files/:file', wrap(async (req, res) => {
    const job = own(req); const file = req.params.file;
    const allowed = [job.original.file, ...(job.clip ? ['source.wav'] : []), ...(job.status === 'ready' ? job.stems.map((stem) => `${stem.key}.wav`) : []), ...(job.edited ? [job.edited.file] : [])];
    if (!allowed.includes(file)) throw httpError(404, 'Ficheiro não disponível.');
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(MIME[path.extname(file)] || 'audio/wav');
    res.sendFile(path.join(dir, job.id, file));
  }));
  r.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
    res.status(status).json({ error: err.status && err.status < 500 ? err.message : safeFailure(err) });
  });
  return r;
}
