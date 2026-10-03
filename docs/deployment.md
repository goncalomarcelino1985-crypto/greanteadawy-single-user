# Deployment

## Configuration

All settings are environment variables (or a `.env` file in the repository root — see `.env.example`).

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3001` | HTTP port |
| `HOST` | `127.0.0.1` | interface to listen on; keep `127.0.0.1` behind a proxy on the same machine, `0.0.0.0` for Docker/LAN |
| `DATA_DIR` | `./data` | projects, versions, samples, exports, `users.json`, `sessions.json` |
| `PUBLIC_URL` | — | external URL (download links for Claude, allowed browser origin) |
| `ALLOWED_HOSTS` | localhost names on loopback, otherwise off | comma-separated `Host` allow-list; `*` disables |
| `TRUST_PROXY` | off | Express "trust proxy": number of proxy hops (recommended), or a subnet list. Avoid `true`: any client could then fake its IP with X-Forwarded-For |
| `SESSION_TTL_DAYS` | `30` | sign-in lifetime (sliding) |
| `SETUP_CODE` | random, printed in the log | code required to create the first admin from another computer or through a proxy |
| `MCP_TOKEN` | — | legacy shared MCP token (acts as the first admin; disables token-less MCP) |
| `MAX_UPLOAD_MB` | `50` | max sample upload |
| `FFMPEG_PATH` | `ffmpeg` on the `PATH` | ffmpeg for MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF exports; `off` disables (WAV always works) |
| `FFMPEG_TIMEOUT_SEC` | `300` | a conversion that takes longer is killed |
| `FFMPEG_MAX_JOBS` | `2` | conversions at the same time (others queue) |
| `PLUGINS_ENABLED` | `true` | allow users to install their own plugins ([plugins.md](plugins.md)); admins can also switch them off in Settings → Server |
| `CLIENT_DIST` | `client/dist` | built web UI to serve |
| `GREANTEADAWY_URL` | `http://127.0.0.1:3001` | stdio MCP bridge / Vite dev proxy target |
| `GREANTEADAWY_TOKEN` | — | API token used by the stdio bridge |

## Docker

The image bundles ffmpeg, runs as a non-root user with a health check, and `docker-compose.yml` adds a read-only root
filesystem, dropped capabilities and an optional Caddy HTTPS proxy:

```bash
cp .env.example .env && docker compose up -d --build
docker compose logs greanteadawy        # shows the first-run setup code
```

Everything about it — configuration, the HTTPS profile, backups, upgrades, password resets — is in
**[docker.md](docker.md)**.

## Behind a reverse proxy

WebSockets (`/ws`) and SSE responses (`/mcp`) must be proxied without buffering.

**Caddy**

```
beats.example.com {
  reverse_proxy 127.0.0.1:3001
}
```

**nginx**

```nginx
server {
  server_name beats.example.com;
  # renders are uploaded from the browser: a 24-bit stereo song is ~15 MB per minute, a 7.1.4 render ~100 MB per
  # minute (the server accepts up to 4 GB per file); uploads need a signed-in user or an API token
  client_max_body_size 4g;
  proxy_request_buffering off;
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    # browser jobs (renders, stems, spatial exports) can take up to 30 minutes before the answer comes back
    proxy_read_timeout 1900s;
    proxy_send_timeout 1900s;
  }
}
```

Then set `TRUST_PROXY=1`, `PUBLIC_URL`, `ALLOWED_HOSTS`. (Caddy has no body-size limit by default; with other
proxies allow large uploads too, or long exports fail with 413.) MCP clients connect to `https://beats.example.com/mcp` with a
personal token.

> **Always set `PUBLIC_URL` behind a proxy.** Without it, a proxy that doesn't add `X-Forwarded-For` and rewrites
> `Host` to `127.0.0.1` (nginx does both if you leave out the `proxy_set_header` lines) makes every visitor look like
> they're on the server itself — so token-less MCP and first-run setup without a code would be open to them.
> `PUBLIC_URL` or `TRUST_PROXY` switches that local treatment off. See [security](security.md#mcp-access).

## systemd (without Docker)

```ini
[Unit]
Description=GreanTeaDawy
After=network.target

[Service]
WorkingDirectory=/opt/greanteadawy
Environment=NODE_ENV=production HOST=127.0.0.1 PORT=3001 DATA_DIR=/var/lib/greanteadawy
ExecStart=/usr/bin/node server/src/index.js
Restart=on-failure
User=greanteadawy

[Install]
WantedBy=multi-user.target
```

Build first: `npm ci && npm run build`.

## Backups

Everything lives in `DATA_DIR` (relative paths are resolved against the repository root). Files are written atomically
(temp file + rename), so a plain copy is consistent enough for most uses; for a perfectly quiet snapshot stop the server
first. A `server.lock` file marks a running server; maintenance commands such as `npm run reset-password` refuse to run
while it is present and the process is alive.

```bash
tar czf greanteadawy-backup-$(date +%F).tgz -C /var/lib greanteadawy
```

Restore by extracting into `DATA_DIR` while the server is stopped.

## Upgrading

Pull the new version, `npm ci && npm run build`, restart. Projects are normalised on load, so older project files keep
working.
