---
name: docs-and-release
description: Keep GreanTeaDawy's documentation, generated MCP reference and README screenshots up to date, and prepare a release (version bump, checks, Docker build).
---

# Docs & release

## Documentation map

| File | Contents | Update when |
|------|----------|-------------|
| `README.md` | overview, screenshots, quick start, config, links | user-visible changes |
| `docs/getting-started.md` | install, first run, connect Claude | setup/auth changes |
| `docs/user-guide.md` | studio features & shortcuts | UI changes (shortcuts: `client/src/lib/keyboard.js` `SHORTCUTS`) |
| `docs/claude-mcp.md` | connecting Claude, tokens, workflows, prompts | MCP behaviour changes |
| `docs/MCP.md` | **generated** tool reference | any tool/guide change → `npm run docs:mcp` |
| `docs/architecture.md` | modules, data flow, ops, sync, jobs, audio | structural changes |
| `docs/api.md` | REST + WebSocket protocol | routes/messages change |
| `docs/security.md` | auth model, tokens, hardening | auth/security changes |
| `docs/deployment.md` | reverse proxy, systemd, env vars, backups | config changes (`server/src/config.js`, `.env.example`) |
| `docs/docker.md` | image, compose, env vars, HTTPS profile, backups | Dockerfile / compose / config changes |
| `docs/spatial.md` | 3D objects, monitoring, speaker/ADM exports | spatial engine or export changes |
| `docs/plugins.md` | plugin authoring guide + install flow | manifest, harness, sandbox or plugin UI changes (also `docs/security.md#plugins`) |
| `docs/roadmap.md` | advisor reviews, what's done, what's next | each release |
| `CHANGELOG.md` | user-visible changes per version | every feature/fix |
| `skills/` | music-production skills for Claude Desktop / claude.ai | MCP tools, guide or workflows change (`npm run skills:pack`) |
| `docs/development.md` | contributing workflow | tooling changes |
| `CLAUDE.md` | conventions for Claude | conventions change |

## Screenshots

```bash
npm run screenshots   # builds, starts a throwaway server, drives the UI, writes docs/screenshots/*.png
```
The script (`e2e/screenshots.spec.js`) lays out windows deterministically; adjust it when the UI changes. Look at every
image before committing (Read the PNGs).

## Release checklist

1. `npm run lint && npm test && npm run test:e2e`
2. `npm run docs:mcp`, `npm run screenshots` if the UI changed; update `README.md` / docs.
3. Bump the version everywhere at once: `npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`
   (root, `packages/core`, `server`, `client` and `package-lock.json`). The MCP server's `VERSION` and the About
   dialog read their `package.json`, and a server test fails if the workspaces disagree. Then the tool counts in
   `README.md`, `docs/README.md`, `docs/claude-mcp.md` and `CLAUDE.md` (the count `npm run docs:mcp` prints).
4. `docker build -t greanteadawy .` and smoke-test: `docker run -p 3001:3001 -v greanteadawy-data:/data greanteadawy`,
   open the studio, note the setup code from the log.
5. Commit with a summary of user-visible changes; tag `vX.Y.Z`.
