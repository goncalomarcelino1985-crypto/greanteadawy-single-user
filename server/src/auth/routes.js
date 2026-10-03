// /api/auth/*, /api/me/*, /api/admin/* — accounts, sessions, API tokens and server settings.
import fs from 'node:fs/promises';
import express from 'express';
import { publicUser, verifyPassword, validatePassword } from './users.js';
import { RateLimiter } from './http.js';
import { httpError, wrap } from '../errors.js';
import { safeEqual } from '../fsutil.js';
import { exportsDir } from '../backend.js';

const WINDOW = 15 * 60 * 1000;

/**
 * setupCode: first-run setup from anywhere but this computer (isLocal) needs it — it's printed in the server log — so
 * whoever reaches a freshly deployed server first can't claim the admin account.
 */
export function createAuthRouter({ users, sessions, auth, store, samples, hub, onUserCreated, setupCode = null, isLocal = () => false, plugins = null }) {
  const r = express.Router();
  // Password guessing: per username+IP (10), per username from anywhere (100, so one attacker can't
  // easily lock a user out), per IP across accounts (50).
  const userIpLimiter = new RateLimiter({ max: 10, windowMs: WINDOW });
  const userLimiter = new RateLimiter({ max: 100, windowMs: WINDOW });
  const ipLimiter = new RateLimiter({ max: 50, windowMs: WINDOW });
  const signupLimiter = new RateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });
  const passwordLimiter = new RateLimiter({ max: 10, windowMs: WINDOW });

  const login = (req, res, user) => {
    const sid = sessions.create(user.id, { userAgent: req.headers['user-agent'] });
    auth.setSessionCookie(req, res, sid);
    return sid;
  };

  const status = (req) => {
    const a = auth.identify(req);
    return {
      setupRequired: users.count() === 0,
      setupCodeRequired: !!setupCode && users.count() === 0 && !isLocal(req),
      user: publicUser(a?.user || null),
      allowRegistration: !!users.settings.allowRegistration,
      mcpWithoutToken: !!users.settings.mcpWithoutToken
    };
  };

  r.get('/auth/status', (req, res) => res.json(status(req)));

  r.post('/auth/setup', wrap(async (req, res) => {
    if (users.count() > 0) throw httpError(409, 'Setup is already complete');
    const { username, password, displayName } = req.body || {};
    if (setupCode && !isLocal(req)) {
      const key = `setup:${req.ip}`;
      const c = ipLimiter.check(key);
      if (!c.ok) throw httpError(429, 'Too many attempts, try again later');
      if (!safeEqual(req.body?.setupCode, setupCode)) {
        ipLimiter.fail(key);
        throw httpError(403, 'Wrong setup code. It is printed in the server log when the server starts.');
      }
    }
    const user = await users.create({ username, password, displayName, role: 'admin', onlyIfEmpty: true });
    await onUserCreated?.(user, { firstAdmin: true });
    login(req, res, user);
    res.status(201).json({
      setupRequired: false,
      user: publicUser(user),
      allowRegistration: !!users.settings.allowRegistration,
      mcpWithoutToken: !!users.settings.mcpWithoutToken
    });
  }));

  r.post('/auth/login', wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 200) {
      throw httpError(400, 'Wrong username or password');
    }
    const name = username.trim().toLowerCase();
    const checks = [[ipLimiter, `ip:${req.ip}`], [userIpLimiter, `user:${name}|${req.ip}`], [userLimiter, `user:${name}`]];
    for (const [lim, k] of checks) {
      const c = lim.check(k);
      if (!c.ok) {
        res.set('Retry-After', String(c.retryAfter));
        throw httpError(429, `Too many login attempts. Try again in ${Math.ceil(c.retryAfter / 60)} minute(s).`);
      }
    }
    // count the attempt before the (slow) hash: parallel requests can't all slip past the limit meanwhile
    for (const [lim, k] of checks) lim.fail(k);
    const user = await users.authenticate(name, password);
    if (!user) throw httpError(401, 'Wrong username or password');
    for (const [lim, k] of checks) lim.refund(k);
    userIpLimiter.reset(checks[1][1]);
    login(req, res, user);
    res.json({ user: publicUser(user) });
  }));

  r.post('/auth/logout', (req, res) => {
    const a = auth.identify(req);
    if (a?.sid) {
      sessions.destroy(a.sid);
      hub.disconnectSession(a.sid);
    }
    auth.clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  r.post('/auth/register', wrap(async (req, res) => {
    if (!users.settings.allowRegistration) throw httpError(403, 'Registration is closed. Ask an admin to create an account for you.');
    const key = `register:${req.ip}`;
    const c = signupLimiter.check(key);
    if (!c.ok) throw httpError(429, 'Too many sign-ups from this address, try again later');
    signupLimiter.fail(key);
    const { username, password, displayName } = req.body || {};
    const user = await users.create({ username, password, displayName, role: 'user' });
    await onUserCreated?.(user, {});
    login(req, res, user);
    res.status(201).json({ user: publicUser(user) });
  }));

  // ---------------------------------------------------------------- current user
  r.get('/me', auth.requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

  r.patch('/me', auth.requireUser, wrap(async (req, res) => {
    const u = await users.update(req.user.id, { displayName: req.body?.displayName });
    res.json({ user: publicUser(u) });
  }));

  r.post('/me/password', auth.requireSession, wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const key = `pw:${req.user.id}`;
    const c = passwordLimiter.check(key);
    if (!c.ok) throw httpError(429, `Too many attempts. Try again in ${Math.ceil(c.retryAfter / 60)} minute(s).`);
    passwordLimiter.fail(key); // counted before the hash (see login)
    if (!(await verifyPassword(String(currentPassword || '').slice(0, 200), req.user.passwordHash))) {
      throw httpError(400, 'Current password is wrong');
    }
    passwordLimiter.reset(key);
    await users.setPassword(req.user.id, newPassword);
    // sign out every other session; keep this one
    sessions.destroyForUser(req.user.id, { except: req.auth.sid });
    hub.disconnectUser(req.user.id, { exceptSession: req.auth.sid });
    res.json({ ok: true });
  }));

  r.get('/me/token', auth.requireUser, (req, res) => res.json({ token: publicUser(req.user).apiToken }));

  r.post('/me/token', auth.requireSession, wrap(async (req, res) => {
    const token = await users.generateToken(req.user.id);
    res.status(201).json({ token, info: publicUser(users.get(req.user.id)).apiToken });
  }));

  r.delete('/me/token', auth.requireSession, wrap(async (req, res) => {
    await users.revokeToken(req.user.id);
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- admin
  const adminView = async (u) => ({
    ...publicUser(u),
    projects: (await store.list(u.id)).length,
    samples: samples.list(u.id).length,
    sessions: sessions.countForUser(u.id)
  });

  r.get('/admin/users', auth.requireAdmin, wrap(async (req, res) => {
    res.json(await Promise.all(users.list().map(adminView)));
  }));

  r.post('/admin/users', auth.requireAdmin, wrap(async (req, res) => {
    const { username, password, displayName, role } = req.body || {};
    const user = await users.create({ username, password, displayName, role: role === 'admin' ? 'admin' : 'user' });
    await onUserCreated?.(user, {});
    res.status(201).json(await adminView(user));
  }));

  r.patch('/admin/users/:id', auth.requireAdmin, wrap(async (req, res) => {
    const target = users.require(req.params.id);
    const body = req.body || {};
    if (target.id === req.user.id && (body.disabled || (body.role && body.role !== 'admin'))) {
      throw httpError(400, "You can't disable or demote your own account");
    }
    const patch = {};
    for (const k of ['displayName', 'role', 'disabled']) if (k in body) patch[k] = body[k];
    if (body.password !== undefined) validatePassword(body.password); // validate everything before changing anything
    if ('disabled' in patch && typeof patch.disabled !== 'boolean') throw httpError(400, 'disabled must be true or false');
    if (Object.keys(patch).length) await users.update(target.id, patch);
    if (body.password !== undefined) {
      // a password reset is account recovery: end every way in, including the API token
      await users.setPassword(target.id, body.password);
      if (target.apiToken) await users.revokeToken(target.id);
      sessions.destroyForUser(target.id);
      hub.disconnectUser(target.id);
    }
    if (body.revokeToken === true && users.get(target.id).apiToken) await users.revokeToken(target.id);
    if (body.disabled) {
      sessions.destroyForUser(target.id);
      hub.disconnectUser(target.id);
    }
    res.json(await adminView(users.get(target.id)));
  }));

  r.delete('/admin/users/:id', auth.requireAdmin, wrap(async (req, res) => {
    const target = users.require(req.params.id);
    if (target.id === req.user.id) throw httpError(400, "You can't delete your own account");
    if (target.role === 'admin' && !target.disabled && users.admins().length <= 1) throw httpError(400, 'Cannot delete the last admin');
    sessions.destroyForUser(target.id);
    hub.disconnectUser(target.id);
    // their data first (so a failure part-way leaves the account in place to retry), then the account
    for (const p of await store.list(target.id)) await store.remove(p.id);
    await samples.removeOwner(target.id);
    await fs.rm(exportsDir(store.dataDir, target.id), { recursive: true, force: true });
    await plugins?.removeUser(target.id);
    await users.remove(target.id);
    res.json({ ok: true });
  }));

  r.get('/admin/settings', auth.requireAdmin, (req, res) => res.json(users.settings));

  r.patch('/admin/settings', auth.requireAdmin, wrap(async (req, res) => {
    const before = users.settings.allowPlugins;
    const next = await users.updateSettings(req.body || {});
    if (next.allowPlugins !== before) hub.toEveryone?.({ type: 'plugins-changed' }); // open studios reload their plugins
    res.json(next);
  }));

  return r;
}
