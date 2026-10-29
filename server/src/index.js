#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { loadConfig, loadDotEnv, isLoopback } from './config.js';
import { ProjectStore } from './store.js';
import { SampleLibrary } from './samples.js';
import { UserStore } from './auth/users.js';
import { SessionStore } from './auth/sessions.js';
import { createPrivateStudio } from './auth/private-studio.js';
import { createAuth } from './auth/http.js';
import { createAuthRouter } from './auth/routes.js';
import { Hub } from './hub.js';
import { createApiRouter, apiErrorHandlers } from './api.js';
import { createMcpRouter } from './mcp/http.js';
import { isLocalRequest } from './auth/local.js';
import { isLargeBodyRoute } from './api.js';
import { runningServer, writeLock } from './lockfile.js';
import { createLocalBackend } from './backend.js';
import { createFfmpeg } from './ffmpeg.js';
import { PluginStore } from './plugins.js';
import { sandboxRoutes } from './sandbox.js';

/**
 * (req) => boolean: true when the request has no Origin header (non-browser clients such as MCP clients)
 * or the Origin matches the Host the request was sent to (same-origin), or PUBLIC_URL.
 */
export function originChecker(publicUrl) {
  let publicHost = null;
  try { publicHost = publicUrl ? new URL(publicUrl).host : null; } catch { /* ignore */ }
  return (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = new URL(origin).host;
      return host === req.headers.host || (publicHost && host === publicHost);
    } catch {
      return false;
    }
  };
}

// The SPA: own scripts only; inline style attributes (React), blob:/data: media for audio and waveforms.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self'", // the generator sandbox (/sandbox/generator.html), which isolates itself with its own CSP
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

