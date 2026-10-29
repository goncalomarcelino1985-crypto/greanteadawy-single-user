// REST API (/api). Every route below requires a signed-in user (session cookie or API token)
// and only ever touches that user's projects, samples and exports.
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { TEMPLATES, describeInstruments, describeEffects, projectToMidi, summarizeProject, uid } from '@greanteadawy/core';
import { meta } from './store.js';
import { createLocalBackend, exportsDir, exportFilePath, EXPORT_NAME, safeFileName, activeProjectId, defaultFfmpeg } from './backend.js';

/** Work the server can ask a browser tab to do (see hub.requestJob and client/src/lib/jobs.js). */
export const JOB_KINDS = ['render', 'analyze-sample', 'sound', 'export-stems', 'spatial', 'generator', 'sample-edit'];
import { VERSION } from './mcp/tools.js';
import { describeSample } from './samples.js';
import { httpError, wrap } from './errors.js';
import { workletModule } from './plugins.js';

/** Routes that may carry big JSON bodies (project edits and imports); parsed after authentication. */
export function isLargeBodyRoute(req) {
  return req.method === 'POST' && (req.path === '/projects' || /^\/projects\/[\w-]+\/ops$/.test(req.path));
}
const largeJson = express.json({ limit: '20mb' });

export function createApiRouter({ store, samples, users, hub, auth, config, publicUrl, ffmpeg = defaultFfmpeg(), plugins = null, cloud = null }) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });
  // rendered mixdowns can be large: stream them to a temp file in the user's exports folder instead of memory
  const renderUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = exportsDir(store.dataDir, req.user.id);
        fs.mkdir(dir, { recursive: true }).then(() => cb(null, dir), cb);
      },
      filename: (req, file, cb) => cb(null, `.upload-${uid('up')}.part`)
    }),
    // the WAV (RIFF) format's own limit: long multichannel spatial renders get big (7.1.4 ≈ 100 MB per minute)
    limits: { fileSize: (config.storageMode === 'cloud' ? 50 : 4095) * 1024 * 1024, files: 1, fieldSize: 2 * 1024 * 1024 }
  });
  const pluginsAllowed = () => !!plugins && config.pluginsEnabled !== false && users.settings.allowPlugins !== false;
  const backendFor = (user) => createLocalBackend({ store, samples, users, hub, user, publicUrl, ffmpeg, plugins, pluginsAllowed, cloud });
  const pluginUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

  r.get('/health', (req, res) => res.json({ ok: true }));
  r.use(auth.requireUser);

  r.get('/status', wrap(async (req, res) => {
    res.json({ activeProjectId: await activeProjectId(store, users, req.user), user: req.user.username, ...hub.status(req.user.id), version: VERSION, maxUploadMb: config.maxUploadMb });
  }));
  r.get('/catalog', (req, res) => res.json({ instruments: describeInstruments(), effects: describeEffects(), templates: TEMPLATES }));
  r.get('/templates', (req, res) => res.json(TEMPLATES));

  // ---- projects
  const owned = (req) => store.getOwned(req.params.id, req.user.id);

  r.get('/projects', wrap(async (req, res) => res.json(await store.list(req.user.id))));
  r.post('/projects', largeJson, wrap(async (req, res) => {
    const { name, bpm, key, template, project } = req.body || {};
    if (template && !TEMPLATES[template]) throw httpError(400, `Unknown template "${template}"`);
    const p = await store.create({ ownerId: req.user.id, name, bpm, key, template, project });
    res.status(201).json(p);
  }));
  r.get('/projects/:id', wrap(async (req, res) => res.json(await owned(req))));
  r.get('/projects/:id/meta', wrap(async (req, res) => res.json(meta(await owned(req)))));
  r.get('/projects/:id/summary', wrap(async (req, res) => res.type('text/plain').send(summarizeProject(await owned(req)))));
  r.delete('/projects/:id', wrap(async (req, res) => {
    await owned(req);
    if ((await store.list(req.user.id)).length <= 1) throw httpError(400, "You can't delete your only project — create another one first");
    await store.remove(req.params.id);
    res.json({ ok: true });
  }));
  r.post('/projects/:id/duplicate', wrap(async (req, res) => {
    res.status(201).json(await store.duplicate(req.params.id, req.user.id, req.body?.name));
  }));
  r.post('/projects/:id/ops', largeJson, wrap(async (req, res) => {
    const source = req.body?.source === 'mcp' ? 'mcp' : 'api';
    const p = await store.applyOps(req.params.id, req.body?.ops, { source, clientId: req.body?.clientId, userId: req.user.id, undoable: source === 'mcp', operationId: req.body?.operationId });
    res.json({ rev: p.rev, project: p });
  }));
  r.post('/projects/:id/undo', wrap(async (req, res) => {
    res.json(await store.undoLast(req.params.id, req.user.id, { force: !!req.body?.force }));
  }));
  r.get('/projects/:id/versions', wrap(async (req, res) => res.json(await store.listVersions(req.params.id, req.user.id))));
  r.post('/projects/:id/versions', wrap(async (req, res) => {
    const source = req.body?.source === 'mcp' ? 'mcp' : 'api';
    res.status(201).json(await store.saveVersion(req.params.id, req.user.id, req.body?.name, { source }));
  }));
  r.post('/projects/:id/versions/:vid/restore', wrap(async (req, res) => {
    const source = req.body?.source === 'mcp' ? 'mcp' : 'api';
    const p = await store.restoreVersion(req.params.id, req.user.id, req.params.vid, { source, undoable: source === 'mcp' });
    res.json({ rev: p.rev, project: p });
  }));
  r.delete('/projects/:id/versions/:vid', wrap(async (req, res) => {
    await store.deleteVersion(req.params.id, req.user.id, req.params.vid);
    res.json({ ok: true });
  }));
  r.get('/projects/:id/export', wrap(async (req, res) => {
    const p = await owned(req);
    const { ownerId: _ownerId, ...data } = p; // portable: no account ids in exported files
    res.setHeader('content-disposition', `attachment; filename="${safeFileName(p.name)}.gtd.json"`);
    res.json(data);
  }));
  r.get('/projects/:id/midi', wrap(async (req, res) => {
    const p = await owned(req);
    const bytes = projectToMidi(p, { mode: req.query.mode === 'pattern' ? 'pattern' : 'song', patternId: req.query.patternId });
    res.setHeader('content-type', 'audio/midi');
    res.setHeader('content-disposition', `attachment; filename="${safeFileName(p.name)}.mid"`);
    res.send(Buffer.from(bytes));
  }));
  r.post('/projects/:id/export-midi', wrap(async (req, res) => {
    const out = await backendFor(req.user).exportMidi(req.params.id, { mode: req.body?.mode, patternId: req.body?.patternId });
    delete out.path; // never reveal server file paths over HTTP
    res.json(out);
  }));

  r.get('/active', wrap(async (req, res) => res.json({ projectId: await activeProjectId(store, users, req.user) })));
  r.put('/active', wrap(async (req, res) => {
    await store.getOwned(req.body?.projectId, req.user.id);
    await users.update(req.user.id, { activeProjectId: req.body.projectId });
    res.json({ projectId: req.body.projectId });
  }));

  // Used by the stdio MCP bridge to reach the user's browsers through this server
  r.post('/broadcast', wrap(async (req, res) => {
    const { type, projectId, command } = req.body || {};
    await store.getOwned(projectId, req.user.id);
    if (type === 'transport') return res.json({ delivered: hub.transport(req.user.id, projectId, command || {}) });
    if (type === 'open') return res.json({ delivered: hub.openProject(req.user.id, projectId) });
    throw httpError(400, 'Unknown broadcast type');
  }));

  // ---- browser jobs (render / analyse). POST /jobs waits for the browser's result.
  r.post('/jobs', wrap(async (req, res) => {
    const { job, projectId, timeoutMs } = req.body || {};
    if (!job || !JOB_KINDS.includes(job.kind)) throw httpError(400, 'Unknown job');
    if (projectId) await store.getOwned(projectId, req.user.id);
    res.json(await hub.requestJob(req.user.id, job, { projectId, timeoutMs: Math.min(job.kind === 'export-stems' ? 1800000 : job.kind === 'spatial' ? 900000 : 300000, timeoutMs || 120000) }));
  }));
  // check the job before accepting a (possibly large) upload
  const jobExists = (req, res, next) => (hub.getJob(req.params.id, req.user.id) ? next() : next(httpError(404, 'Job not found or already finished')));
  /**
   * Give an uploaded render (`.part` in the user's exports folder) its final name: `<safe base>[-<stamp>][-n].wav`.
   * The name is reserved with an exclusive create (fails if it exists) and the upload renamed over the placeholder,
   * so two uploads can never take the same name — without hard links, which some filesystems don't support.
   */
  async function saveRender(req, baseName, { stamp = false } = {}) {
    const part = req.file.path;
    const head = Buffer.alloc(12);
    const fh = await fs.open(part, 'r');
    try { await fh.read(head, 0, 12, 0); } finally { await fh.close(); }
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw httpError(400, 'Rendered file must be a WAV');
    const dir = path.dirname(part);
    const base = `${safeFileName(baseName)}${stamp ? `-${stampNow()}` : ''}`;
    for (let i = 1; i < 1000; i++) {
      const name = `${base}${i > 1 ? `-${i}` : ''}.wav`;
      const dest = path.join(dir, name);
      if (cloud && await cloud.fileExists(dest)) continue;
      try {
        await (await fs.open(dest, 'wx')).close();
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      try {
        await fs.rename(part, dest);
      } catch (e) {
        await fs.rm(dest, { force: true }).catch(() => {});
        throw e;
      }
      return { name, bytes: req.file.size, url: `${publicUrl || ''}/api/exports/${encodeURIComponent(name)}` };
    }
    throw httpError(409, 'Too many exports with that name');
  }
  const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  /** Validate a spatial job's object positions and store them as `<name>-positions[-n].json` in the exports. */
  async function savePositions(req, baseName, raw) {
    const fin = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.objects) || raw.objects.length > 64) throw httpError(400, 'Invalid positions');
    let blocks = 0;
    const objects = raw.objects.map((o) => {
      if (!o || !Array.isArray(o.blocks)) throw httpError(400, 'Invalid positions');
      blocks += o.blocks.length;
      if (blocks > 100000) throw httpError(400, 'Too many position blocks');
      return {
        name: String(o.name ?? '').slice(0, 64), insert: Math.round(fin(o.insert, 0, 999)),
        blocks: o.blocks.map((b) => ({ start: fin(b?.start, 0, 86400), duration: fin(b?.duration, 0, 86400), x: fin(b?.x, -1, 1), y: fin(b?.y, -1, 1), z: fin(b?.z, 0, 1) }))
      };
    });
    const doc = {
      title: String(raw.title ?? '').slice(0, 100), sampleRate: Math.round(fin(raw.sampleRate, 8000, 192000)), seconds: fin(raw.seconds, 0, 86400),
      coordinates: 'x -1 left…1 right, y -1 back…1 front, z 0 ear…1 ceiling (ADM Cartesian); times in seconds', bed: 'stereo (L/R)', objects
    };
    const dir = exportsDir(store.dataDir, req.user.id);
    await fs.mkdir(dir, { recursive: true });
    const base = `${safeFileName(baseName)}-positions`;
    for (let i = 1; i < 1000; i++) {
      const name = `${base}${i > 1 ? `-${i}` : ''}.json`;
      if (cloud && await cloud.fileExists(path.join(dir, name))) continue;
      try {
        const fh = await fs.open(path.join(dir, name), 'wx');
        try { await fh.writeFile(JSON.stringify(doc, null, 1)); } finally { await fh.close(); }
        const { size } = await fs.stat(path.join(dir, name));
        return { name, bytes: size, url: `${publicUrl || ''}/api/exports/${encodeURIComponent(name)}` };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw httpError(409, 'Too many exports with that name');
  }

  r.post('/jobs/:id/result', jobExists, renderUpload.single('file'), wrap(async (req, res) => {
    const part = req.file?.path;
    try {
      const job = hub.getJob(req.params.id, req.user.id);
      if (!job) throw httpError(404, 'Job not found or already finished');
      let result;
      try { result = JSON.parse(req.body?.result || '{}'); } catch { throw httpError(400, 'result must be JSON'); }
      const exported = part ? await saveRender(req, req.body?.name || 'mixdown', { stamp: true }) : null;
      // spatial object exports: the positions over time, written by the server (never a file from the browser)
      const positionsFile = job.kind === 'spatial' && result.positions ? await savePositions(req, req.body?.name || 'spatial', result.positions) : null;
      delete result.positions;
      hub.finishJob(req.params.id, { ...result, export: exported, positionsFile });
      res.json({ ok: true, export: exported });
    } finally {
      if (part) await fs.rm(part, { force: true }).catch(() => {}); // no-op once renamed
    }
  }));

  // extra files of a running job (one stem per request, so the browser never holds them all at once)
  r.post('/jobs/:id/files', jobExists, renderUpload.single('file'), wrap(async (req, res) => {
    const part = req.file?.path;
    try {
      const job = hub.getJob(req.params.id, req.user.id);
      if (!job) throw httpError(404, 'Job not found or already finished');
      if (job.kind !== 'export-stems' && job.kind !== 'spatial') throw httpError(400, 'This job does not take files');
      if (!part) throw httpError(400, 'Missing "file" field');
      const exported = await saveRender(req, req.body?.name || `stem-${stampNow()}`);
      hub.jobFile(req.params.id, exported);
      res.json({ ok: true, export: exported });
    } finally {
      if (part) await fs.rm(part, { force: true }).catch(() => {});
    }
  }));

  // ---- plugins (per user; installing/changing them needs a signed-in browser, not an API token)
  // plugin uploads are held in memory and unpacked synchronously: only a few at a time server-wide (others get 429)
  function limitInflight(max) {
    let n = 0;
    return (req, res, next) => {
      if (n >= max) return next(httpError(429, 'The server is checking other plugins right now — try again in a moment'));
      n++;
      let done = false;
      const end = () => { if (!done) { done = true; n--; } };
      res.on('finish', end);
      res.on('close', end);
      next();
    };
  }
  // the user's other tabs reload their plugin list (and the audio engine picks the change up)
  const pluginsChanged = (userId) => hub.toUser?.(userId, { type: 'plugins-changed' });
  const needPlugins = (req, res, next) => (pluginsAllowed() ? next() : next(httpError(403, 'Plugins are turned off on this server (an admin can allow them in Settings → Server)')));
  const servePlugin = async (req) => {
    if (!pluginsAllowed()) throw httpError(403, 'Plugins are turned off on this server');
    return plugins.requireEnabled(req.user.id, req.params.id);
  };
  r.get('/plugins', wrap(async (req, res) => res.json(await backendFor(req.user).listPlugins())));
  r.post('/plugins/inspect', auth.requireSession, needPlugins, limitInflight(4), pluginUpload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw httpError(400, 'Missing "file" field (a .zip)');
    res.json(await plugins.inspect(req.user.id, req.file.buffer));
  }));
  r.post('/plugins/install', auth.requireSession, needPlugins, wrap(async (req, res) => {
    const { token, trust } = req.body || {};
    if (trust !== true) throw httpError(400, 'Confirm that you trust this plugin\'s author to install it');
    if (typeof token !== 'string') throw httpError(400, 'token is required');
    const entry = await plugins.install(req.user.id, token);
    hub.pushActivity?.(req.user.id, { source: 'plugins', text: `Installed plugin ${entry.name} ${entry.version}` });
    pluginsChanged(req.user.id);
    res.status(201).json(entry);
  }));
  r.patch('/plugins/:id', auth.requireSession, wrap(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw httpError(400, 'enabled (true/false) is required');
    const entry = await plugins.setEnabled(req.user.id, req.params.id, req.body.enabled);
    pluginsChanged(req.user.id);
    res.json(entry);
  }));
  r.delete('/plugins/:id', auth.requireSession, wrap(async (req, res) => {
    await plugins.remove(req.user.id, req.params.id);
    pluginsChanged(req.user.id);
    res.json({ ok: true });
  }));
  const pluginHeaders = (res) => {
    res.set('Cache-Control', 'private, no-cache');
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
  };
  // DSP code, wrapped in the worklet-only harness (loaded with audioWorklet.addModule)
  r.get('/plugins/:id/worklet.js', wrap(async (req, res) => {
    const entry = await servePlugin(req);
    if (entry.type === 'generator' || !entry.manifest.main) throw httpError(404, 'This plugin has no audio code');
    pluginHeaders(res);
    res.type('application/javascript').send(workletModule(entry.manifest, await plugins.code(req.user.id, entry), entry.sha256));
  }));
  // generator code as plain text: it only ever runs inside the sandboxed iframe's worker
  r.get('/plugins/:id/code', wrap(async (req, res) => {
    const entry = await servePlugin(req);
    if (entry.type !== 'generator') throw httpError(404, 'Not a generator');
    pluginHeaders(res);
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type('text/plain').send(await plugins.code(req.user.id, entry));
  }));
  r.get('/plugins/:id/samples/*file', wrap(async (req, res) => {
    const entry = await servePlugin(req);
    const rel = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file || '');
    const { data, mime } = await plugins.sample(req.user.id, entry, rel);
    pluginHeaders(res);
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(mime).send(data);
  }));

  // ---- system: optional tools the server can use
  r.get('/system/ffmpeg', wrap(async (req, res) => res.json(await backendFor(req.user).exportFormats())));
  r.post('/system/ffmpeg/refresh', auth.requireAdmin, wrap(async (req, res) => res.json(await backendFor(req.user).exportFormats({ refresh: true }))));

  // ---- exports (rendered WAVs, converted MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF, MIDI files)
  const exportPath = (req) => exportFilePath(store.dataDir, req.user.id, req.params.name);
  r.get('/exports/formats', wrap(async (req, res) => res.json(await backendFor(req.user).exportFormats())));
  r.get('/exports', wrap(async (req, res) => {
    const dir = exportsDir(store.dataDir, req.user.id);
    if (cloud) {
      const out = (await cloud.listFiles(dir)).filter((file) => EXPORT_NAME.test(file.name))
        .map((file) => ({ ...file, url: `/api/exports/${encodeURIComponent(file.name)}` }));
      return res.json(out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    }
    let files = [];
    try { files = await fs.readdir(dir); } catch { /* none yet */ }
    const out = [];
    for (const f of files.filter((x) => EXPORT_NAME.test(x))) {
      const st = await fs.stat(path.join(dir, f));
      out.push({ name: f, bytes: st.size, createdAt: st.mtime.toISOString(), url: `/api/exports/${encodeURIComponent(f)}` });
    }
    res.json(out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }));
  // a WAV rendered in the browser (e.g. stems from the File menu) saved into the user's exports
  r.post('/exports', renderUpload.single('file'), wrap(async (req, res) => {
    const part = req.file?.path;
    try {
      if (!part) throw httpError(400, 'Missing "file" field');
      res.status(201).json({ ok: true, export: await saveRender(req, req.body?.name || `export-${stampNow()}`) });
    } finally {
      if (part) await fs.rm(part, { force: true }).catch(() => {});
    }
  }));
  // convert a WAV export with ffmpeg: { format, bitrate?, metadata?: { title, artist, album, genre, date, comment } }
  r.post('/exports/:name/convert', wrap(async (req, res) => {
    const { format, bitrate, metadata } = req.body || {};
    if (typeof format !== 'string') throw httpError(400, 'format is required');
    if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) throw httpError(400, 'metadata must be an object');
    res.status(201).json({ ok: true, export: await backendFor(req.user).convertExport(req.params.name, { format, bitrate, metadata }) });
  }));
  r.get('/exports/:name', wrap(async (req, res) => {
    const file = exportPath(req);
    if (cloud) await cloud.ensureFile(file);
    try { await fs.access(file); } catch { throw httpError(404, 'Export not found'); }
    res.download(file);
  }));
  r.delete('/exports/:name', wrap(async (req, res) => {
    await backendFor(req.user).deleteExport(req.params.name);
    res.json({ ok: true });
  }));

  // ---- samples
  r.get('/samples', (req, res) => res.json(samples.list(req.user.id)));
  r.post('/samples', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw httpError(400, 'Missing "file" field');
    const { folderId, name } = req.body || {};
    const item = await samples.add({ buffer: req.file.buffer, originalName: req.file.originalname, mime: req.file.mimetype, ownerId: req.user.id, folderId: folderId || null, name });
    res.status(201).json(item);
  }));
  // folders (declared before /samples/:id so "folders" is never read as a sample id)
  r.get('/samples/folders', (req, res) => res.json(samples.listFolders(req.user.id)));
  r.post('/samples/folders', wrap(async (req, res) => res.status(201).json(await samples.addFolder(req.user.id, req.body?.name))));
  r.patch('/samples/folders/:fid', wrap(async (req, res) => res.json(await samples.renameFolder(req.params.fid, req.user.id, req.body?.name))));
  r.delete('/samples/folders/:fid', wrap(async (req, res) => res.json({ ok: true, unfiled: await samples.removeFolder(req.params.fid, req.user.id) })));
  r.post('/samples/move', wrap(async (req, res) => res.json({ ok: true, moved: await samples.move(req.body?.ids, req.user.id, req.body?.folderId ?? null) })));
  r.post('/samples/delete', wrap(async (req, res) => res.json({ ok: true, deleted: await samples.removeMany(req.body?.ids, req.user.id) })));
  r.post('/samples/usage', wrap(async (req, res) => res.json(await samples.usage(store, req.body?.ids, req.user.id))));
  r.get('/samples/:id', (req, res, next) => {
    try { res.json(samples.get(req.params.id, req.user.id)); } catch (e) { next(e); }
  });
  r.get('/samples/:id/info', (req, res, next) => {
    try {
      const s = samples.get(req.params.id, req.user.id);
      res.json(describeSample(s, samples.folderNameOf(s.folderId, req.user.id)));
    } catch (e) { next(e); }
  });
  r.get('/samples/:id/file', wrap(async (req, res) => {
      const s = samples.get(req.params.id, req.user.id);
      const file = await samples.ensureFile(req.params.id, req.user.id);
      // immutable only for the current revision's URL: anything else (no ?v, an old one) is revalidated, so a
      // request racing a replacement can't pin new audio under an old revision's URL (or the other way round)
      res.setHeader('cache-control', req.query.v === String(s.rev || 1) ? 'private, max-age=31536000, immutable' : 'private, no-cache');
      res.setHeader('content-security-policy', "default-src 'none'; sandbox");
      res.type(samples.mimeOf(req.params.id, req.user.id));
      res.sendFile(file);
  }));
  // new audio for an existing sample (the wave editor's "Replace original"): every project using it hears the change
  // the sample must be the caller's before a (possibly large) upload is read
  const ownSample = (req, res, next) => { try { samples.get(req.params.id, req.user.id); next(); } catch (e) { next(e); } };
  r.put('/samples/:id/file', ownSample, upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw httpError(400, 'Missing "file" field');
    res.json(await samples.replaceFile(req.params.id, req.user.id, { buffer: req.file.buffer, originalName: req.file.originalname, mime: req.file.mimetype }));
  }));
  r.patch('/samples/:id', wrap(async (req, res) => res.json(await samples.update(req.params.id, req.user.id, req.body || {}))));
  r.delete('/samples/:id', wrap(async (req, res) => {
    await samples.remove(req.params.id, req.user.id);
    res.json({ ok: true });
  }));

  return r;
}

/** JSON 404 + error handler for /api. */
export function apiErrorHandlers(router) {
  router.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const status = err.status
      || (err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large' ? 413
        : err.name === 'MulterError' || err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error('[api]', err);
    // messages are shown for our own errors (4xx, and 502–504 gateway/timeouts we raised); unexpected errors stay generic
    const expose = status < 500 || (err.status >= 502 && err.status <= 504 && err.message);
    res.status(status).json({ error: expose ? err.message || 'Bad request' : 'Server error' });
  });
  return router;
}
