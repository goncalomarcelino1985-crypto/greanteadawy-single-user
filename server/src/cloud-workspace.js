// A single-user cloud transaction boundary. DATA_DIR is a reconstructable working
// cache: PostgreSQL owns checkpoints, private object storage owns immutable bytes.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { httpError } from './errors.js';
import { writeFileAtomic } from './fsutil.js';
import { canonicalJSON, validateState } from './persistence/validation.js';

const ROOTS = ['users.json', 'projects', 'history', 'versions', 'samples', 'exports', 'plugins', 'preferences'];
const context = new AsyncLocalStorage();
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);

function safePath(root, name) {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some((p) => !p || p === '.' || p === '..') || !ROOTS.includes(name.split('/')[0])) throw new Error('Invalid cloud file path');
  return path.join(root, name);
}

export class CloudWorkspace {
  constructor({ repository, objects, workspaceId, allowInitialize = false, cacheParent = os.tmpdir() }) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(workspaceId || '')) throw new Error('Invalid CLOUD_WORKSPACE_ID');
    this.repository = repository;
    this.objects = objects;
    this.workspaceId = workspaceId;
    this.allowInitialize = allowInitialize;
    this.cacheParent = cacheParent;
    this.generation = 0;
    this.state = { schemaVersion: 1, files: {} };
    this.tail = Promise.resolve();
    this.flush = async () => {};
    this.failed = false;
    this.fileCache = new Map();
    this.unhydrated = new Map();
    this.pendingLoads = new Map();
  }

  async init() {
    // A failed read must never be mistaken for an empty studio.
    const checkpoint = await this.repository.load(this.workspaceId);
    if (!checkpoint && !this.allowInitialize) throw new Error('Cloud workspace missing. Explicit initialization or verified restore required.');
    this.dataDir = await fs.mkdtemp(path.join(this.cacheParent, 'gtd-cloud-'));
    if (checkpoint) {
      this.generation = checkpoint.generation;
      this.state = checkpoint.state;
      await this.hydrate();
    }
    return this;
  }

  async hydrate() {
    validateState(this.state);
    for (const [name, entry] of Object.entries(this.state.files)) {
      const dest = safePath(this.dataDir, name);
      if (entry.kind !== 'json' && entry.kind !== 'blob') throw new Error('Invalid cloud file entry');
      if (entry.kind === 'blob') {
        this.unhydrated.set(name, entry);
        continue;
      }
      const bytes = Buffer.from(JSON.stringify(entry.value));
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.writeFile(dest, bytes, { mode: 0o600 });
    }
  }

  relativeFile(file) {
    const name = path.isAbsolute(file) ? path.relative(this.dataDir, file).split(path.sep).join('/') : file;
    safePath(this.dataDir, name);
    return name;
  }

  assetReference(name) {
    return this.unhydrated.get(name) || this.fileCache.get(name)?.entry;
  }

  assetReferences() {
    return new Map([...this.fileCache].map(([name, cached]) => [name, cached.entry]).concat([...this.unhydrated]));
  }

  /** Fetch only the asset actually requested; JSON is already present at startup. */
  async ensureFile(file) {
    this.assertHealthy();
    const name = this.relativeFile(file);
    const dest = safePath(this.dataDir, name);
    try {
      const stat = await fs.lstat(dest);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid cloud asset cache entry');
      return dest;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const entry = this.assetReference(name);
    if (!entry) throw httpError(404, 'File not found');
    if (this.pendingLoads.has(name)) return this.pendingLoads.get(name);
    const load = (async () => {
      const bytes = await this.objects.get(entry);
      this.assertHealthy();
      // Deleting or replacing an asset while it loads must never resurrect it.
      if (this.assetReference(name) !== entry) throw httpError(404, 'File changed while loading');
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await writeFileAtomic(dest, bytes, { mode: 0o600 });
      this.fileCache.set(name, { stat: await fs.stat(dest), entry });
      this.unhydrated.delete(name);
      return dest;
    })();
    this.pendingLoads.set(name, load);
    try { return await load; }
    finally { if (this.pendingLoads.get(name) === load) this.pendingLoads.delete(name); }
  }

  async fileExists(file) {
    const name = this.relativeFile(file);
    if (this.assetReference(name)) return true;
    try { await fs.lstat(safePath(this.dataDir, name)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  /** Immediate directory contents, including cloud-only exports, without downloads. */
  async listFiles(directory) {
    const name = this.relativeFile(directory);
    const prefix = `${name}/`;
    const files = new Map();
    for (const [file, entry] of this.assetReferences()) {
      if (!file.startsWith(prefix) || file.slice(prefix.length).includes('/')) continue;
      files.set(file.slice(prefix.length), { name: file.slice(prefix.length), bytes: entry.size,
        createdAt: entry.modifiedAt || '1970-01-01T00:00:00.000Z' });
    }
    let local = [];
    try { local = await fs.readdir(safePath(this.dataDir, name), { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of local) {
      if (!entry.isFile()) continue;
      const relative = `${prefix}${entry.name}`;
      const stat = await fs.stat(safePath(this.dataDir, relative));
      const cached = this.fileCache.get(relative);
      files.set(entry.name, { name: entry.name, bytes: stat.size,
        createdAt: cached?.entry.modifiedAt || stat.mtime.toISOString() });
    }
    return [...files.values()];
  }

  /** Call only after the owning mutation has successfully removed/replaced files. */
  forgetFile(file) {
    const name = this.relativeFile(file);
    this.unhydrated.delete(name);
    this.fileCache.delete(name);
  }

  forgetPrefix(directory) {
    const prefix = this.relativeFile(directory);
    for (const key of new Set([...this.unhydrated.keys(), ...this.fileCache.keys()])) {
      if (key === prefix || key.startsWith(`${prefix}/`)) this.forgetFile(key);
    }
  }

  async capture() {
    // Absence from the disposable cache does not mean an untouched asset was
    // deleted. Explicit deletion hooks remove cloud-only references first.
    // Retain references for previously loaded assets too: eviction of a disposable
    // cache file is not a user deletion. Only forgetFile/forgetPrefix remove them.
    const files = Object.fromEntries(this.assetReferences());
    const walk = async (name) => {
      const dest = safePath(this.dataDir, name);
      let stat;
      try { stat = await fs.lstat(dest); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      if (stat.isSymbolicLink()) throw new Error('Links cannot be persisted');
      if (stat.isDirectory()) {
        for (const child of (await fs.readdir(dest)).sort()) {
          if (child.startsWith('.') || /\.(tmp|part)$/.test(child)) continue;
          await walk(`${name}/${child}`);
        }
      } else if (stat.isFile()) {
        if (name.endsWith('.json')) {
          if (stat.size > 32 * 1024 * 1024) throw httpError(507, 'Metadata file exceeds the free storage safety limit');
          files[name] = { kind: 'json', value: JSON.parse(await fs.readFile(dest, 'utf8')) };
        } else {
          if (stat.size > (this.objects.maxObjectBytes || 64 * 1024 * 1024)) throw httpError(507, 'Audio file exceeds the free storage safety limit');
          const cached = this.fileCache.get(name);
          if (cached && cached.stat.ino === stat.ino && cached.stat.size === stat.size && cached.stat.mtimeMs === stat.mtimeMs && cached.stat.ctimeMs === stat.ctimeMs) files[name] = cached.entry;
          else {
            const entry = { kind: 'blob', ...await this.objects.put(await fs.readFile(dest)), modifiedAt: stat.mtime.toISOString() };
            files[name] = entry;
            this.fileCache.set(name, { stat, entry });
          }
          this.unhydrated.delete(name);
        }
      }
    };
    for (const root of ROOTS) await walk(root);
    return { schemaVersion: 1, files };
  }

  async checkpoint() {
    await this.flush();
    const state = await this.capture();
    if (this.generation && same(state, this.state)) return;
    this.generation = await this.repository.commit(this.workspaceId, this.generation, state);
    this.state = state;
  }

  assertHealthy() {
    if (this.failed) throw httpError(503, 'Cloud persistence is unavailable. No changes are being accepted; restart from the last cloud checkpoint.');
  }

  run(fn) {
    const current = context.getStore();
    if (current?.workspace === this && current.active) return fn();
    const task = this.tail.then(async () => {
      this.assertHealthy();
      // Detect another Render process during rolling deploy before reading stale cache.
      try {
        const latestGeneration = this.repository.getGeneration ? await this.repository.getGeneration(this.workspaceId)
          : (await this.repository.load(this.workspaceId))?.generation || 0;
        if (latestGeneration !== this.generation) throw httpError(409, 'Cloud workspace changed on another server. Reconnect after restart.');
      } catch (error) {
        // An unavailable authority is as unsafe as a stale cache. Stop existing
        // sockets too, so the UI cannot keep queuing apparently healthy edits.
        this.failed = true;
        this.onFailure?.();
        throw error;
      }
      const scope = { workspace: this, active: true, deliveries: [], phase: 'body' };
      return context.run(scope, async () => {
        try {
          const result = await fn();
          if (scope.abort) throw scope.abort;
          scope.phase = 'commit';
          await this.checkpoint();
          scope.active = false;
          for (const deliver of scope.deliveries) {
            try { deliver(); } catch { console.error('[cloud] A notification failed after a durable commit'); }
          }
          return result;
        } catch (caught) {
          // HTTP/MCP handlers can replace the original exception with a generic
          // error response. Preserve a fatal store failure captured by the guard.
          const error = scope.abort?.cloudFatal ? scope.abort : caught;
          scope.active = false;
          // Discard pending events and never expose a working cache after an
          // uncertain commit. A new process reconstructs only authoritative data.
          let unchanged = false;
          if (scope.phase === 'body' && !error.cloudFatal) {
            try { unchanged = same(await this.capture(), this.state); } catch { /* cannot establish safe state */ }
          }
          this.failed = !unchanged;
          if (this.failed) this.onFailure?.();
          throw error;
        }
      });
    });
    this.tail = task.catch(() => {});
    return task;
  }

  deliver(fn) {
    const scope = context.getStore();
    if (scope?.workspace === this && scope.active) scope.deliveries.push(fn);
    else if (!this.failed) fn();
  }

  bufferEmitter(emitter) {
    const emit = emitter.emit.bind(emitter);
    emitter.emit = (...args) => { this.deliver(() => emit(...args)); return true; };
  }

  bufferSocket(ws) {
    const send = ws.send.bind(ws);
    ws.send = (...args) => this.deliver(() => { if (ws.readyState === 1) send(...args); });
  }

  guardBackend(backend) {
    const mutations = new Set(['createProject', 'deleteProject', 'duplicateProject', 'applyOps', 'undo', 'saveVersion', 'restoreVersion', 'setActive', 'updateSample', 'deleteSample', 'deleteSamples', 'moveSamples', 'createSampleFolder', 'renameSampleFolder', 'deleteSampleFolder', 'exportMidi', 'convertExport', 'deleteExport']);
    return Object.fromEntries(Object.entries(backend).map(([key, value]) => [key, !mutations.has(key) ? value : async (...args) => {
      try { return await value(...args); }
      catch (error) {
        const scope = context.getStore();
        if (scope?.workspace === this && scope.active) {
          // A failed save may leave a store's in-memory objects changed even if
          // its files are unchanged. Reconstruct after unexpected/server errors.
          if (!Number.isInteger(error.status) || error.status >= 500) error.cloudFatal = true;
          if (!scope.abort || error.cloudFatal) scope.abort = error;
        }
        throw error;
      }
    }]));
  }

  guardMethods(target, names) {
    for (const name of names) {
      const method = target[name].bind(target);
      target[name] = async (...args) => {
        try { return await method(...args); }
        catch (error) {
          const scope = context.getStore();
          if (scope?.workspace === this && scope.active) {
            if (!Number.isInteger(error.status) || error.status >= 500) error.cloudFatal = true;
            if (!scope.abort || error.cloudFatal) scope.abort = error;
          }
          throw error;
        }
      };
    }
  }

  // Buffer REST and MCP/SSE responses as well as events: clients never see a
  // success message until the corresponding checkpoint is durable.
  middleware() {
    return (req, res, next) => {
      if (req.path === '/health' || req.path === '/api/health') {
        if (this.failed) return res.status(503).json({ ok: false });
        return next();
      }
      const original = { write: res.write, end: res.end, writeHead: res.writeHead, flushHeaders: res.flushHeaders };
      const chunks = [];
      let bytes = 0;
      let done;
      let ending = false;
      const ready = new Promise((resolve) => { done = resolve; });
      const append = (chunk, encoding) => {
        if (chunk === undefined || chunk === null) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
        bytes += data.length;
        if (bytes > 96 * 1024 * 1024) throw httpError(413, 'Response exceeds the free storage safety limit');
        chunks.push(data);
      };
      const restore = () => Object.assign(res, original);
      this.run(async () => {
        if (req.aborted || res.destroyed) throw Object.assign(new Error('Request disconnected before processing'), { cloudFatal: true });
        const requestScope = context.getStore();
        res.writeHead = function (status, statusMessage, headers) {
          this.statusCode = status;
          const values = typeof statusMessage === 'object' ? statusMessage : headers;
          if (values) for (const [key, value] of Object.entries(values)) this.setHeader(key, value);
          return this;
        };
        res.flushHeaders = () => {};
        res.write = (chunk, encoding, callback) => {
          append(chunk, encoding);
          (typeof encoding === 'function' ? encoding : callback)?.();
          return true;
        };
        res.end = (chunk, encoding, callback) => {
          if (ending) return res;
          ending = true;
          append(chunk, encoding);
          done();
          if (typeof encoding === 'function') res.once('finish', encoding);
          else if (callback) res.once('finish', callback);
          return res;
        };
        const disconnected = () => {
          if (ending) return;
          requestScope.abort = Object.assign(new Error('Request disconnected during cloud transaction'), { cloudFatal: true });
          ending = true;
          done();
        };
        req.once('aborted', disconnected);
        res.once('close', disconnected);
        next();
        await ready;
        if (res.statusCode >= 400) throw httpError(res.statusCode, 'Request rejected');
      }).then(() => {
        restore();
        if (!res.destroyed) original.end.call(res, Buffer.concat(chunks));
      }).catch(() => {
        restore();
        if (!res.destroyed) {
          if (ending && !this.failed && res.statusCode >= 400) return original.end.call(res, Buffer.concat(chunks));
          for (const key of res.getHeaderNames()) if (['content-length', 'content-type', 'content-encoding', 'etag', 'set-cookie'].includes(key)) res.removeHeader(key);
          res.status(503).json({ error: 'Não foi possível confirmar a gravação na cloud. O último estado confirmado está preservado. Volta a ligar após reiniciar o serviço.', code: 'CLOUD_UNAVAILABLE' });
        }
      });
    };
  }

  async close() {
    await this.tail;
    if (this.dataDir) await fs.rm(this.dataDir, { recursive: true, force: true });
  }
}