export async function createServer(config = loadConfig()) {
  const loopback = isLoopback(config.host);
  const users = await new UserStore(config.dataDir, { defaults: { mcpWithoutToken: loopback } }).init();
  const sessions = await new SessionStore(config.dataDir, { ttlDays: config.sessionTtlDays }).init();
  const privateStudio = await createPrivateStudio(config, users);
  const auth = createAuth({ users, sessions, ttlDays: config.sessionTtlDays, privateIdentify: privateStudio?.identify });
  const store = await new ProjectStore(config.dataDir).init();
  const samples = await new SampleLibrary(config.dataDir).init();
  const hub = new Hub({ store, samples, users, sessions });
  const ffmpeg = createFfmpeg({ path: config.ffmpegPath, timeoutSec: config.ffmpegTimeoutSec, maxJobs: config.ffmpegMaxJobs });
  const plugins = await new PluginStore(config.dataDir).init();
  const publicUrl = config.publicUrl || `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  // First run: setting up from anywhere but this computer needs a code from the log, so a freshly deployed (or
  // proxied) server can't be claimed by whoever reaches it first
  const setupCode = users.count() === 0 ? config.setupCode || crypto.randomBytes(6).toString('hex') : null;
  const isLocal = (req) => isLocalRequest(req, { trustProxy: config.trustProxy, publicUrl: config.publicUrl });

  // Data created before accounts existed belongs to the first admin
  const admin = users.firstAdmin();
  if (admin) {
    await store.claimOrphans(admin.id);
    await samples.claimOrphans(admin.id);
  }

  /** Every new account starts with a playable demo project. */
  const onUserCreated = async (user, { firstAdmin = false } = {}) => {
    if (firstAdmin) {
      await store.claimOrphans(user.id);
      await samples.claimOrphans(user.id);
    }
    const list = await store.list(user.id);
    if (!list.length) {
      const p = await store.create({ ownerId: user.id, template: 'trap', name: 'Welcome Trap Beat' });
      await users.update(user.id, { activeProjectId: p.id });
    } else if (!user.activeProjectId) {
      await users.update(user.id, { activeProjectId: list[0].id });
    }
  };

  if (privateStudio && !(await store.list(privateStudio.owner.id)).length) {
    const project = await store.create({ ownerId: privateStudio.owner.id, template: 'empty', name: 'Estúdio do Gonçalo' });
    await users.update(privateStudio.owner.id, { activeProjectId: project.id });
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', CSP);
    // the recorder uses the microphone from the studio page itself; nothing else (frames included) gets devices
    res.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=(), usb=(), serial=(), hid=()');
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  if (config.allowedHosts) {
    // /api/health stays reachable by any name (it reveals nothing) so container health checks to 127.0.0.1 work
    // when ALLOWED_HOSTS lists only the public domain
    const validHost = hostHeaderValidation(config.allowedHosts);
    app.use((req, res, next) => (req.path === '/api/health' ? next() : validHost(req, res, next)));
  }
  // CSRF protection: browsers send Origin on cross-site requests; only same-origin (or PUBLIC_URL) may change state
  const standardOriginOk = originChecker(config.publicUrl);
  const originOk = (req) => {
    if (!privateStudio || !req.headers.origin) return standardOriginOk(req);
    try { return new URL(req.headers.origin).origin === (config.publicUrl ? new URL(config.publicUrl).origin : `http://${req.headers.host}`); } catch { return false; }
  };
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || originOk(req)) return next();
    res.status(403).json({ error: 'Cross-origin request blocked' });
  });

  if (privateStudio) app.use(privateStudio.router);

  const api = express.Router();
  // Body limits: small for account endpoints, 1 MB by default. Large project edits and imports get their own
  // 20 MB parser *after* authentication (see api.js), so anonymous requests can't make the server parse big bodies.
  const smallJson = express.json({ limit: '64kb' });
  const defaultJson = express.json({ limit: '1mb' });
  api.use((req, res, next) => {
    if (/^\/(auth|me|admin)(\/|$)/.test(req.path)) return smallJson(req, res, next);
    if (isLargeBodyRoute(req)) return next();
    return defaultJson(req, res, next);
  });
  api.use(createAuthRouter({ users, sessions, auth, store, samples, hub, onUserCreated, setupCode, isLocal, plugins, singleUser: !!privateStudio, ephemeralStorage: config.ephemeralStorage }));
  api.use(createApiRouter({ store, samples, users, hub, auth, config, publicUrl, ffmpeg, plugins }));
  apiErrorHandlers(api);
  app.use('/api', api);

  app.use('/mcp', createMcpRouter({
    users,
    auth,
    legacyToken: config.mcpToken,
    isLocal,
    backendFor: (user) => createLocalBackend({ store, samples, users, hub, user, publicUrl, ffmpeg, plugins, pluginsAllowed: () => config.pluginsEnabled && users.settings.allowPlugins !== false })
  }));
  sandboxRoutes(app);

  if (fs.existsSync(path.join(config.clientDist, 'index.html'))) {
    app.use(express.static(config.clientDist, { index: false, maxAge: privateStudio ? 0 : '1h', ...(privateStudio ? { cacheControl: false } : {}) }));
    app.get(/^\/(?!api\/|mcp|ws).*/, (req, res) => res.sendFile(path.join(config.clientDist, 'index.html'), { cacheControl: !privateStudio }));
  } else {
    app.get('/', (req, res) => res.type('text/plain').send('GreanTeaDawy API is running. Build the client (npm run build) or run "npm run dev" and open http://localhost:5173'));
  }

  // last resort: JSON errors, never stack traces
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status >= 500) console.error('[server]', err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message || 'Bad request' });
  });

  const server = http.createServer(app);
  hub.attach(server, { allowedHosts: config.allowedHosts, originOk, identify: auth.identify });
  return { app, server, store, samples, users, sessions, hub, auth, config, setupCode, ffmpeg, plugins };
}

async function main() {
  loadDotEnv();
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  const ctx = await createServer();
  const { server, config, store, sessions, users, setupCode } = ctx;
  const running = await runningServer(config.dataDir);
  if (running) {
    console.error(`Another GreanTeaDawy server (pid ${running.pid}, port ${running.port}) is using ${config.dataDir}. Stop it or use another DATA_DIR.`);
    console.error(`(If no server is running, delete ${running.file}.)`);
    process.exit(1);
  }
  server.listen(config.port, config.host, () => {
    writeLock(config.dataDir, config.port, config.host);
    const url = config.publicUrl || `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
    console.log(`\n  GreanTeaDawy  ${url}`);
    console.log(`  MCP (Streamable HTTP): ${url}/mcp  (${users.settings.mcpWithoutToken ? 'token optional' : 'API token required'})`);
    console.log(`  Data: ${config.dataDir}`);
    if (!users.count()) {
      console.log('  First run: open the studio to create the admin account.');
      console.log(`  Setup code (needed when setting up from another computer or through a proxy): ${setupCode}`);
    }
    if (!isLoopback(config.host) && !config.allowedHosts) {
      console.log('  Tip: set ALLOWED_HOSTS (and PUBLIC_URL) to the host names you serve, e.g. ALLOWED_HOSTS=studio.example.com');
    }
    console.log('');
  });
  const shutdown = async () => {
    await store.flush().catch(() => {});
    await sessions.flush().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
