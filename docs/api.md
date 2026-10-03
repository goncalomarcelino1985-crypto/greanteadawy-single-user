# REST & WebSocket API

Everything the studio and the MCP tools do is available over HTTP, scoped to the authenticated user.

## Authentication

| Client | How |
|--------|-----|
| Browser | `gtd_session` cookie (HttpOnly, SameSite=Lax, Secure over HTTPS) from `/api/auth/login` or `/setup` |
| Scripts / MCP | `Authorization: Bearer gtd_…` personal API token (Settings → API & MCP) |
| WebSocket / MCP URL | cookie, Bearer, or `?token=gtd_…` |

State-changing browser requests must be same-origin (checked via the `Origin` header; `PUBLIC_URL` is also allowed).
Errors are JSON: `{ "error": "message" }` with a 4xx/5xx status; 401 responses include `"code": "AUTH_REQUIRED"`.

```bash
TOKEN=gtd_…
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/projects
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/projects/<id>/summary
curl -H "Authorization: Bearer $TOKEN" -F file=@kick.wav http://localhost:3001/api/samples
```

## Health

`GET /api/health` → `{ "ok": true }` without authentication (container/proxy health checks; it also answers to any
`Host`, unlike every other route).

## Accounts — `/api/auth`, `/api/me`, `/api/admin`

| Method & path | Notes |
|---|---|
| `GET /auth/status` | `{ setupRequired, setupCodeRequired, user, allowRegistration, mcpWithoutToken }` |
| `POST /auth/setup` | first run only: `{ username, password, displayName, setupCode? }` → admin + session |
| `POST /auth/login` | `{ username, password }`; rate-limited per user+IP, user and IP |
| `POST /auth/logout` | ends this session and closes its sockets |
| `POST /auth/register` | when registration is open |
| `GET /me` · `PATCH /me` | current user · `{ displayName }` |
| `POST /me/password` | `{ currentPassword, newPassword }` — **session only**, signs out other sessions |
| `GET /me/token` | token info (prefix, created, last used) — never the token itself |
| `POST /me/token` · `DELETE /me/token` | generate/regenerate (returns the raw token once) · revoke — **session only** |
| `GET/POST /admin/users`, `PATCH/DELETE /admin/users/:id` | admin, session only. PATCH: `displayName`, `role`, `disabled`, `password` |
| `GET/PATCH /admin/settings` | `allowRegistration`, `mcpWithoutToken`, `mcpDefaultUserId`, `allowPlugins` |

## Projects

