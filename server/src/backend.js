// "Backend" = the interface MCP tools use to read/modify one user's studio.
//  - createLocalBackend: in-process (HTTP MCP endpoint, or stdio fallback when the web server isn't running)
//  - createRemoteBackend: talks to a running GreanTeaDawy server over HTTP (stdio MCP -> live browser sync)
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { projectToMidi } from '@greanteadawy/core';
import { describeSample } from './samples.js';
import { httpError } from './errors.js';
import { writeFileAtomic } from './fsutil.js';
import { createFfmpeg, EXPORT_EXTENSIONS } from './ffmpeg.js';

export function safeFileName(s) {
  return String(s).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'project';
}

export function exportsDir(dataDir, userId) {
  if (!/^[\w-]+$/.test(String(userId))) throw httpError(400, 'Invalid user');
  return path.join(dataDir, 'exports', userId);
}

/** File names allowed in an exports folder: renders in any export format, MIDI files and spatial position data (JSON). */
export const EXPORT_NAME = new RegExp(`^(?!\\.)[\\w.-]+\\.(${[...EXPORT_EXTENSIONS, 'mid', 'json'].join('|')})$`);

export function exportFilePath(dataDir, userId, name) {
  const n = String(name || '');
  if (!EXPORT_NAME.test(n) || n.length > 200) throw httpError(400, 'Invalid file name');
  return path.join(exportsDir(dataDir, userId), n);
}

let sharedFfmpeg = null;
/** The ffmpeg used when a caller doesn't pass one (stdio MCP, tests): FFMPEG_PATH or the PATH. */
export function defaultFfmpeg() {
  sharedFfmpeg ??= createFfmpeg({ path: process.env.FFMPEG_PATH || '' });
  return sharedFfmpeg;
}

/** The user's active project (falls back to their most recently edited project). */
export async function activeProjectId(store, users, user) {
  const u = users.get(user.id) || user;
  if (u.activeProjectId && (await store.exists(u.activeProjectId, u.id))) return u.activeProjectId;
  const list = await store.list(u.id);
  return list[0]?.id || null;
}

