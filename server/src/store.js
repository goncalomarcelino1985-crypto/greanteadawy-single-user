// File-backed project store. Projects are JSON files in <dataDir>/projects, each owned by one user.
// All edits go through applyOps(); every change emits an 'ops' event used for live sync.
// Also keeps named versions, durable retry receipts and a short persisted undo history of MCP edits.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { applyOps, prepareOps, normalizeProject, createProjectFromTemplate, describeOps, uid } from '@greanteadawy/core';
import { httpError } from './errors.js';
import { writeFileAtomic } from './fsutil.js';

const SAVE_DELAY_MS = 400;
const MAX_VERSIONS = 50;
const MAX_UNDO = 30;
const MAX_RECEIPTS = 512;

function operationId(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[\w:.-]{1,200}$/.test(value)) throw httpError(400, 'Invalid operation id');
  return value;
}

function operationHash(ops) {
  try {
    // Object key order is not part of an operation's identity; generated IDs are fixed only after this hash.
    const json = JSON.stringify(ops, (key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])) : value);
    return crypto.createHash('sha256').update(json).digest('hex');
  } catch {
    throw httpError(400, 'Operations must be JSON serializable');
  }
}


export class ProjectStore extends EventEmitter {
  /**
   * @param {string} dataDir
   * @param {{ saveDelay?: number, cache?: boolean }} opts  cache=false is used by standalone stdio MCP.
   *   saveDelay is retained for compatibility; acknowledged edits are always written immediately.
   */
  constructor(dataDir, { saveDelay = SAVE_DELAY_MS, cache = true } = {}) {
    super();
    this.dataDir = dataDir;
    this.saveDelay = saveDelay;
    this.useCache = cache;
    this.dir = path.join(dataDir, 'projects');
    this.versionsDir = path.join(dataDir, 'versions');
    this.historyDir = path.join(dataDir, 'history');
    this.cache = new Map();
    this.timers = new Map();
    this.locks = new Map(); // projectId -> promise chain (serializes edits + writes)
    this.undo = new Map(); // projectId -> [{ project, revAfter, description, time }]
    this.receipts = new Map(); // projectId -> [{ id, hash, rev, time }] for durable retry deduplication
    this.historyLoaded = new Set();
    // tombstones: deleted ids must never be resurrected by a late read or write (ids are never reused, so this grows
    // by one short string per deleted project)
    this.deleted = new Set();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(this.versionsDir, { recursive: true });
    await fs.mkdir(this.historyDir, { recursive: true });
    return this;
  }

  file(id) {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw httpError(400, 'Invalid project id');
    return path.join(this.dir, `${id}.json`);
  }

