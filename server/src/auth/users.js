// User accounts, password hashing (scrypt), personal API tokens and server-wide auth settings.
// Persisted in <dataDir>/users.json.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { uid } from '@greanteadawy/core';
import { httpError } from '../errors.js';
import { writeFileAtomic } from '../fsutil.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
export const TOKEN_PREFIX = 'gtd_';

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const key = await scrypt(password, Buffer.from(saltB64, 'base64'), { N: +N, r: +r, p: +p, keylen: expected.length });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

let dummyHash = null;
/** A real hash to verify against when the username doesn't exist (keeps timing uniform). */
function getDummyHash() {
  if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(12).toString('hex'));
  return dummyHash;
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw httpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw httpError(400, 'Password is too long');
}

export function normalizeUsername(u) {
  const name = String(u || '').trim().toLowerCase();
  if (!USERNAME_RE.test(name)) throw httpError(400, 'Username must be 3-32 characters: letters, digits, "_", "." or "-" (starting with a letter or digit)');
  return name;
}

/** Fields safe to send to the browser. */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    apiToken: u.apiToken ? { prefix: u.apiToken.prefix, createdAt: u.apiToken.createdAt, lastUsedAt: u.apiToken.lastUsedAt || null } : null
  };
}

export class UserStore extends EventEmitter {
  constructor(dataDir, { defaults = {} } = {}) {
    super();
    this.file = path.join(dataDir, 'users.json');
    this.data = { users: [], settings: { allowRegistration: false, mcpWithoutToken: true, mcpDefaultUserId: null, allowPlugins: true, ...defaults } };
    this.writing = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = { users: Array.isArray(raw.users) ? raw.users : [], settings: { ...this.data.settings, ...(raw.settings || {}) } };
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`Cannot read ${this.file}: ${e.message}`);
      await this.save();
    }
    return this;
  }

  /** Serialized atomic write. */
  save() {
    const json = JSON.stringify(this.data, null, 2);
    this.writing = this.writing.catch(() => {}).then(() => writeFileAtomic(this.file, json, { mode: 0o600 }));
    return this.writing;
  }

  count() { return this.data.users.length; }
  list() { return this.data.users; }
  get(id) { return this.data.users.find((u) => u.id === id) || null; }
  findByUsername(name) {
    const n = String(name || '').trim().toLowerCase();
    return this.data.users.find((u) => u.username === n) || null;
  }
  admins() { return this.data.users.filter((u) => u.role === 'admin' && !u.disabled); }
  firstAdmin() { return this.admins()[0] || null; }

  require(id) {
    const u = this.get(id);
    if (!u) throw httpError(404, 'User not found');
    return u;
  }

  /** onlyIfEmpty: first-run setup — fail if any account exists by the time the password is hashed. */
  async create({ username, password, displayName, role = 'user', onlyIfEmpty = false }) {
    const name = normalizeUsername(username);
    if (this.findByUsername(name)) throw httpError(409, 'That username is taken');
    validatePassword(password);
    if (!['admin', 'user'].includes(role)) throw httpError(400, 'Invalid role');
    const passwordHash = await hashPassword(password);
    // re-check after the (slow, async) hash: concurrent requests may have created the same user meanwhile
    if (onlyIfEmpty && this.count() > 0) throw httpError(409, 'Setup is already complete');
    if (this.findByUsername(name)) throw httpError(409, 'That username is taken');
    const now = new Date().toISOString();
    const user = {
      id: uid('usr'),
      username: name,
      displayName: String(displayName || name).trim().slice(0, 60) || name,
      role,
      passwordHash,
      disabled: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      apiToken: null,
      activeProjectId: null
    };
    this.data.users.push(user);
    await this.save();
    this.emit('created', user);
    return user;
  }

  /** Returns the user for valid credentials, otherwise null (constant-ish time). */
  async authenticate(username, password) {
    const user = this.findByUsername(username);
    // hash anyway so response time doesn't reveal whether the username exists
    const ok = await verifyPassword(String(password || ''), user?.passwordHash || (await getDummyHash()));
    if (!user || !ok || user.disabled) return null;
    user.lastLoginAt = new Date().toISOString();
    await this.save();
    return user;
  }

  async update(id, patch) {
    const u = this.require(id);
    if ('displayName' in patch) u.displayName = String(patch.displayName || u.username).trim().slice(0, 60) || u.username;
    if ('role' in patch) {
      if (!['admin', 'user'].includes(patch.role)) throw httpError(400, 'Invalid role');
      if (u.role === 'admin' && !u.disabled && patch.role !== 'admin' && this.admins().length <= 1) throw httpError(400, 'Cannot demote the last admin');
      u.role = patch.role;
    }
    if ('disabled' in patch) {
      if (typeof patch.disabled !== 'boolean') throw httpError(400, 'disabled must be true or false');
      if (patch.disabled && u.role === 'admin' && !u.disabled && this.admins().length <= 1) throw httpError(400, 'Cannot disable the last admin');
      u.disabled = !!patch.disabled;
    }
    if ('activeProjectId' in patch) u.activeProjectId = patch.activeProjectId || null;
    u.updatedAt = new Date().toISOString();
    await this.save();
    this.emit('updated', u);
    return u;
  }

  async setPassword(id, password) {
    validatePassword(password);
    const u = this.require(id);
    u.passwordHash = await hashPassword(password);
    u.updatedAt = new Date().toISOString();
    await this.save();
    this.emit('password-changed', u);
  }

  async remove(id) {
    const u = this.require(id);
    if (u.role === 'admin' && this.admins().length <= 1 && !u.disabled) throw httpError(400, 'Cannot delete the last admin');
    this.data.users = this.data.users.filter((x) => x.id !== id);
    if (this.data.settings.mcpDefaultUserId === id) this.data.settings.mcpDefaultUserId = null;
    await this.save();
    this.emit('removed', u);
  }

  // ---------------------------------------------------------------- API tokens

  /** Create (or replace) the user's personal API token. Returns the raw token — shown once. */
  async generateToken(id) {
    const u = this.require(id);
    const secret = crypto.randomBytes(24).toString('base64url');
    const prefix = secret.slice(0, 6);
    const token = `${TOKEN_PREFIX}${prefix}_${secret.slice(6)}`;
    u.apiToken = { hash: sha256(token), prefix: `${TOKEN_PREFIX}${prefix}`, createdAt: new Date().toISOString(), lastUsedAt: null };
    await this.save();
    this.emit('token-changed', u);
    return token;
  }

  async revokeToken(id) {
    const u = this.require(id);
    u.apiToken = null;
    await this.save();
    this.emit('token-changed', u);
  }

  /** Look up an enabled user by raw API token. */
  findByToken(raw) {
    if (typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX) || raw.length > 200) return null;
    const h = Buffer.from(sha256(raw), 'hex');
    for (const u of this.data.users) {
      if (!u.apiToken || u.disabled) continue;
      const stored = Buffer.from(u.apiToken.hash, 'hex');
      if (stored.length === h.length && crypto.timingSafeEqual(stored, h)) return u;
    }
    return null;
  }

  /** Record token use (throttled to one write per minute). */
  touchToken(u) {
    const now = Date.now();
    if (u.apiToken && (!u.apiToken.lastUsedAt || now - Date.parse(u.apiToken.lastUsedAt) > 60000)) {
      u.apiToken.lastUsedAt = new Date(now).toISOString();
      this.save().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- settings

  get settings() {
    return this.data.settings;
  }

  async updateSettings(patch) {
    const s = this.data.settings;
    if ('allowRegistration' in patch) s.allowRegistration = !!patch.allowRegistration;
    if ('mcpWithoutToken' in patch) s.mcpWithoutToken = !!patch.mcpWithoutToken;
    if ('allowPlugins' in patch) s.allowPlugins = !!patch.allowPlugins;
    if ('mcpDefaultUserId' in patch) {
      if (patch.mcpDefaultUserId && !this.get(patch.mcpDefaultUserId)) throw httpError(400, 'Unknown user');
      s.mcpDefaultUserId = patch.mcpDefaultUserId || null;
    }
    await this.save();
    this.emit('settings-changed', s);
    return s;
  }

  /** The account MCP requests without a token act as (when allowed). */
  mcpDefaultUser() {
    const u = this.get(this.data.settings.mcpDefaultUserId);
    return u && !u.disabled ? u : this.firstAdmin();
  }
}