| Method & path | Notes |
|---|---|
| `GET /projects` | your projects (metadata), newest first |
| `POST /projects` | `{ name, bpm?, key?, template? }` or `{ project }` (import) |
| `GET /projects/:id` · `/meta` · `/summary` | full JSON · metadata · plain-text summary (what Claude reads) |
| `DELETE /projects/:id` | with its versions |
| `POST /projects/:id/duplicate` | `{ name? }` |
| `POST /projects/:id/ops` | `{ ops: [...], clientId?, source? }` → `{ rev, project }` — see [architecture](architecture.md#ops-the-only-way-to-edit) and `packages/core/src/ops.js` for op types |
| `POST /projects/:id/undo` | revert the last MCP change `{ force? }` |
| `GET/POST /projects/:id/versions` | list · save `{ name? }` |
| `POST /projects/:id/versions/:vid/restore` · `DELETE …/:vid` | |
| `GET /projects/:id/export` | project file (.json) |
| `GET /projects/:id/midi?mode=song|pattern&patternId=` | MIDI download |
| `POST /projects/:id/export-midi` | save MIDI to your exports → `{ name, url, bytes }` |
| `GET/PUT /active` | the active project `{ projectId }` |
| `GET /status` | active project, open browser tabs |
| `GET /catalog` · `/templates` | instruments & effects with params · templates |

## Samples & exports

| Method & path | Notes |
|---|---|
| `GET /samples` | your sample library (metadata + analysis; `folderId` null = unfiled, `rev` = audio revision) |
| `POST /samples` | multipart field `file` (wav, mp3, ogg, opus, flac, aiff, aac/m4a, webm; `MAX_UPLOAD_MB`), optional `folderId` and `name` |
| `GET /samples/:id` · `/info` · `/file` | record · compact description (with the folder name) · the audio (cached as immutable: add `?v=<rev>`) |
| `PATCH /samples/:id` | `{ name?, folderId?, analysis?, duration?, rev? }` (analysis ≤ 64 KB, from the browser; `folderId: null` = unfiled; names ≤ 80 characters with something visible in them). Send the `rev` the analysis was made from: **409** when the audio was replaced since (analyse again) |
| `PUT /samples/:id/file` | multipart `file`: new audio for the sample (the wave editor's *Replace original*) — same id, `rev` + 1, analysed again |
| `DELETE /samples/:id` | |
| `POST /samples/delete` | `{ ids: [...] }` (≤ 500) — all are checked first: one unknown id deletes nothing → `{ deleted }` |
| `POST /samples/move` | `{ ids: [...], folderId }` (`null` = unfiled) → `{ moved }` |
| `POST /samples/usage` | `{ ids: [...] }` → `{ [id]: [{ projectId, projectName, channels: [names], clips }] }` — sampler channels and audio clips in your projects |
| `GET /samples/folders` | `[{ id, name, count, createdAt }]` A–Z |
| `POST /samples/folders` | `{ name }` (1–40 characters, unique ignoring case, not "Unfiled"; ≤ 200 folders) → `201` |
| `PATCH /samples/folders/:id` · `DELETE /samples/folders/:id` | rename · delete (its samples become unfiled → `{ unfiled }`) |
| `GET /exports` · `GET /exports/:name` · `DELETE /exports/:name` | renders (WAV, MP3, M4A, Ogg, Opus, FLAC, AIFF) and MIDI files |
| `GET /exports/formats` · `GET /system/ffmpeg` | `{ ffmpeg: { available, version, reason, checkedAt }, formats: [{ id, label, ext, lossless, available, encoder, bitrates?, defaultBitrate?, reason? }] }` |
| `POST /system/ffmpeg/refresh` | admin (session): detect ffmpeg again (after installing it) |
| `POST /exports/:name/convert` | `{ format: mp3\|aac\|ogg\|opus\|flac\|alac\|aiff, bitrate?, metadata?: { title, artist, album, genre, date, comment } }` → `201 { export: { name, url, bytes, format, encoder, bitrate, bitDepth } }`. Converts one of your WAV exports with ffmpeg into a new file next to it (never overwrites). Errors: 400 (unknown format/bitrate, not a PCM/float WAV), 409 (ffmpeg or the encoder missing), 422 (too many channels for the format, a multichannel WAV without speaker positions for a lossy format, or ffmpeg failed — with its reason), 429 (3 conversions of yours already running/waiting), 504 (timeout) |
| `POST /exports` | multipart `file` (a WAV rendered in the browser, ≤ 4 GB) + `name` — e.g. stems from the File menu; never overwrites (adds `-2`, `-3`…) |

## Plugins

Per user; see [plugins.md](plugins.md). Installing and changing plugins needs a **browser session** (API tokens get
403); everything answers 403 when plugins are turned off and 404 for other users' plugins.

| Method & path | Notes |
|---|---|
| `GET /plugins` | `{ allowed, plugins: [{ id, name, version, type, enabled, installedAt, sha256, bytes, manifest }] }` |
| `POST /plugins/inspect` | multipart `file` (.zip, ≤ 20 MB) → `{ token, sha256, manifest, files, totalBytes, update: { from } \| null }` — validated, held for 15 min, nothing installed |
| `POST /plugins/install` | `{ token, trust: true }` → `201` the installed entry (`trust` must be exactly `true`: the user confirmed the warning) |
| `PATCH /plugins/:id` · `DELETE /plugins/:id` | `{ enabled }` · remove |
| `GET /plugins/:id/worklet.js` | DSP plugins: the AudioWorklet module (harness + code); 409 when disabled |
| `GET /plugins/:id/code` | generators: the code as `text/plain` (for the sandbox iframe) |
| `GET /plugins/:id/samples/<file>` | a sample listed in the manifest |
| `GET /sandbox/generator.html` · `.js` | the generator sandbox page (own CSP, opaque origin) |

## Browser jobs

| Method & path | Notes |
|---|---|
| `POST /jobs` | `{ job: { kind: 'render' \| 'analyze-sample' \| 'sound' \| 'export-stems' \| 'spatial' \| 'generator' \| 'sample-edit', … }, projectId?, timeoutMs? }` — waits for a browser tab of yours to run it (used by the stdio bridge; up to 5 min, 15 min for spatial, 30 min for stems) |
| `POST /jobs/:id/result` | multipart: `result` (JSON) + optional `file` (WAV) — sent by the browser |
| `POST /jobs/:id/files` | multipart `file` (WAV) + `name` — one stem of a running `export-stems` job |
| `POST /broadcast` | `{ type: 'transport' | 'open', projectId, command? }` — play/stop/open in your tabs |

## WebSocket `/ws`

JSON messages. Connect with the session cookie (or `?token=`); the socket closes with code **4401** when the session or
token is revoked.

Client → server

| type | fields |
|------|--------|
| `hello` | `clientId` |
| `subscribe` | `projectId`, `makeActive?` |
| `ops` | `projectId`, `ops`, `opId` |
| `resync` | — |
| `job-progress` / `job-error` | `jobId`, `progress` (0..1) / `message` |
| `ping` | `t` |

Server → client

| type | fields |
|------|--------|
| `welcome` | `activeProjectId`, `activity` |
| `project` | `project` (authoritative state) |
| `ack` / `reject` | `opId`, `rev` / `message`, `project`, `gone` (project deleted) |
| `ops` | `projectId`, `ops` (prepared), `rev`, `source` (`ui`, `mcp`, `api`), `clientId`, `descriptions` |
| `activity` | `source`, `text`, `time`, `projectId` |
| `job` | `jobId`, `job` |
| `transport` | `action` (`play`, `stop`, `audition`), … |
| `open` | `projectId` |
| `projects-changed` · `samples-changed` · `versions-changed` · `plugins-changed` | refresh hints |
| `error` | `message`, `status`, `request` |
| `pong` | `t` |

## MCP endpoint

`POST /mcp` — stateless Streamable HTTP (each request is independent; responses are SSE so long tools can stream
progress). `GET`/`DELETE` return 405. See [claude-mcp.md](claude-mcp.md) and [MCP.md](MCP.md).
