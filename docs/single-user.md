# Private single-user studio

This fork preserves the upstream MIT license and music engine. With `SINGLE_USER=true`, it provisions one internal owner (`goncalo`) and an empty project. There is no signup, login, password form or user-management screen in normal use. Account creation, password changes and admin routes are also blocked on the server. Existing multi-user data directories are rejected; use a dedicated service and data directory.

## Access

Set a cryptographically random `PRIVATE_ACCESS_KEY` (32 random bytes encoded as base64url). For local generation, use `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` in your own terminal and store it in the ignored `.env` or Render environment settings. Never commit it or place it in client variables.

Open `https://YOUR-STUDIO/access#YOUR-PRIVATE-KEY` once on each trusted browser. The fragment stays out of HTTP request URLs and referrers. The page immediately removes it from browser history, then exchanges it through a same-origin JSON POST for a signed, HttpOnly, Secure, SameSite=Strict, host-only cookie. Subsequent visits to `/` open the studio directly. Keep the original private link in a password manager; anyone possessing it can authorize a browser. The default authorization lasts 30 days (`SESSION_TTL_DAYS`, capped at 365). Clearing browser data requires opening the private link again.

Only the access bootstrap page/script and minimal health check are public. Studio assets, REST resources, uploaded samples, exports and WebSocket upgrades require valid authorization. Query-string tokens and upstream login cookies are rejected. HTTP origin checks, CSP and host validation remain enforced.

To revoke all browser access, replace `PRIVATE_ACCESS_KEY` with a newly generated value and deploy (a restart of the previous deployment does not apply saved environment changes). This invalidates old links and cookies. Normal restarts with the same key preserve browser authorization even if the ephemeral owner record has been recreated. Open sockets are checked for cookie expiry and are closed on service replacement. Individual browser sessions cannot be revoked remotely; rotate the key to revoke all of them.

## Dedicated Render Free service

Use only this fork, `main`, Node 22, Frankfurt, plan `free`:

- Build: `npm ci --include=dev && npm run build`
- Start: `npm start`
- `NODE_ENV=production`, `NODE_VERSION=22`, `HOST=0.0.0.0`
- `SINGLE_USER=true`, `EPHEMERAL_STORAGE=true`
- `PUBLIC_URL=https://YOUR-STUDIO.onrender.com`
- `ALLOWED_HOSTS=YOUR-STUDIO.onrender.com`, `TRUST_PROXY=1`
- `SESSION_TTL_DAYS=30`, `PRIVATE_ACCESS_KEY` set as a secret value
- Optional health-check path: `/api/health` (otherwise Render uses its default TCP check)
- Keep automatic deploys off during music sessions; deployment clears ephemeral files.

Configuration is managed through the Render service environment, not a Blueprint. Never reuse another application's service or data directory. `MCP_TOKEN` is deliberately disallowed in this mode; use separate personal API tokens below.

## Storage limitation

Render Free loses local files on restart, redeploy and idle spin-down. This includes projects, audio, versions, exports and generated API-token records. A surviving access cookie does **not** imply surviving music. This service is a validation studio until persistent storage or a verified backup-and-restore workflow is in place. The interface displays this limitation. Project JSON export alone does not necessarily include all audio assets; preserve original samples separately and verify restoration. No source music is bundled in the repository.

## Next music / MCP step

1. Resolve storage and verify recovery of a disposable project and audio file before importing real music.
2. Obtain the user's local `Narcotic Thrust - Safe From Harm (Main Mix).mp3`; do not download substitutes or modify the original. Preserve a local copy and checksum.
3. Import a copy through the sample library and place it on a dedicated reference track. Save a baseline version before any edit.
4. In Settings → API & MCP, generate a separate API token. Connect a client to `/mcp` with `Authorization: Bearer <token>` using the client's secret storage. Do not use the private browser link as an MCP credential. Token rotation/revocation remains available; Render Free restarts require a new API token.
5. Keep the studio open for browser audio/analysis jobs. Start with read-only `list_projects`, project inspection, sample listing and tool discovery. Validate that an edit to a disposable bass track leaves the other tracks intact before applying music changes.
6. Only after user validation proceed toward the Tech House/Techno arrangement around 127 BPM. No automatic music edits are included in this deployment.

## Validation

`npm run lint`, `npm test`, `npm run build`. `server/test/private-studio.test.js` covers anonymous rejection, owner provisioning, blocked account management, WebSocket access, token separation/revocation, key rotation, expiry, secure cookies, bootstrap throttling and a fresh ephemeral instance. Existing upstream tests still exercise normal multi-user mode.
