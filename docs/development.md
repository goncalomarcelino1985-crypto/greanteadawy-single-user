# Development

## Setup

```bash
npm install
npx playwright install chromium   # once, for the e2e tests
npm run dev                       # server on :3001 (node --watch) + Vite on :5173
```

Open http://localhost:5173. Dev data goes to `./data` (git-ignored); delete it to start over.

## Scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | server + client with hot reload |
| `npm run build` | production build of the client (`client/dist`) |
| `npm start` | production server |
| `npm test` | unit & integration tests (core, server and client, `node:test`) |
| `npm run lint` | ESLint over the whole repo |
| `npm run test:e2e` | build + Playwright end-to-end tests against a throwaway server |
| `npm run screenshots` | regenerate `docs/screenshots/*.png` |
| `npm run docs:mcp` | regenerate `docs/MCP.md` from the tool definitions |
| `npm run mcp` | run the stdio MCP server (what Claude Desktop launches) |
| `npm run reset-password -- <user>` | reset a password from the command line |
| `npm run plugin:pack -- <folder>` · `-- --examples` | validate a plugin folder with the server's install check and zip it into `plugins/dist/` |
| `npm run skills:pack` | check and zip the music-production skills in `skills/` into `skills/dist/` (for Claude Desktop / claude.ai) |

## Repository layout

```
packages/core   shared model, ops, music theory, analysis (browser + Node, no platform APIs)
server          Express + WebSocket hub + MCP (src/mcp) + auth (src/auth)
client          React UI (components/), state (state/), audio engine (audio/), helpers (lib/)
e2e             Playwright specs
plugins         example plugins (examples/) and packed zips (dist/, from `npm run plugin:pack`)
docs            documentation (MCP.md is generated)
scripts         maintenance scripts (MCP docs, plugin and skill packing; password reset lives in server/src/cli)
skills          music-production skills for Claude users (not for developing — those are in .claude/skills)
.claude         skills and agents for developing with Claude Code (see CLAUDE.md)
```

## Conventions

- ESM JavaScript everywhere, Node ≥ 20.19, no TypeScript. 2-space indent, single quotes, semicolons.
- `npm run lint` must pass; tests accompany every bug fix and feature.
- **All project changes are ops** (`packages/core/src/ops.js`). Ops must be deterministic — generated ids belong in
  `prepareOps`.
- Param catalogs (`instruments.js`, `effects.js`) are the single source of truth for ranges, UI and validation.
- Server code always scopes data by owner (`getOwned`, `samples.get(id, userId)`).
- MCP tools validate before changing anything, explain errors so Claude can recover, and return created ids.
- React: subscribe to narrow store slices; don't put `useStore.getState()` in dependency arrays.
- No new runtime dependency without a reason; licences must be MIT-compatible.

Step-by-step recipes live in `.claude/skills/`: add an instrument, add an effect, add an MCP tool, add a project op,
spatial audio, the plugin system, writing a plugin, export formats, testing & QA, docs & release.

## Tests

| Suite | Location |
|-------|----------|
| core model/ops/theory/MIDI/templates | `packages/core/test/core.test.js` |
| audio analysis & streaming meter | `packages/core/test/analysis.test.js` |
| spatial coordinates, speaker layouts, ADM | `packages/core/test/spatial.test.js` |
| plugin manifests, permissions, generated-note cleaning | `packages/core/test/plugins.test.js` |
| browser DSP helpers (compressor makeup model, clip curve) | `client/test/dsp.test.js` |
| physical models (piano, guitar, bass, pizzicato) | `client/test/models.test.js` |
| auth & accounts | `server/test/auth.test.js` |
| hardening (sockets, races, scopes) | `server/test/security.test.js` |
| MCP (incl. stdio bridge, render job) | `server/test/mcp.test.js`, `server/test/mcp-edge.test.js` |
| MCP production tools, jobs & exports (fake browser) | `server/test/production.test.js` |
| REST, WebSocket, store | `server/test/server.test.js` |
| ffmpeg detection & conversion (fake ffmpeg), export formats | `server/test/ffmpeg.test.js` |
| spatial MCP tools and exports | `server/test/spatial.test.js` |
| plugins: zip reader, install/trust flow, isolation, serving, MCP tools | `server/test/plugins.test.js` |
| browser journeys | `e2e/studio.spec.js`, `e2e/unhappy-paths.spec.js`, `e2e/workflow.spec.js` (production tools, analyze_sound, stems), `e2e/workflow-band.spec.js` (band instruments, ffmpeg export), `e2e/workflow-spatial.spec.js` (3D exports), `e2e/workflow-plugins.spec.js` (trust dialog, DSP/sample plugins in renders, generator sandbox, hostile plugins) |

CI (`.github/workflows/ci.yml`) runs lint, unit tests and e2e on every push.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to report bugs, propose features and open pull requests. In short:

1. Fork, branch from `main`.
2. Make the change with tests; run `npm run lint && npm test && npm run test:e2e`.
3. Update docs (and `npm run docs:mcp` / `npm run screenshots` when relevant).
4. Open a pull request describing the user-visible change.

By contributing you agree that your contribution is licensed under the MIT licence.