  /** Project metadata, newest first. ownerId filters to one user (undefined = all projects). */
  async list(ownerId) {
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const p = await this.get(f.slice(0, -5));
        if (ownerId === undefined || p.ownerId === ownerId) out.push(meta(p));
      } catch (e) {
        if (e.status === 503) throw e; // a damaged history must never look like an empty workspace
        // Skip unrelated/unreadable legacy project files.
      }
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  async get(id) {
    this.file(id); // validates the id before it is used as a cache key
    if (this.deleted.has(id)) throw httpError(404, `Project ${id} not found`);
    if (this.useCache && this.cache.has(id)) {
      const p = this.cache.get(id);
      await this.loadHistory(id, p);
      return p;
    }
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    } catch (e) {
      if (e.status) throw e;
      throw httpError(404, `Project ${id} not found`);
    }
    const p = { ...normalizeProject(raw), ownerId: raw.ownerId || null };
    await this.loadHistory(id, p);
    if (this.deleted.has(id)) throw httpError(404, `Project ${id} not found`); // deleted while reading
    this.cache.set(id, p);
    return p;
  }

  /** Like get(), but 404s unless the project belongs to `ownerId` (never reveals other users' projects). */
  async getOwned(id, ownerId) {
    const p = await this.get(id);
    if (!ownerId || p.ownerId !== ownerId) throw httpError(404, `Project ${id} not found`);
    return p;
  }

  async exists(id, ownerId) {
    try { await this.getOwned(id, ownerId); return true; } catch { return false; }
  }

  async create({ ownerId, name, bpm, key, template = 'default', project } = {}) {
    if (!ownerId) throw new Error('create() needs an ownerId');
    let p;
    if (project) {
      p = normalizeProject({ ...project, id: uid('prj'), rev: 0 });
    } else {
      try {
        p = createProjectFromTemplate(template, { name, bpm, key });
      } catch (e) {
        throw httpError(400, e.message);
      }
    }
    if (name) p.name = String(name).slice(0, 100);
    const now = new Date().toISOString();
    p = { ...p, ownerId, createdAt: now, updatedAt: now };
    await this.writeNow(p.id, { project: p, undo: [], receipts: [] });
    this.publishState(p.id, p, [], []);
    this.emit('list-changed', ownerId);
    return p;
  }

  async duplicate(id, ownerId, name) {
    const src = await this.getOwned(id, ownerId);
    return this.create({ ownerId, project: JSON.parse(JSON.stringify(src)), name: name || `${src.name} (copy)` });
  }

  /** Delete a project and its versions (waits for edits in flight; a late save can't bring it back). */
  remove(id) {
    return this.withLock(id, async () => {
      const p = await this.get(id);
      // Stage removal with reversible renames; only forget the live state after every part has moved.
      const trash = await fs.mkdtemp(path.join(this.dataDir, '.removed-'));
      const moved = [];
      try {
        for (const [from, name] of [[this.file(id), 'project.json'], [this.historyFile(id), 'history.json'], [this.versionDir(id), 'versions']]) {
          const to = path.join(trash, name);
          try { await fs.rename(from, to); moved.push({ from, to }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
      } catch (e) {
        const rollback = await Promise.allSettled(moved.reverse().map(({ from, to }) => fs.rename(to, from)));
        if (rollback.some((r) => r.status === 'rejected')) throw new AggregateError([e, ...rollback.filter((r) => r.status === 'rejected').map((r) => r.reason)], 'Project removal failed and rollback was incomplete');
        await fs.rm(trash, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      this.deleted.add(id);
      this.cache.delete(id);
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.undo.delete(id);
      this.receipts.delete(id);
      this.historyLoaded.delete(id);
      await fs.rm(trash, { recursive: true, force: true }).catch(() => {});
      this.emit('list-changed', p.ownerId);
    });
  }

  /** Assign projects without an owner (created before accounts existed) to a user. */
  async claimOrphans(ownerId) {
    let n = 0;
    for (const f of (await fs.readdir(this.dir)).filter((x) => x.endsWith('.json'))) {
      const id = f.slice(0, -5);
      try {
        const p = await this.get(id);
        if (!p.ownerId) {
          const after = { ...p, ownerId };
          const undo = (this.undo.get(id) || []).map((entry) => ({ ...entry, project: { ...entry.project, ownerId } }));
          const receipts = this.receipts.get(id) || [];
          await this.writeNow(id, { project: after, undo, receipts });
          this.publishState(id, after, undo, receipts);
          n++;
        }
      } catch (e) { if (e.status === 503) throw e; }
    }
    if (n) this.emit('list-changed', ownerId);
    return n;
  }

  /** Run fn exclusively for one project (edits are applied strictly in arrival order). */
  withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return run;
  }

  /**
   * Apply ops to a project. Throws (status 400) if any op is invalid; nothing is applied in that case.
   * meta: { source: 'ui' | 'mcp' | 'api', clientId, userId (owner check), undoable (keep an undo snapshot) }
   */
  applyOps(id, ops, meta = {}) {
    if (!Array.isArray(ops) || !ops.length) return Promise.reject(httpError(400, 'ops must be a non-empty array'));
    if (ops.length > 5000) return Promise.reject(httpError(413, 'Too many ops in one request'));
    return this.withLock(id, () => this.applyOpsNow(id, ops, meta));
  }

  async applyOpsNow(id, rawOps, meta, { undo: undoOverride } = {}) {
    const loaded = meta.userId ? await this.getOwned(id, meta.userId) : await this.get(id);
    // re-read the cache after the await so concurrent calls never apply ops to a stale copy
    const before = this.useCache ? this.cache.get(id) : loaded;
    const requestId = operationId(meta.operationId);
    const hash = requestId ? operationHash(rawOps) : null;
    const oldReceipt = requestId && (this.receipts.get(id) || []).find((r) => r.id === requestId);
    if (oldReceipt) {
      if (oldReceipt.hash !== hash) throw httpError(409, 'Operation id was already used for different operations');
      return before;
    }
    let ops;
    let after;
    try {
      // ids are fixed here, and the prepared ops are what gets broadcast, so every replica builds the same project
      ops = prepareOps(rawOps);
      after = applyOps(before, ops);
    } catch (e) {
      throw httpError(400, e.message);
    }
    const rev = (before.rev || 0) + 1;
    after = { ...after, ownerId: before.ownerId, rev, updatedAt: new Date().toISOString() };
    const descriptions = describeOps(ops, after);
    const stack = [...(undoOverride || this.undo.get(id) || [])];
    if (meta.undoable) {
      stack.push({ project: before, revAfter: rev, description: descriptions.join('; '), time: Date.now() });
      if (stack.length > MAX_UNDO) stack.shift();
    }
    const receipts = [...(this.receipts.get(id) || [])];
    if (requestId) {
      receipts.push({ id: requestId, hash, rev, time: Date.now() });
      if (receipts.length > MAX_RECEIPTS) receipts.shift();
    }
    // Acknowledged edits are never debounced. Cloud mode commits these two files together before publishing
    // the result; the local adapter provides atomic individual files and best-effort pair rollback.
    await this.writeNow(id, { project: after, undo: stack, receipts });
    this.publishState(id, after, stack, receipts);
    this.emit('ops', {
      projectId: id, ownerId: after.ownerId, ops, rev, source: meta.source || 'api', clientId: meta.clientId || null,
      coalesce: typeof meta.coalesce === 'string' ? meta.coalesce.slice(0, 64) : null, descriptions
    });
    if (ops.some((o) => (o.type === 'project/update' && 'name' in (o.patch || {})) || o.type === 'project/replace')) this.emit('list-changed', after.ownerId);
    return after;
  }

  /**
   * Revert the most recent undoable (Claude) change. Refuses if the project was edited after it,
   * unless force is set (then those later edits are discarded too).
   */
  undoLast(id, ownerId, { force = false, source = 'mcp' } = {}) {
    return this.withLock(id, async () => {
      const p = await this.getOwned(id, ownerId);
      const stack = this.undo.get(id) || [];
      const last = stack[stack.length - 1];
      if (!last) throw httpError(400, 'Nothing to undo (only retained changes made through MCP can be undone)');
      if (last.revAfter !== p.rev && !force) {
        throw httpError(409, 'The project was edited after that change. Pass force=true to revert anyway (later edits are lost), or use restore_version.');
      }
      const remaining = stack.slice(0, -1).map((entry) => ({ ...entry }));
      // the state is now what it was right after the previous undoable change, so that one can be undone next
      const top = remaining[remaining.length - 1];
      if (top && top.revAfter === last.project.rev) top.revAfter = (p.rev || 0) + 1;
      const after = await this.applyOpsNow(id, [{ type: 'project/replace', project: last.project }], { source, userId: ownerId }, { undo: remaining });
      return { project: after, undone: last.description };
    });
  }

  // ---------------------------------------------------------------- versions (named snapshots)

  versionDir(id) {
    this.file(id); // validates id
    return path.join(this.versionsDir, id);
  }

  async saveVersion(id, ownerId, name, { source = 'api' } = {}) {
    const p = await this.getOwned(id, ownerId);
    const dir = this.versionDir(id);
    await fs.mkdir(dir, { recursive: true });
    const version = { id: uid('ver'), name: String(name || `Version ${new Date().toLocaleString('en-GB')}`).slice(0, 80), createdAt: new Date().toISOString(), rev: p.rev, bpm: p.bpm };
    await writeFileAtomic(path.join(dir, `${version.id}.json`), JSON.stringify({ ...version, project: p }));
    const list = await this.listVersions(id, ownerId);
    for (const old of list.slice(MAX_VERSIONS)) await fs.rm(path.join(dir, `${old.id}.json`), { force: true });
    this.emit('versions-changed', { projectId: id, ownerId, source, saved: version });
    return version;
  }

  async listVersions(id, ownerId) {
    await this.getOwned(id, ownerId);
    const dir = this.versionDir(id);
    let files = [];
    try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      try {
        const { project, ...v } = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
        out.push({ ...v, channels: project?.channels?.length ?? 0, patterns: project?.patterns?.length ?? 0 });
      } catch { /* skip */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async restoreVersion(id, ownerId, versionId, meta = {}) {
    await this.getOwned(id, ownerId);
    if (!/^[\w-]+$/.test(String(versionId))) throw httpError(400, 'Invalid version id');
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(this.versionDir(id), `${versionId}.json`), 'utf8'));
    } catch {
      throw httpError(404, `Version ${versionId} not found`);
    }
    return this.applyOps(id, [{ type: 'project/replace', project: data.project }], { ...meta, userId: ownerId });
  }

  async deleteVersion(id, ownerId, versionId) {
    await this.getOwned(id, ownerId);
    if (!/^[\w-]+$/.test(String(versionId))) throw httpError(400, 'Invalid version id');
    await fs.rm(path.join(this.versionDir(id), `${versionId}.json`), { force: true });
    this.emit('versions-changed', { projectId: id, ownerId, source: 'api' });
  }

  // ---------------------------------------------------------------- persistence

  historyFile(id) {
    this.file(id);
    return path.join(this.historyDir, `${id}.json`);
  }

  async loadHistory(id, project) {
    if (this.useCache && this.historyLoaded.has(id)) return;
    let history;
    try {
      history = JSON.parse(await fs.readFile(this.historyFile(id), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw httpError(503, 'Saved project history could not be read');
      // Existing projects created before durable history have no sidecar.
      this.undo.set(id, []);
      this.receipts.set(id, []);
      this.historyLoaded.add(id);
      return;
    }
    const valid = history?.version === 1 && history.projectId === id && history.rev === (project.rev || 0)
      && Array.isArray(history.undo) && history.undo.length <= MAX_UNDO
      && Array.isArray(history.receipts) && history.receipts.length <= MAX_RECEIPTS
      && history.undo.every((r) => r?.project?.id === id && (r.project.ownerId || null) === project.ownerId
        && Number.isSafeInteger(r.revAfter) && r.revAfter > 0 && r.revAfter <= project.rev
        && Number.isSafeInteger(r.project.rev) && r.project.rev >= 0 && r.project.rev < r.revAfter
        && typeof r.description === 'string' && Number.isFinite(r.time))
      && history.receipts.every((r) => typeof r?.id === 'string' && /^[\w:.-]{1,200}$/.test(r.id)
        && typeof r.hash === 'string' && /^[a-f0-9]{64}$/.test(r.hash)
        && Number.isSafeInteger(r.rev) && r.rev > 0 && r.rev <= project.rev && Number.isFinite(r.time))
      && new Set(history.receipts.map((r) => r.id)).size === history.receipts.length;
    if (!valid) throw httpError(503, 'Saved project history does not match its revision');
    this.undo.set(id, history.undo);
    this.receipts.set(id, history.receipts);
    this.historyLoaded.add(id);
  }

  /** A durable retry receipt; callers can acknowledge the original revision after reconnect/restart. */
  async getOperationReceipt(id, requestId, ownerId, ops) {
    const key = operationId(requestId);
    if (ownerId) await this.getOwned(id, ownerId); else await this.get(id);
    const receipt = (this.receipts.get(id) || []).find((r) => r.id === key) || null;
    if (receipt && ops !== undefined && receipt.hash !== operationHash(ops)) throw httpError(409, 'Operation id was already used for different operations');
    return receipt ? { ...receipt } : null;
  }

  publishState(id, project, undo, receipts) {
    this.cache.set(id, project);
    this.undo.set(id, undo);
    this.receipts.set(id, receipts);
    this.historyLoaded.add(id);
  }

  scheduleSave(id) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      this.writeNow(id).catch((e) => console.error('[store] save failed', e));
    }, this.saveDelay));
  }

  async writeNow(id, { project = this.cache.get(id), undo = this.undo.get(id) || [], receipts = this.receipts.get(id) || [] } = {}) {
    const p = project;
    if (!p || this.deleted.has(id)) return;
    const files = [
      { file: this.file(id), bytes: JSON.stringify(p) },
      { file: this.historyFile(id), bytes: JSON.stringify({ version: 1, projectId: id, rev: p.rev || 0, undo, receipts }) }
    ];
    for (const item of files) {
      try { item.before = await fs.readFile(item.file); } catch (e) { if (e.code !== 'ENOENT') throw e; item.before = null; }
    }
    try {
      for (const item of files) await writeFileAtomic(item.file, item.bytes);
    } catch (e) {
      const rollback = await Promise.allSettled(files.map((item) => item.before === null
        ? fs.rm(item.file, { force: true }) : writeFileAtomic(item.file, item.before)));
      if (rollback.some((r) => r.status === 'rejected')) {
        this.cache.delete(id);
        this.historyLoaded.delete(id);
        throw new AggregateError([e, ...rollback.filter((r) => r.status === 'rejected').map((r) => r.reason)], 'Project save failed and rollback was incomplete');
      }
      throw e;
    }
  }

  async flush() {
    const ids = [...this.timers.keys()];
    for (const id of ids) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      await this.writeNow(id);
    }
  }
}

export function meta(p) {
  return {
    id: p.id,
    name: p.name,
    bpm: p.bpm,
    ownerId: p.ownerId || null,
    channels: p.channels.length,
    patterns: p.patterns.length,
    clips: p.playlist.clips.length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt
  };
}
