import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from '../src/index.js';
import { loadConfig } from '../src/config.js';

export async function startServer(env = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-test-'));
  // a data dir that doesn't exist yet: the server must create it on first run
  const dataDir = path.join(root, 'data');
  const ctx = await createServer({ ...loadConfig(env), dataDir, port: 0, clientDist: path.join(root, 'none') });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  return {
    ...ctx,
    base,
    dataDir,
    async close() {
      await ctx.store.flush();
      await ctx.sessions.flush();
      ctx.hub.wss.close();
      ctx.server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  };
}

/** Minimal cookie-aware HTTP client. */
export function agent(base) {
  let cookie = '';
  const req = async (method, url, body, headers = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + url, {
      method,
      headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined
    });
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      if (k === 'gtd_session') cookie = v ? `gtd_session=${v}` : '';
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, body: data, headers: res.headers };
  };
  return {
    req,
    get cookie() { return cookie; },
    get: (u, h) => req('GET', u, undefined, h),
    post: (u, b, h) => req('POST', u, b, h),
    patch: (u, b, h) => req('PATCH', u, b, h),
    put: (u, b, h) => req('PUT', u, b, h),
    del: (u, h) => req('DELETE', u, undefined, h)
  };
}

export async function mcpClient(base, token) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const opts = token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {};
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), opts));
  return client;
}

export function callTool(client) {
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return r.content.map((c) => c.text).join('\n');
  };
}

export function openSocket(base, cookie) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: cookie ? { cookie } : {} });
  const messages = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  const opened = new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
  });
  return { ws, messages, opened };
}

export async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function makeWav(seconds, { sr = 22050, freq = 220, channels = 1 } = {}) {
  const n = Math.round(seconds * sr);
  const buf = Buffer.alloc(44 + n * 2 * channels);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2 * channels, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2 * channels, 28); buf.writeUInt16LE(2 * channels, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2 * channels, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 16000 * Math.exp((-3 * i) / n));
    for (let c = 0; c < channels; c++) buf.writeInt16LE(v, 44 + (i * channels + c) * 2);
  }
  return buf;
}

/** Parse a JSON-RPC response from the MCP endpoint (SSE "data:" event or plain JSON). */
export async function readRpc(res) {
  const text = await res.text();
  if (/^\s*[{[]/.test(text)) return JSON.parse(text);
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  return data.find((m) => 'result' in m || 'error' in m) || data.at(-1);
}
