# Security

GreanTeaDawy is built to be safe on your own computer by default and hardened enough to put on a server for a small
team. This page describes the model and a checklist for exposing it.

## Accounts and data

- Users have a username, display name, role (`admin` / `user`) and an optional personal API token.
- Every project, version, sample and export belongs to exactly one user. All routes and socket messages look data up
  by owner and return **404** for anything that isn't yours.
- The first account is created on the first visit (**setup**). Unless the request comes directly from the server's own
  computer, setup also requires a **setup code** printed in the server log (or set via `SETUP_CODE`), so a freshly
  deployed or proxied server can't be claimed by a stranger. Concurrent setup requests can't create two admins.
- Admins can create users, open registration, change roles, disable accounts, reset passwords and delete users together
  with their data. The last enabled admin can't be demoted, disabled or deleted.

## Passwords, sessions, tokens

| Secret | Storage | Notes |
|--------|---------|-------|
| Passwords | scrypt (N=16384, r=8, p=1, 16-byte salt) | constant-time compare; unknown users are hashed too (no timing oracle) |
| Session ids | SHA-256 of a 256-bit random id | `gtd_session` cookie: HttpOnly, SameSite=Lax, Secure on HTTPS; sliding expiry (`SESSION_TTL_DAYS`); max 20 per user |
| API tokens | SHA-256 of `gtd_<prefix>_<secret>` (192 bits) | shown once; regenerate/delete closes sockets using the old token |

- Changing your password signs out your other sessions; disabling or deleting a user ends all their sessions and
  sockets.
- API tokens act as their user but **cannot** use admin endpoints, change passwords or manage tokens (a signed-in browser
  session is required).
- Forgotten admin password: `npm run reset-password -- <username>` (server stopped).

## MCP access

- With a token (`Authorization: Bearer` or `?token=`): acts as the token's user.
- Without a token: only if an admin enables *Allow MCP without a token from this computer* (on by default for loopback
  installs), and only for requests that come from this machine (loopback address, no proxy headers such as
  X-Forwarded-For / X-Real-IP / Via) and are addressed to a localhost name. It is always off when `TRUST_PROXY` or a
  non-local `PUBLIC_URL` is configured (a proxy on the same machine would make every visitor look local). This blocks
  LAN clients, proxied visitors and DNS-rebinding pages. Such requests act as the configured default user.
- **Reverse proxies:** the server can only recognise a proxy by its headers. A proxy on the same machine that forwards
  requests *without* `X-Forwarded-For`/`X-Real-IP`/`Via` and rewrites `Host` to `127.0.0.1` (for example a bare nginx
  `proxy_pass` with no `proxy_set_header` lines) makes every visitor look local. Whenever a proxy is in front, set
  `PUBLIC_URL` (and `TRUST_PROXY`) — either one turns "local" treatment off completely — or turn off token-less MCP in
  Settings → Server.
- `MCP_TOKEN` (legacy shared token) acts as the first admin and disables token-less access.

## Web hardening

- **CSRF**: state-changing requests with an `Origin` must match the `Host` (or `PUBLIC_URL`); WebSocket upgrades are
  checked the same way. Cookies are SameSite=Lax.
- **DNS rebinding**: `Host` header allow-list (`ALLOWED_HOSTS`, defaults to localhost names on loopback).
- **Headers**: Content-Security-Policy (`script-src 'self'` — no `eval`; the studio can't be framed, and may only frame
  its own generator sandbox), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, HSTS over HTTPS, and
  `Permissions-Policy` (the microphone for the studio page itself — the recorder — and no camera, location, payment,
  USB, serial or HID for anyone). Sample files are served with a sandbox CSP and a content type derived from the
  validated extension.
- **Microphone**: only after the user clicks *Enable microphone* in the recorder (the browser asks too), only on a
  secure page (HTTPS or localhost), released when the recorder closes. Takes become ordinary uploads (`MAX_UPLOAD_MB`).
