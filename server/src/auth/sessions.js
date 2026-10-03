// Login sessions. The cookie carries a random 256-bit id; only its SHA-256 is stored on disk,
// so a leaked sessions.json can't be replayed. Sessions slide: each use extends them.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './users.js';
import { writeFileAtomic } from '../fsutil.js';

export const SESSION_COOKIE = 'gtd_session';
const MAX_PER_USER = 20;

export class SessionStore {
  constructor(dataDir, { ttlDays = 30 } = {}) {
    this.file = path.join(dataDir, 'sessions.json');
    this.ttl = ttlDays * 24 * 3600 * 1000;
    this.sessions = new Map(); // hash -> { userId, createdAt, expiresAt, lastSeenAt, userAgent }
    this.timer = null;
    this.writing = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const now = Date.now();
      for (const [k, v] of Object.entries(raw)) if (v.expiresAt > now) this.sessions.set(k, v);
    } catch { /* first run or unreadable: start with no sessions */ }
    this.sweeper = setInterval(() => this.sweep(), 60 * 60 * 1000);
    this.sweeper.unref?.();
    return this;
  }

  /** Drop expired sessions. */
  sweep(now = Date.now()) {
    let changed = false;
    for (const [k, s] of this.sessions) {
      if (s.expiresAt <= now) {
        this.sessions.delete(k);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.flush().catch(() => {}); }, 1000);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    const json = JSON.stringify(Object.fromEntries(this.sessions));
    this.writing = this.writing.catch(() => {}).then(() => writeFileAtomic(this.file, json, { mode: 0o600 }));
    return this.writing;
  }

  /** Create a session; returns the raw id for the cookie. */
  create(userId, { userAgent = '' } = {}) {
    const id = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    // cap sessions per user: forget the least recently used ones
    const mine = [...this.sessions].filter(([, s]) => s.userId === userId).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_PER_USER + 1))) this.sessions.delete(k);
    this.sessions.set(sha256(id), { userId, createdAt: now, lastSeenAt: now, expiresAt: now + this.ttl, userAgent: String(userAgent).slice(0, 200) });
    this.scheduleSave();
    return id;
  }

  /** Returns the session for a raw id (and slides its expiry), or null. */
  get(id) {
    if (!id || typeof id !== 'string' || id.length > 100) return null;
    const key = sha256(id);
    const s = this.sessions.get(key);
    if (!s) return null;
    const now = Date.now();
    if (s.expiresAt <= now) {
      this.sessions.delete(key);
      this.scheduleSave();
      return null;
    }
    if (now - s.lastSeenAt > 60_000) {
      s.lastSeenAt = now;
      s.expiresAt = now + this.ttl;
      this.scheduleSave();
    }
    return s;
  }

  destroy(id) {
    if (id && this.sessions.delete(sha256(id))) this.scheduleSave();
  }

  /** Log a user out everywhere (password change, account disabled/deleted). Optionally keep one session. */
  destroyForUser(userId, { except = null } = {}) {
    const keep = except ? sha256(except) : null;
    let changed = false;
    for (const [k, s] of this.sessions) {
      if (s.userId === userId && k !== keep) {
        this.sessions.delete(k);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  countForUser(userId) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.userId === userId) n++;
    return n;
  }
}