export function createLocalBackend({ store, samples, users, hub = null, user, publicUrl = null, ffmpeg = defaultFfmpeg(), plugins = null, pluginsAllowed = () => true }) {
  if (!user) throw new Error('createLocalBackend needs a user');
  const uidOf = user.id;
  const live = !!hub;
  const urlFor = (p) => (publicUrl ? `${publicUrl}${p}` : null);

  return {
    kind: live ? 'server' : 'standalone',
    user: { id: user.id, username: user.username, displayName: user.displayName },
    listProjects: () => store.list(uidOf),
    getProject: (id) => store.getOwned(id, uidOf),
    createProject: (opts) => store.create({ ...opts, ownerId: uidOf }),
    deleteProject: async (id) => {
      await store.getOwned(id, uidOf);
      if ((await store.list(uidOf)).length <= 1) throw httpError(400, "Can't delete the user's only project — create another one first");
      await store.remove(id);
    },
    duplicateProject: (id, name) => store.duplicate(id, uidOf, name),
    applyOps: (id, ops) => store.applyOps(id, ops, { source: 'mcp', userId: uidOf, undoable: true }),
    undo: async (id, { force = false } = {}) => store.undoLast(id, uidOf, { force }),
    saveVersion: (id, name) => store.saveVersion(id, uidOf, name, { source: 'mcp' }),
    listVersions: (id) => store.listVersions(id, uidOf),
    restoreVersion: (id, versionId) => store.restoreVersion(id, uidOf, versionId, { source: 'mcp', undoable: true }),
    getActiveId: () => activeProjectId(store, users, user),
    setActive: async (id) => {
      await store.getOwned(id, uidOf);
      await users.update(uidOf, { activeProjectId: id });
    },
    listSamples: async () => samples.list(uidOf),
    getSample: async (id) => samples.get(id, uidOf),
    updateSample: (id, patch) => samples.update(id, uidOf, patch),
    deleteSample: (id) => samples.remove(id, uidOf),
    deleteSamples: (ids) => samples.removeMany(ids, uidOf),
    moveSamples: (ids, folderId) => samples.move(ids, uidOf, folderId),
    sampleUsage: (ids) => samples.usage(store, ids, uidOf),
    listSampleFolders: async () => samples.listFolders(uidOf),
    createSampleFolder: (name) => samples.addFolder(uidOf, name),
    renameSampleFolder: (id, name) => samples.renameFolder(id, uidOf, name),
    deleteSampleFolder: (id) => samples.removeFolder(id, uidOf),
    transport: async (id, cmd) => (hub ? hub.transport(uidOf, id, cmd) : 0),
    openProject: async (id) => (hub ? hub.openProject(uidOf, id) : 0),
    status: async () => ({
      mode: live ? 'server' : 'standalone (web server not running: edits are saved to disk but not live, rendering is unavailable)',
      user: user.username,
      ...(hub ? hub.status(uidOf) : { browsers: 0 }),
      url: publicUrl
    }),
    /** Run render/analysis in the user's browser (see Hub.requestJob). */
    requestJob: async (job, opts = {}) => {
      if (!hub) throw httpError(409, 'Rendering and analysis need the GreanTeaDawy web server running with the studio open in a browser.');
      return hub.requestJob(uidOf, job, opts);
    },
    async exportMidi(id, opts = {}) {
      const p = await store.getOwned(id, uidOf);
      const bytes = projectToMidi(p, opts);
      const dir = exportsDir(store.dataDir, uidOf);
      await fs.mkdir(dir, { recursive: true });
      const name = `${safeFileName(p.name)}${opts.mode === 'pattern' ? '-pattern' : ''}.mid`;
      await writeFileAtomic(path.join(dir, name), bytes);
      hub?.pushActivity(uidOf, { source: 'mcp', projectId: id, text: `Exported MIDI ${name}` });
      return { path: path.join(dir, name), name, url: urlFor(`/api/exports/${encodeURIComponent(name)}`), bytes: bytes.length };
    },
    /** ffmpeg availability and every export format (with bitrates and whether it can be made now). */
    async exportFormats({ refresh = false } = {}) {
      const st = await ffmpeg.status({ refresh });
      return { ffmpeg: { available: st.available, version: st.version || null, reason: st.reason || null, checkedAt: st.checkedAt }, formats: await ffmpeg.formats() };
    },
    /** Convert a WAV in the user's exports into another format (next to it, under a fresh name). */
    async convertExport(name, { format, bitrate, metadata } = {}) {
      const input = exportFilePath(store.dataDir, uidOf, name);
      if (!/\.wav$/i.test(name)) throw httpError(400, 'Only WAV exports can be converted');
      try { await fs.access(input); } catch { throw httpError(404, `Export "${name}" not found`); }
      const out = await ffmpeg.convert({ input, format, bitrate, owner: user.id, metadata: { artist: user.displayName || user.username, ...metadata } });
      hub?.pushActivity(uidOf, { source: 'export', text: `Converted ${name} to ${out.name}` });
      return { name: out.name, bytes: out.bytes, format: out.format, encoder: out.encoder, bitrate: out.bitrate ?? null, bitDepth: out.bitDepth ?? null, url: `${publicUrl || ''}/api/exports/${encodeURIComponent(out.name)}` };
    },
    async deleteExport(name) {
      await fs.rm(exportFilePath(store.dataDir, uidOf, name), { force: true });
    },
    /** The user's installed plugins ({ allowed, plugins: [...] }); plugins can only be installed from the studio. */
    async listPlugins() {
      return { allowed: !!plugins && pluginsAllowed(), plugins: plugins ? await plugins.list(uidOf) : [] };
    },
    describeSample
  };
}

