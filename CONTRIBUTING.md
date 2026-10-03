# Contributing to GreanTeaDawy

Thanks for helping. GreanTeaDawy is a small project with one maintainer and little spare time, so reviews can take a
while. Forks are welcome too.

## Ways to help

- **Report a bug** with the [bug report form](https://github.com/vidux/GreanTeaDawy/issues/new?template=bug_report.yml).
  A project file (◆ menu → *Export project file (.json)*) or a short audio clip makes sound problems much easier to fix.
- **Suggest a feature** with the [feature request form](https://github.com/vidux/GreanTeaDawy/issues/new?template=feature_request.yml).
  Producers' workflows are especially valuable: say what you were making and where the studio got in the way.
- **Improve the docs** in [`docs/`](docs): a wrong step, a missing screenshot, an unclear explanation.
- **Write a plugin** (instrument, effect or note generator): see [docs/plugins.md](docs/plugins.md) and the examples
  in [`plugins/examples`](plugins/examples).
- **Improve the music-production skills** in [`skills/`](skills) that teach Claude to make beats and mix in the studio.
- **Fix bugs or build features.** For anything bigger than a small fix, open an issue first so we can agree on the
  approach before you spend time on it.

**Security problems** go to a private
[security advisory](https://github.com/vidux/GreanTeaDawy/security/advisories/new), never a public issue.

## Setting up

You need Node.js 20.19+ (22 LTS recommended). ffmpeg is optional (MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF exports).

```bash
npm install
npx playwright install chromium   # once, for the e2e tests
npm run dev                       # server on :3001 + Vite on :5173
```

Open http://localhost:5173 and create the admin account. Dev data goes to `./data` (git-ignored); delete it to start
over. [docs/development.md](docs/development.md) has the scripts, the repository layout and a map of the tests;
[docs/architecture.md](docs/architecture.md) explains how ops, live sync, browser jobs and the audio engine fit together.

## Rules the code follows

Reviews check these. The details are in [CLAUDE.md](CLAUDE.md) and [docs/development.md](docs/development.md).

- **Every project change is an op** (`packages/core/src/ops.js`), so the UI, MCP and REST share undo and live sync.
  `applyOps` is deterministic: random ids and colours are filled in by `prepareOps`.
- **Anything loaded from disk, imported or restored** goes through `normalizeProject`.
- **Instrument and effect param definitions** are the single source of truth for ranges, UI knobs and MCP validation.
- **Every project, sample and export belongs to a user.** Look data up by owner and answer 404 for anyone else's ids.
- **MCP tools** validate everything before the first change, explain errors so Claude can recover, and return the ids
  of what they created. See `.claude/skills/add-mcp-tool`.
- **Plugins are untrusted code**: the server never runs them, and everything they return is validated. Read
  `.claude/skills/plugin-system` before touching the plugin system.
- **Sound defaults change existing songs.** If you change a velocity curve, a limiter, a reverb or similar, keep levels
  comparable, compare a render before and after, and say so in `CHANGELOG.md`.
- **No new dependencies** without a good reason; licences must be MIT-compatible.
- ESM JavaScript, no TypeScript; 2-space indent, single quotes, semicolons, LF line endings (`.editorconfig`). Comments
  explain *why*, not *what*.

## Before opening a pull request

```bash
npm run lint && npm test   # always
npm run test:e2e           # when the client or the server↔browser protocol changed
npm run docs:mcp           # when an MCP tool or guide.js changed
npm run screenshots        # when the UI in the README screenshots changed
```

- Add tests with every fix and feature. Tests must use temp directories, never `./data`.
- Update the docs that describe what you changed, and add user-visible changes to `CHANGELOG.md` (under an
  `## Unreleased` heading at the top if there isn't one yet).
- Branch from `main` and keep one topic per pull request. The [pull request template](.github/pull_request_template.md)
  asks what changed, why, and how you tested it; include screenshots or audio for UI and sound changes.

CI runs lint, the unit tests, the Playwright tests and a Docker build on every push and pull request.

## Working with Claude Code

Much of GreanTeaDawy was written with Claude, and AI-assisted contributions are welcome. [CLAUDE.md](CLAUDE.md) gives
Claude Code the project's conventions, `.claude/skills/` has recipes for common changes (instrument, effect, MCP tool,
op, plugin, export format, release), and the `qa-reviewer` agent reviews a change before you commit. You are still
responsible for the pull request: read the diff, run the checks yourself, and be ready to explain it.

## Be kind

Treat everyone with respect, assume good intent, and remember that people of every skill level — in music and in
code — use and build this project.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
