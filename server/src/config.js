import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

/** Load <repo>/.env (if present) into process.env without overriding existing variables. */
export function loadDotEnv(file = path.join(ROOT_DIR, '.env')) {
  try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
  } catch { /* no .env file */ }
}

export function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function parseTrustProxy(v) {
  if (v === undefined || v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // e.g. "loopback" or a subnet list
}

/** A whole number from the environment, or the default when it's missing or not a number (then clamped). */
function envInt(v, def, min = -Infinity, max = Infinity) {
  const n = /^\s*-?\d+\s*$/.test(v ?? '') ? parseInt(v, 10) : def;
  return Math.min(max, Math.max(min, n));
}

export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  return {
    port: envInt(env.PORT, 3001, 0, 65535),
    host,
    // relative paths are relative to the repository root (npm scripts run from different folders)
    dataDir: path.resolve(ROOT_DIR, env.DATA_DIR || 'data'),
    clientDist: path.resolve(ROOT_DIR, env.CLIENT_DIST || path.join('client', 'dist')),
    // Legacy/bootstrap token for /mcp that acts as the first admin (prefer personal tokens from Settings)
    mcpToken: env.MCP_TOKEN || '',
    // Host header allow-list (DNS-rebinding protection). Defaults to localhost names when bound to loopback.
    allowedHosts: env.ALLOWED_HOSTS === '*'
      ? null
      : env.ALLOWED_HOSTS
        ? env.ALLOWED_HOSTS.split(',').map((s) => s.trim()).filter(Boolean)
        : isLoopback(host) ? ['localhost', '127.0.0.1', '[::1]'] : null,
    maxUploadMb: envInt(env.MAX_UPLOAD_MB, 50, 1, 2048),
    // Express "trust proxy" (set when running behind a reverse proxy / tunnel so HTTPS + client IPs are detected)
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    sessionTtlDays: envInt(env.SESSION_TTL_DAYS, 30, 1, 3650),
    publicUrl: env.PUBLIC_URL || '',
    // First-run setup code for servers reachable from other machines (auto-generated if empty)
    setupCode: env.SETUP_CODE || '',
    // ffmpeg for MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF exports: a path, empty = "ffmpeg" on the PATH, "off" = disabled
    ffmpegPath: env.FFMPEG_PATH || '',
    ffmpegTimeoutSec: envInt(env.FFMPEG_TIMEOUT_SEC, 300, 5, 24 * 3600),
    ffmpegMaxJobs: envInt(env.FFMPEG_MAX_JOBS, 2, 1, 64),
    // users may install plugins (admins can still switch it off in Settings → Server); "false" disables them entirely
    pluginsEnabled: !/^(false|0|off|no)$/i.test(env.PLUGINS_ENABLED || 'true')
  };
}
