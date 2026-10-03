# Running GreanTeaDawy with Docker

The image contains the server, the built studio and **ffmpeg** (so MP3, AAC, Ogg, Opus, FLAC, Apple Lossless and AIFF
exports work out of the box). It runs as the unprivileged `node` user, keeps all data in one volume (`/data`) and
has a health check.

## Quick start (this computer)

```bash
git clone <your copy of the repository> greanteadawy && cd greanteadawy
cp .env.example .env              # optional — every setting has a default
docker compose up -d --build
docker compose logs greanteadawy  # first run: note the "Setup code"
```

Open <http://localhost:3001>, create the admin account and enter the **setup code** from the log (inside Docker the
browser's requests come through Docker's network, so the server can't tell they're from this computer — the code
proves you can read its log). The compose file publishes the port on `127.0.0.1` only.

**Connect Claude**: in the studio open *Settings → API & MCP*, create a personal API token and use the MCP URL
`http://localhost:3001/mcp` with it (copy-paste setups for Claude Code and Claude Desktop are shown there). Token-less
MCP from "this computer" doesn't apply inside Docker for the same reason as above.

Check *Settings → Audio export*: it should say "ffmpeg … is available".

## Configuration

Compose reads `.env` next to `docker-compose.yml` and passes these variables to the container (everything is
optional):

| Variable | Compose default | What it does |
|----------|-----------------|--------------|
| `GTD_PORT` | `3001` | port on this computer (bound to 127.0.0.1) |
| `PUBLIC_URL` | `http://localhost:${GTD_PORT}` | the URL people use; Claude's download links and the allowed browser origin. Set `https://your.domain` behind the proxy |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | host names the server answers to (DNS-rebinding protection). Add your domain / LAN name |
| `TRUST_PROXY` | — | `1` behind the Caddy profile or another single reverse proxy |
| `SETUP_CODE` | random (in the log) | fix the first-run setup code instead |
| `SESSION_TTL_DAYS` | `30` | sign-in lifetime |
| `MAX_UPLOAD_MB` | `50` | sample upload limit |
| `MCP_TOKEN` | — | legacy shared MCP token (prefer personal tokens) |
| `FFMPEG_PATH` | ffmpeg in the image | `off` disables conversions |
| `FFMPEG_TIMEOUT_SEC` / `FFMPEG_MAX_JOBS` | `300` / `2` | conversion time limit / parallel conversions |
| `PLUGINS_ENABLED` | `true` | allow installing user plugins (admins can still switch it off in Settings → Server) |
| `DOMAIN` | `localhost` | (proxy profile) the domain Caddy gets a certificate for |

Inside the image `HOST=0.0.0.0`, `PORT=3001`, `DATA_DIR=/data` and `CLIENT_DIST=/app/client/dist` are fixed — change
the published port with `GTD_PORT`, not `PORT`.

## HTTPS for other computers (Caddy profile)

Point a DNS name at the machine, then in `.env`:

```bash
DOMAIN=beats.example.com
PUBLIC_URL=https://beats.example.com
ALLOWED_HOSTS=beats.example.com
TRUST_PROXY=1
```

```bash
docker compose --profile proxy up -d --build
```

Caddy ([deploy/Caddyfile](../deploy/Caddyfile)) obtains a Let's Encrypt certificate, serves ports 80/443 and proxies
to the app over the compose network without buffering (WebSockets and MCP's streamed responses need that). The app's
own port stays on 127.0.0.1. Claude then connects to `https://beats.example.com/mcp` with an API token. See
[security.md](security.md) for the checklist of a public server.

Using your own proxy instead (nginx, Traefik…): keep the `127.0.0.1` port mapping (or put the proxy on the compose
network), set the same four variables, disable proxy buffering for `/ws` and `/mcp` — examples in
[deployment.md](deployment.md).

**LAN without a domain**: change the port mapping to `"3001:3001"` and set `ALLOWED_HOSTS=<the machine's name or IP>`
and `PUBLIC_URL=http://<name or IP>:3001`. Traffic is unencrypted then; browsers also block audio input and some
features on non-HTTPS origins other than localhost.

## Data, backups, upgrades

Everything (accounts, projects, versions, samples, exports, installed plugins) is in the `greanteadawy-data` volume.

```bash
# backup (stops writes for a consistent copy)
docker compose stop greanteadawy
docker run --rm -v greanteadawy_greanteadawy-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/gtd-backup.tgz -C /data .
docker compose start greanteadawy

# restore into an empty volume
docker compose down
docker run --rm -v greanteadawy_greanteadawy-data:/data -v "$PWD":/backup alpine sh -c "tar xzf /backup/gtd-backup.tgz -C /data && chown -R 1000:1000 /data"
docker compose up -d

# upgrade
git pull && docker compose up -d --build
```

A bind mount works too (`- ./data:/data`), but the folder must be writable by uid 1000: `sudo chown -R 1000:1000 data`.

**Forgot the admin password?** The reset tool refuses to run while the server uses the data, so stop it first:

```bash
docker compose stop greanteadawy
docker compose run --rm --no-deps greanteadawy node server/src/cli/reset-password.js <username>   # prompts
docker compose start greanteadawy
```

## Hardening in the compose file

- runs as `node` (uid 1000), `no-new-privileges`, **all Linux capabilities dropped**;
- **read-only root filesystem** — only `/data` (volume) and a 256 MB `/tmp` tmpfs are writable;
- 1 GB memory limit, rotated logs (3 × 10 MB);
- the app port is published on 127.0.0.1 only; the health check calls `/api/health` (the only route that answers to
  any host name, and it reveals nothing);
- `tini` as PID 1 forwards signals (the server flushes its stores on SIGTERM) and reaps ffmpeg processes.

## Without Compose

```bash
docker build -t greanteadawy .
docker volume create greanteadawy-data
docker run -d --name greanteadawy --restart unless-stopped \
  -p 127.0.0.1:3001:3001 -v greanteadawy-data:/data \
  -e PUBLIC_URL=http://localhost:3001 -e ALLOWED_HOSTS=localhost,127.0.0.1 \
  --read-only --tmpfs /tmp:size=256m --cap-drop ALL --security-opt no-new-privileges \
  greanteadawy
docker logs greanteadawy      # setup code
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Invalid Host: …` (403) | add that name to `ALLOWED_HOSTS` |
| "Cross-origin request blocked" | set `PUBLIC_URL` to the exact URL in the browser's address bar |
| Setup asks for a code | it's in `docker compose logs greanteadawy` (or set `SETUP_CODE`) |
| `EACCES … /data` in the log | a bind-mounted folder isn't owned by uid 1000 (`chown -R 1000:1000`) |
| Claude's download links point to the wrong place | set `PUBLIC_URL` |
| Settings → Audio export says ffmpeg is missing | you set `FFMPEG_PATH`; remove it (the image's ffmpeg is on the PATH) |
| Container `unhealthy` | `docker compose logs greanteadawy`; the health check needs the server listening on 3001 inside the container |