- **Sample library**: folders, moves, bulk deletes and usage lookups check ownership of every id first (404 for anything
  that isn't yours, nothing changed); "Replace original" keeps the sample id and only accepts the same audio formats as
  an upload; Claude's `edit_sample` runs in the user's own browser and saves through the same upload endpoints.
- **Rate limits**: login per username+IP (10/15 min), per username (100/15 min) and per IP (50/15 min); sign-up per IP;
  password changes per user; setup-code attempts per IP. Attempts are counted before the password is checked, so
  parallel bursts can't slip past. Limiter memory is bounded. Behind a proxy, set `TRUST_PROXY` so limits see real
  client IPs — and don't let clients reach the server around the proxy.
- **Limits**: 64 KB JSON for account endpoints, 1 MB for other API calls, 20 MB for project edits/imports (parsed only
  after authentication), `MAX_UPLOAD_MB` for samples, 4 GB for rendered audio (streamed to disk — the WAV format's
  own limit; long 7.1.4/ADM renders get big), 5000 ops per batch,
  8192 notes per channel per pattern, 64 KB browser-supplied analysis, 16 MB WebSocket frames. Malformed socket messages
  are ignored and protocol errors close only the offending socket.
- **Errors** never include stack traces; unexpected errors are logged server-side.
- WAV analysis of uploads runs in a worker thread, one at a time, with a memory cap, over at most the first 3 minutes.
- **ffmpeg** (optional, for MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF exports) only converts PCM/float WAVs in the user's
  exports folder (names validated, no hidden/temporary files, ownership enforced like every export; WAVs with any
  other codec inside are refused). It is run without a shell, with an argument array; input and output are `file:`
  paths with `-protocol_whitelist file`, a forced input format and the matching PCM decoder (`-f wav -c:a pcm_s24le`:
  no probing, so no playlists, network protocols or compressed-audio decoders on user data), channel counts are
  checked per format, metadata is reduced to known tags,
  single-line and length-limited, the output name is generated and reserved (never overwrites), the environment is
  stripped of secrets (only `PATH`/locale/temp variables), each run has a timeout (`FFMPEG_TIMEOUT_SEC`), at most
  `FFMPEG_MAX_JOBS` run at once and each user can have at most 3 conversions running or waiting. The binary comes
  only from `FFMPEG_PATH` or the `PATH` — never from a request.

## Plugins

Users can install their own instrument, effect and generator plugins ([plugins.md](plugins.md)). Plugin code is
untrusted, so the design is: **the user decides, the server never runs it, the browser runs it in places that have
nothing to steal, and everything it produces is treated as data.**

**Installing**
- Only from the signed-in studio (`requireSession`): API tokens — Claude, scripts — get 403. Two steps: `inspect`
  validates the upload and returns what the dialog shows (permissions, author, files, SHA-256); `install` needs that
  one-time token **and** `trust: true`, which the studio sends only after the user ticks *I trust … and want to install
  it* under a warning. Pending uploads expire after 15 minutes; at most 3 per user and 192 MB server-wide are held
  (oldest dropped first), and at most 4 plugin uploads are received and checked at once server-wide (others get 429).
- Admins can switch plugins off for everyone (`allowPlugins`), `PLUGINS_ENABLED=false` switches them off server-wide;
  open studios are told to reload either way. Plugins are stored per user (`DATA_DIR/plugins/<userId>/installed/<id>/`, the registry next to that folder), never
  visible to other users (404), deleted with the user.

**Validation** (server, before anything is stored)
- Zip reader written for this purpose: no absolute paths, `..`, backslashes, drive letters, empty segments, symlinks,
  encryption, ZIP64 or names that are both a file and a folder (hidden files and `__MACOSX/` are skipped, never
  extracted); ≤ 256 entries, 30 MB per file, 60 MB in total, compression ratio ≤ 200 for files over 1 MB
  (zip bombs are stopped while inflating, not after), CRC-32 and sizes verified. Uploads ≤ 20 MB.
- Manifest schema (`validateManifest` in core): id/version/type, parameter ranges, presets, sample zones, and
  **permissions** — only `audio-processing`, `samples`, `generator`, `project-read`, each only for the types that need
  it; `network`, `storage`, `files`, `account` & co. are refused by name.
- Only `.json .js .wav .mp3 .ogg .flac .md .txt .png` files; the manifest's `main` is the only script allowed; code
  ≤ 512 KB without `import` or `importScripts` (re-checked every time it's served); samples must be real audio (magic
  bytes). Installs are written to a temporary folder and renamed into place, under a per-user lock.

**Running** — the server never executes plugin code
- **DSP** (instruments, effects) is served only to its owner, only as `GET /api/plugins/:id/worklet.js`: the code inside
  a generated harness that throws unless it is evaluated in an `AudioWorkletGlobalScope`. The plugin gets a frozen `gtd`
  object and runs in a function scope that shadows the processor-registration API (a guard against mistakes — the
  boundary is the audio thread itself, see *What remains*). The audio thread has no network, DOM, cookies,
  storage or timers, and inherits the studio's CSP (no `eval`/`Function`, no dynamic `import`). Its output is cleaned
  (NaN/∞ → 0, clamped to ±8); a throwing effect is bypassed, a throwing voice ends; voices end ≤ 10 s after note-off
  and each channel is limited to the manifest's polyphony. Processor names include the package hash, so an update never
  reuses old code.
- **Generators** are served as `text/plain` (with `CSP: sandbox`), never as a script of the studio's origin. The studio
  posts the code and the run's input to `/sandbox/generator.html`, an iframe with `sandbox="allow-scripts"` (an opaque
  origin: no cookies, storage or same-origin API access) and its own CSP (`default-src 'none'`, `connect-src 'none'`,
  scripts only from itself and `blob:`). There, each run gets a fresh Worker with `fetch`, `XMLHttpRequest`,
  `WebSocket`, `importScripts`, `indexedDB`, `navigator` etc. removed, and is terminated after 2 s. The sandbox page
  only answers its parent; the studio only accepts replies from its own frame.
