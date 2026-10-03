// Streamable HTTP MCP endpoint (stateless): POST /mcp
// Who is calling?
//   1. Authorization: Bearer <personal API token>  (or ?token=... for clients that can't set headers)
//   2. no token: allowed only if an admin enabled "MCP without token", only from this computer (loopback, no
//      proxy, localhost Host header — so neither LAN clients nor DNS-rebinding pages qualify) and only when no
//      MCP_TOKEN is configured. It acts as the configured default user.
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './tools.js';
import { safeEqual } from '../fsutil.js';

function rpcError(res, status, message, headers = {}) {
  res.status(status).set(headers).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
}

/** isLocal(req): see auth/local.js — token-less access is only for requests from this computer. */
export function createMcpRouter({ users, auth, backendFor, legacyToken = '', isLocal = () => false }) {
  const r = express.Router();
  r.use(express.json({ limit: '4mb' }));

  const legacyOk = (req) => {
    if (!legacyToken) return false;
    const h = req.headers.authorization || '';
    return safeEqual(h.startsWith('Bearer ') ? h.slice(7) : String(req.query.token || ''), legacyToken);
  };

  r.post('/', async (req, res) => {
    let user = null;
    if (legacyOk(req)) user = users.firstAdmin();
    else {
      const a = auth.identify(req, { allowQueryToken: true });
      if (a?.invalidToken) return rpcError(res, 401, 'Invalid API token. Generate a new one in the studio: Settings → API & MCP.', { 'WWW-Authenticate': 'Bearer' });
      user = a?.user || null;
    }
    if (!user) {
      if (!users.count()) return rpcError(res, 401, 'No account exists yet. Open the GreanTeaDawy studio in a browser and create the admin account first.');
      if (!users.settings.mcpWithoutToken || legacyToken || !isLocal(req)) {
        return rpcError(res, 401, 'This server requires an API token for MCP (token-less access only works from this computer when enabled in Settings → Server). Create a token in the studio (Settings → API & MCP) and send it as "Authorization: Bearer <token>" or append ?token=<token> to the URL.', { 'WWW-Authenticate': 'Bearer' });
      }
      user = users.mcpDefaultUser();
      if (!user) return rpcError(res, 401, 'No enabled account is available for token-less MCP access.');
    }
    const server = createMcpServer(backendFor(user));
    // SSE responses (not plain JSON) so long tools like render_mix can stream progress notifications
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp]', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  // malformed JSON etc.: JSON-RPC error instead of an HTML error page
  // eslint-disable-next-line no-unused-vars
  r.use((err, req, res, next) => {
    const status = err.type === 'entity.too.large' ? 413 : err.status && err.status < 500 ? err.status : 500;
    if (status >= 500) console.error('[mcp]', err);
    res.status(status).json({ jsonrpc: '2.0', error: { code: status === 400 ? -32700 : -32603, message: status === 400 ? 'Parse error' : status === 413 ? 'Request too large' : 'Internal server error' }, id: null });
  });

  const notAllowed = (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  r.get('/', notAllowed);
  r.delete('/', notAllowed);
  return r;
}
