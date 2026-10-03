#!/usr/bin/env node
// GreanTeaDawy MCP server over stdio (for Claude Desktop / Claude Code).
//
// If the GreanTeaDawy web server is running (GREANTEADAWY_URL, default http://127.0.0.1:3001),
// tool calls are forwarded to it so edits appear live in the browser. Authenticate with your
// personal API token (GREANTEADAWY_TOKEN, from Studio → Settings → API & MCP); without a token the
// server must allow "MCP without token".
// If the web server isn't running, it falls back to editing the project files on disk directly.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './tools.js';
import { createLocalBackend, createRemoteBackend } from '../backend.js';
import { ProjectStore } from '../store.js';
import { SampleLibrary } from '../samples.js';
import { UserStore } from '../auth/users.js';
import { loadConfig, loadDotEnv } from '../config.js';

const log = (...a) => console.error('[greanteadawy-mcp]', ...a); // stdout is reserved for MCP messages

async function serverReachable(url) {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Backend that prefers the live server, re-checking periodically so starting the server later just works. */
function createAutoBackend(url, token, localFactory) {
  const remote = createRemoteBackend(url, { token });
  let local = null;
  let lastCheck = 0;
  let live = false;
  async function pick() {
    const now = Date.now();
    if (now - lastCheck > 3000) {
      live = await serverReachable(url);
      lastCheck = now;
    }
    if (live) return remote;
    if (!local) local = await localFactory();
    return local;
  }
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'describeSample') return remote.describeSample;
      return async (...args) => {
        const b = await pick();
        try {
          return await b[prop](...args);
        } catch (e) {
          if (b === remote && /fetch failed|ECONNREFUSED/i.test(e.message)) {
            lastCheck = 0;
            const b2 = await pick();
            return b2[prop](...args);
          }
          throw e;
        }
      };
    }
  });
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const url = process.env.GREANTEADAWY_URL || `http://127.0.0.1:${config.port}`;
  const token = process.env.GREANTEADAWY_TOKEN || '';
  const backend = createAutoBackend(url, token, async () => {
    log(`web server not reachable at ${url}; editing files in ${config.dataDir} directly`);
    const users = await new UserStore(config.dataDir).init();
    const user = token ? users.findByToken(token) : users.settings.mcpWithoutToken ? users.mcpDefaultUser() : null;
    if (!user) {
      throw new Error(token
        ? 'GREANTEADAWY_TOKEN is not valid for this data directory.'
        : users.count() ? 'Set GREANTEADAWY_TOKEN (Studio → Settings → API & MCP): this server requires a token.' : 'No account exists yet: start the web server and create one first.');
    }
    const store = await new ProjectStore(config.dataDir, { saveDelay: 0, cache: false }).init();
    const samples = await new SampleLibrary(config.dataDir).init();
    return createLocalBackend({ store, samples, users, user });
  });
  const server = createMcpServer(backend);
  await server.connect(new StdioServerTransport());
  log(`ready (server: ${url}${token ? ', using API token' : ''})`);
}

main().catch((e) => {
  log('fatal', e);
  process.exit(1);
});
