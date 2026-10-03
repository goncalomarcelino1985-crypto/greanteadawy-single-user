// Request authentication: session cookie (browser) or personal API token (Bearer) for scripts/MCP.
import { SESSION_COOKIE } from './sessions.js';
import { sha256 } from './users.js';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** Fixed-window limiter for login attempts (per IP and per username). */
export class RateLimiter {
  constructor({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  check(key) {
    key = String(key).slice(0, 200);
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) return { ok: true };
    return h.count >= this.max ? { ok: false, retryAfter: Math.ceil((h.resetAt - now) / 1000) } : { ok: true };
  }

  fail(key) {
    key = String(key).slice(0, 200);
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.resetAt <= now) h = { count: 0, resetAt: now + this.windowMs };
    h.count++;
    this.hits.set(key, h);
    if (this.hits.size > 10000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      // still huge (many distinct keys): drop the oldest entries so memory stays bounded
      for (const k of this.hits.keys()) {
        if (this.hits.size <= 10000) break;
        this.hits.delete(k);
      }
    }
  }

  /** Undo one fail() (an attempt counted up front turned out fine). */
  refund(key) {
    const h = this.hits.get(String(key).slice(0, 200));
    if (h && h.count > 0) h.count--;
  }

  reset(key) {
    this.hits.delete(String(key).slice(0, 200));
  }
}

export function createAuth({ users, sessions, ttlDays = 30 }) {
  /**
   * Resolve the caller. Returns { user, via: 'session' | 'token', sid? }, { invalidToken: true } or null.
   * Tokens in the query string (?token=) are only accepted where explicitly allowed (WebSocket, MCP URL).
   */
  function identify(req, { allowQueryToken = false } = {}) {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) {
      const s = sessions.get(sid);
      const u = s && users.get(s.userId);
      if (u && !u.disabled) return { user: u, via: 'session', sid };
    }
    let token = bearerToken(req);
    if (!token && allowQueryToken) {
      try { token = new URL(req.url, 'http://local').searchParams.get('token'); } catch { token = null; }
    }
    if (token) {
      const u = users.findByToken(token);
      if (!u) return { invalidToken: true };
      users.touchToken(u);
      return { user: u, via: 'token', tokenHash: sha256(token) };
    }
    return null;
  }

  function requireUser(req, res, next) {
    const a = identify(req);
    if (!a?.user) {
      return res.status(401).json({ error: a?.invalidToken ? 'Invalid API token' : 'Authentication required', code: 'AUTH_REQUIRED' });
    }
    req.user = a.user;
    req.auth = a;
    next();
  }

  /** Signed-in browser session only: API tokens (MCP, scripts) can't manage accounts, passwords or tokens. */
  function requireSession(req, res, next) {
    requireUser(req, res, () => {
      if (req.auth.via !== 'session') return res.status(403).json({ error: 'Sign in to the studio in a browser to do this — API tokens are not allowed here' });
      next();
    });
  }

  function requireAdmin(req, res, next) {
    requireSession(req, res, () => {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
      next();
    });
  }

  function cookieFlags(req) {
    return `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;
  }

  function setSessionCookie(req, res, sid) {
    res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sid)}; ${cookieFlags(req)}; Max-Age=${ttlDays * 24 * 3600}`);
  }

  function clearSessionCookie(req, res) {
    res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieFlags(req)}; Max-Age=0`);
  }

  return { identify, requireUser, requireSession, requireAdmin, setSessionCookie, clearSessionCookie };
}