- **Output is data:** generated notes go through `cleanGeneratedNotes` (shape, ranges, ≤ 4096 notes, inside the
  requested range) before they become ops; parameter values are validated against the manifest (strictly for Claude);
  manifest text is length-limited, stripped of control characters and only ever rendered as text; `homepage` must be
  `https://` and is not a link; `color` must be `#rrggbb`.

**What remains** (why the trust warning exists): a plugin can make any sound — including very loud or silent — use CPU
while it plays, or behave differently from its description. DSP plugins share the audio thread of one studio tab with
the studio's own audio code and other plugins, so a malicious one could tamper with audio in that thread; it still
can't read the user's data or send anything anywhere. Install only plugins whose author you trust; turn plugins off
in Settings → Server if your users shouldn't install any.

## Checklist for a public server

1. Put it behind HTTPS (Caddy, nginx, Traefik, Cloudflare Tunnel…) and set `TRUST_PROXY` to the number of proxies.
2. Set `PUBLIC_URL=https://your.domain` and `ALLOWED_HOSTS=your.domain` — **required behind a proxy**, see
   *Reverse proxies* above.
3. Use `HOST=0.0.0.0` only inside a container or behind a firewall; note the setup code in the log on first start.
4. In Settings → Server keep **Open registration** off unless you want public sign-ups.
5. Give every MCP client a personal API token; prefer headers over `?token=` URLs (URLs end up in logs).
6. Decide whether your users may install plugins (Settings → Server → *Allow plugins*, or `PLUGINS_ENABLED=false`).
7. Back up `DATA_DIR` (see [deployment](deployment.md)).

## Reporting a vulnerability

Please open a private security advisory on the repository (or contact the maintainers) instead of a public issue.
