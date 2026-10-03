---
name: test-and-qa
description: Run GreanTeaDawy's checks (lint, unit/integration, Playwright e2e), debug failures, and run a QA review round with the qa-reviewer agent before committing.
---

# Test & QA

## The checks

```bash
npm run lint        # ESLint, must be clean
npm test            # packages/core + server + client (node:test). Fast; run after every change.
npm run test:e2e    # builds the client, starts e2e/serve.mjs (fresh temp data, port 3199), runs e2e/*.spec.js
```

- Single file: `node --test --test-timeout=90000 server/test/security.test.js` (from the repo root), or
  `npx playwright test e2e/unhappy-paths.spec.js`.
- Playwright needs a Chromium: `npx playwright install chromium` (CI uses `--with-deps`). Traces of failures land in
  `test-results/` — open with `npx playwright show-trace <trace.zip>`.
- e2e files run alphabetically in one worker: `studio.spec.js` expects a fresh server (first-run setup), later specs
  sign in with `ADMIN` from `e2e/helpers.js`. `screenshots.spec.js` is skipped unless `SCREENSHOTS=1`.

## Where tests live

| Area | File |
|------|------|
| Core model, ops, music theory, MIDI, templates | `packages/core/test/core.test.js` |
| Audio analysis + streaming meter | `packages/core/test/analysis.test.js` |
| Spatial coordinates, layouts, ADM | `packages/core/test/spatial.test.js` |
| Plugin manifests, permissions, generated notes | `packages/core/test/plugins.test.js` |
| Browser DSP helpers, physical models | `client/test/dsp.test.js`, `client/test/models.test.js` (`npm test -w client`) |
| Accounts, sessions, tokens | `server/test/auth.test.js` |
| Hardening (sockets, races, scopes, setup code) | `server/test/security.test.js` |
| MCP happy paths incl. stdio bridge, render job | `server/test/mcp.test.js` |
| MCP edge cases | `server/test/mcp-edge.test.js` |
| REST/WS/store | `server/test/server.test.js` |
| MCP production tools, jobs, stems (fake browser) | `server/test/production.test.js` |
| ffmpeg (fake binary), export formats | `server/test/ffmpeg.test.js` |
| Spatial MCP tools + exports | `server/test/spatial.test.js` |
| Plugins: zip reader, install/trust, isolation, serving, MCP | `server/test/plugins.test.js` |
| Browser journeys | `e2e/studio.spec.js`, `e2e/unhappy-paths.spec.js`, `e2e/workflow*.spec.js` (production, band + ffmpeg, spatial, plugins incl. hostile plugins) |

Helpers: `server/test/helpers.js` (`startServer` with temp data dir, cookie `agent`, `mcpClient`, `callTool`,
`openSocket`, `makeWav`, `readRpc` for SSE responses), `e2e/helpers.js` (`connectMcp`, `makeWav`, `menuItem`).

## Manual checks

- `npm run dev`, open http://localhost:5173, create the admin, then connect Claude Code:
  `claude mcp add --transport http greanteadawy http://localhost:3001/mcp` and ask for a beat.
- Phone layout: Chrome devtools at 390×844 (one-finger drag pans grids, tap draws).
- Audio: export a WAV and listen; call `render_mix` and sanity-check LUFS/peaks.

## Debugging in a real browser

For audio/engine questions a throwaway script is faster than a spec: start `E2E_PORT=3299 node e2e/serve.mjs`, create
the admin with `POST /api/auth/setup`, then drive Chromium with `@playwright/test`'s `chromium.launch()` and
`page.evaluate(() => window.greanteadawy.render(project, { mode: 'pattern', encode: false }))` (also on `window.greanteadawy`:
`store`, `engine()`, `sync`). Measure buffers in the page; delete the script afterwards (never commit `e2e/_*`).
Watch `page.on('requestfailed')` — CSP/CORP blocks show up there, not as exceptions.

## QA round

After an iteration, run the `qa-reviewer` agent (`.claude/agents/qa-reviewer.md`) — split by area for big changes
(server/security, MCP+core, client/audio). Fix everything Critical/High/Medium, add a regression test per bug, re-run
all checks, then commit.