export function createRemoteBackend(baseUrl, { token = '' } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  const auth = token ? { authorization: `Bearer ${token}` } : {};
  async function call(method, url, body, { timeoutMs } = {}) {
    const headers = { ...auth, ...(body ? { 'content-type': 'application/json' } : {}) };
    // fetch gives up waiting for response headers after 5 minutes; browser jobs such as a stem export can take longer
    const res = timeoutMs > 240000
      ? await longRequest(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined, timeoutMs: timeoutMs + 30000 })
      : await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) {
      const msg = res.status === 401
        ? `${data?.error || 'Unauthorized'} — set GREANTEADAWY_TOKEN to your personal API token (Studio → Settings → API & MCP)`
        : data?.error || `HTTP ${res.status}`;
      throw httpError(res.status, msg);
    }
    return data;
  }
  const e = encodeURIComponent;
  return {
    kind: 'remote',
    listProjects: () => call('GET', '/api/projects'),
    getProject: (id) => call('GET', `/api/projects/${e(id)}`),
    createProject: (opts) => call('POST', '/api/projects', opts),
    deleteProject: (id) => call('DELETE', `/api/projects/${e(id)}`),
    duplicateProject: (id, name) => call('POST', `/api/projects/${e(id)}/duplicate`, { name }),
    applyOps: async (id, ops) => (await call('POST', `/api/projects/${e(id)}/ops`, { ops, source: 'mcp' })).project,
    undo: (id, opts = {}) => call('POST', `/api/projects/${e(id)}/undo`, opts),
    saveVersion: (id, name) => call('POST', `/api/projects/${e(id)}/versions`, { name, source: 'mcp' }),
    listVersions: (id) => call('GET', `/api/projects/${e(id)}/versions`),
    restoreVersion: (id, versionId) => call('POST', `/api/projects/${e(id)}/versions/${e(versionId)}/restore`, { source: 'mcp' }),
    getActiveId: async () => (await call('GET', '/api/active')).projectId,
    setActive: (id) => call('PUT', '/api/active', { projectId: id }),
    listSamples: () => call('GET', '/api/samples'),
    getSample: (id) => call('GET', `/api/samples/${e(id)}`),
    updateSample: (id, patch) => call('PATCH', `/api/samples/${e(id)}`, patch),
    deleteSample: (id) => call('DELETE', `/api/samples/${e(id)}`),
    deleteSamples: async (ids) => (await call('POST', '/api/samples/delete', { ids })).deleted,
    moveSamples: async (ids, folderId) => (await call('POST', '/api/samples/move', { ids, folderId })).moved,
    sampleUsage: (ids) => call('POST', '/api/samples/usage', { ids }),
    listSampleFolders: () => call('GET', '/api/samples/folders'),
    createSampleFolder: (name) => call('POST', '/api/samples/folders', { name }),
    renameSampleFolder: (id, name) => call('PATCH', `/api/samples/folders/${e(id)}`, { name }),
    deleteSampleFolder: async (id) => (await call('DELETE', `/api/samples/folders/${e(id)}`)).unfiled,
    transport: async (id, cmd) => (await call('POST', '/api/broadcast', { type: 'transport', projectId: id, command: cmd })).delivered,
    openProject: async (id) => (await call('POST', '/api/broadcast', { type: 'open', projectId: id })).delivered,
    status: async () => ({ ...(await call('GET', '/api/status')), url: base }),
    requestJob: (job, opts = {}) => call('POST', '/api/jobs', { job, projectId: opts.projectId, timeoutMs: opts.timeoutMs }, { timeoutMs: opts.timeoutMs }),
    exportMidi: (id, opts = {}) => call('POST', `/api/projects/${e(id)}/export-midi`, opts),
    exportFormats: () => call('GET', '/api/exports/formats'),
    convertExport: async (name, opts = {}) => (await call('POST', `/api/exports/${e(name)}/convert`, opts, { timeoutMs: 600000 })).export,
    deleteExport: (name) => call('DELETE', `/api/exports/${e(name)}`),
    listPlugins: () => call('GET', '/api/plugins'),
    describeSample
  };
}

/** Minimal fetch-like request without fetch's 5-minute header timeout: resolves to { ok, status, text() }. */
function longRequest(url, { method, headers, body, timeoutMs }) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text });
      });
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('The server did not answer in time')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
