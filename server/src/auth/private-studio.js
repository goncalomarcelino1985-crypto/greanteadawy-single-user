import crypto from 'node:crypto';
import express from 'express';
import { bearerToken, parseCookies, RateLimiter } from './http.js';
import { sha256 } from './users.js';
import { safeEqual } from '../fsutil.js';
import { isLoopback } from '../config.js';

const COOKIE = 'gtd_private';
const PAGE = `<!doctype html><html lang="pt"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Estúdio privado</title><body style="background:#12171b;color:#e6eee9;font:18px system-ui;padding:8vw"><h1>Estúdio privado</h1><p id="status">Abre o teu link privado para autorizar este navegador.</p><script src="/private-access.js" defer></script></body></html>`;
const SCRIPT = `function authorize() {
const key = location.hash.slice(1); history.replaceState(null, '', '/access');
if (key) {
  document.getElementById('status').textContent = 'A abrir o estúdio…';
  fetch('/private/access', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key}), credentials:'same-origin'})
    .then(r => { if (!r.ok) throw new Error(); location.replace('/'); })
    .catch(() => { document.getElementById('status').textContent = 'Não foi possível autorizar este navegador. Volta a abrir o teu link privado.'; });
}
}
window.addEventListener('hashchange', authorize);
authorize();
`;

/** Single owner, no registration or password recovery. Secrets never enter the client bundle or logs. */
export async function createPrivateStudio(config, users) {
  if (!config.singleUser) return null;
  const key = config.privateAccessKey;
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(key || '')) throw new Error('SINGLE_USER requires a random PRIVATE_ACCESS_KEY (at least 32 bytes, base64url).');
  const url = config.publicUrl ? new URL(config.publicUrl) : null;
  if ((!isLoopback(config.host) || config.trustProxy) && url?.protocol !== 'https:') {
    throw new Error('A public single-user studio requires an HTTPS PUBLIC_URL.');
  }
  if (url && !isLoopback(url.hostname) && url.protocol !== 'https:') throw new Error('PUBLIC_URL must use HTTPS.');
  if (url && (!config.allowedHosts || !config.allowedHosts.includes(url.hostname))) throw new Error('ALLOWED_HOSTS must include the public studio hostname.');
  if (config.mcpToken) throw new Error('Use a separate personal MCP token from Settings, not MCP_TOKEN, in single-user mode.');
  if (users.count() && (users.count() !== 1 || users.firstAdmin()?.username !== 'goncalo')) {
    throw new Error('Single-user mode requires a dedicated empty DATA_DIR or its existing goncalo owner.');
  }
  const owner = users.firstAdmin() || await users.create({ username: 'goncalo', displayName: 'Gonçalo', role: 'admin', password: crypto.randomBytes(48).toString('base64url'), onlyIfEmpty: true });
  await users.updateSettings({ allowRegistration: false, mcpWithoutToken: false });
  const secure = url?.protocol === 'https:';
  const cookieName = secure ? '__Host-gtd_private' : COOKIE;
  const ttl = Math.min(config.sessionTtlDays, 365) * 86400;
  const sign = (payload) => crypto.createHmac('sha256', key).update(`private-studio-v1:${payload}`).digest('base64url');

  function identify(req) {
    // Deliberately reject query-string tokens and legacy account cookies.
    const token = bearerToken(req);
    if (token) {
      const user = users.findByToken(token);
      if (!user || user.id !== owner.id || user.disabled) return { invalidToken: true };
      users.touchToken(user);
      return { user, via: 'token', tokenHash: sha256(token) };
    }
    const cookie = parseCookies(req.headers.cookie)[cookieName];
    if (!cookie || cookie.length > 256) return null;
    const [expires, nonce, signature, extra] = cookie.split('.');
    if (extra || !/^\d+$/.test(expires) || !/^[A-Za-z0-9_-]{22}$/.test(nonce || '')) return null;
    const expiresAt = Number(expires) * 1000;
    if (expiresAt <= Date.now() || !safeEqual(signature, sign(`${expires}.${nonce}`))) return null;
    const user = users.get(owner.id);
    return user && !user.disabled ? { user, via: 'session', expiresAt } : null;
  }

  const router = express.Router();
  const attempts = new RateLimiter({ max: 20 });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  router.get('/access', (req, res) => res.type('html').send(PAGE));
  router.get('/private-access.js', (req, res) => res.type('js').send(SCRIPT));
  router.post('/private/access', express.json({ limit: '2kb' }), (req, res) => {
    const limit = attempts.check(req.ip);
    if (!limit.ok) return res.status(429).set('Retry-After', String(limit.retryAfter)).json({ error: 'Try again later' });
    attempts.fail(req.ip);
    if (!safeEqual(req.body?.key, key)) return res.status(401).json({ error: 'Private access required' });
    attempts.refund(req.ip);
    const payload = `${Math.floor(Date.now() / 1000) + ttl}.${crypto.randomBytes(16).toString('base64url')}`;
    res.set('Set-Cookie', `${cookieName}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}${secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  });
  router.use((req, res, next) => {
    if (req.path === '/api/health' && ['GET', 'HEAD'].includes(req.method)) return next();
    const a = identify(req);
    if (!a?.user) {
      if (req.path === '/' && req.method === 'GET') return res.status(401).type('html').send(PAGE);
      return res.status(401).json({ error: 'Private access required', code: 'AUTH_REQUIRED' });
    }
    // Block account management in the server too (case/encoding independent via Express routing).
    next();
  });
  const disabled = (req, res) => res.status(403).json({ error: 'Account management is disabled in this private studio' });
  router.all('/api/auth/:action', (req, res, next) => {
    if (req.params.action.toLowerCase() === 'status' && req.method === 'GET') return next();
    return disabled(req, res);
  });
  router.all(['/api/me/password', '/api/admin', '/api/admin/{*path}'], disabled);
  return { owner, identify, router };
}
