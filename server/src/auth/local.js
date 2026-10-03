// "Is this request coming from this computer?" — used for conveniences that must never reach the network:
// token-less MCP and first-run setup without the setup code.
import { isLoopback } from '../config.js';

const LOOPBACK_IP = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'via', 'cf-connecting-ip'];

/**
 * True only for a direct request from this machine addressed to a localhost name. Never true when the server is
 * configured to sit behind a proxy (TRUST_PROXY) or to be served under a public URL: a proxy on the same machine makes
 * every visitor look local.
 */
export function isLocalRequest(req, { trustProxy = false, publicUrl = '' } = {}) {
  if (trustProxy) return false;
  if (publicUrl) {
    try { if (!isLoopback(new URL(publicUrl).hostname.replace(/^\[|\]$/g, ''))) return false; } catch { return false; }
  }
  if (!LOOPBACK_IP.test(req.socket?.remoteAddress || '')) return false;
  if (PROXY_HEADERS.some((h) => req.headers[h])) return false;
  let host = '';
  try { host = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
  return LOCAL_HOSTNAMES.has(host);
}
