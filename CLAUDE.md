# GreanTeaDawy — notes for Claude

GreanTeaDawy is a pattern-based browser DAW (channel rack, step sequencer, piano roll, playlist,
mixer, automation) with an MCP server so Claude can produce music in it. Node.js ≥ 20.19 backend, React +
Web Audio frontend, plain ESM JavaScript (no TypeScript), MIT licensed.

## Layout

```
packages/core/   @greanteadawy/core — shared by server AND browser (keep it dependency-light, no Node/DOM APIs)
  src/model.js        project shape, create*/normalizeProject (repairs anything loaded from disk/imports)
  src/ops.js          applyOps/prepareOps: EVERY edit is an op (UI, MCP, REST); describeOps for the activity log
  src/instruments.js  instrument catalog + presets (param defs drive the UI knobs AND MCP validation),
                      INSTRUMENT_CATEGORIES = Browser sections / + Channel submenus
  src/effects.js      effect catalog (same idea); automatable params are backed by AudioParams in the client
  src/spatial.js      3D object coordinates, speaker layouts (5.1/7.1/7.1.4), panning gains, ADM XML
  src/plugins.js      plugin manifest validation, permissions, param values, cleaning generator output
  src/music.js        notes, scales, chords, roman numerals     src/notation.js  step strings ("x---x---")
  src/builders.js     chord/bass/melody/roll generators          src/templates.js genre starter projects
  src/analysis.js     LUFS/peak/spectrum/tempo/key/pitch + createLevelMeter (streaming, used for render stems)
  src/audioedit.js    sample edits on clips { sampleRate, channels } (cut/paste/fades/gain/normalize/reverse/speed/stretch…),
                      applyEdit = one named op (what edit_sample sends); every op returns a NEW clip (undo keeps old ones)
  src/autotune.js     YIN pitch tracking, vibrato-proof note segmentation, correction curve, TD-PSOLA, WSOLA, pitch shift
  src/midi.js wav.js (multichannel/extensible + extra chunks) summary.js timeline.js constants.js
server/src/
  index.js            createServer(): express app, security headers, auth, /api, /mcp, static client, WebSocket hub
  auth/               users.js (scrypt, API tokens gtd_…), sessions.js (cookie gtd_session), http.js, routes.js
  store.js            per-user JSON project store, per-project lock, undo stack for MCP edits, versions
  samples.js          per-user sample library + folders (folders.json), usage scan, replace (rev), WAV analysis in a worker
  hub.js              WebSocket live sync, activity log, transport relay, browser "jobs" (render/analyse/generate)
  api.js              REST routes          backend.js  local/remote backend used by MCP tools
  ffmpeg.js           optional ffmpeg detection + safe conversions (MP3/AAC/Ogg/Opus/FLAC/ALAC/AIFF)
  plugins.js zip.js sandbox.js   user plugins: store + worklet harness, hardened zip reader, generator sandbox page
  mcp/                tools.js (server factory), tools/*.js (78 tools; production.js = groove/fills/transitions,
                      export.js, spatial.js, plugins.js), guide.js (what Claude reads: notation + mixing-by-numbers),
                      prompts.js, http.js, stdio.js
client/src/
  state/store.js      zustand store: auth, project (optimistic ops + undo/redo), UI windows/prefs
  state/sync.js       WebSocket client: outbox, acks/rejects, resync, remote ops, jobs, deleted-project recovery
  audio/              engine.js (graph + lookahead Transport), instruments.js, effects.js, render.js (offline),
                      band.js + models.js + modelPool.js/modelWorker.js (physical models pre-rendered in workers),
                      world.js (flutes, beatbox, Indian & East Asian voices; their strings are models.js models),
                      spatial.js (SpatialRig: binaural / speakers / objects), plugins.js (plugin voices & effects),
                      editWorker.js (slow sample edits, pitch analysis/correction off the main thread)
  lib/                actions.js, jobs.js (browser jobs for MCP), sandbox.js (generator iframe), keyboard.js, hooks.js,
                      version.js (app name + version from client/package.json, shown in the About dialog),
                      audioEdit.js (decode at native rate, worker calls, WAV save/replace, the sample-edit job),
                      recorder.js (MicSession: getUserMedia → AudioWorklet capture, meter, monitor)
  components/         SampleLibrary.jsx (Samples tab: folders, search, select mode), WaveEditor.jsx + PitchView.jsx,
                      Recorder.jsx
                      … one file per window (Playlist, ChannelRack, PianoRoll, Mixer, …) + ui/ primitives
client/public/        recorder-worklet.js (served as /recorder-worklet.js: CSP script-src 'self' allows addModule)
e2e/                  Playwright specs (real browser + MCP client acting as Claude)
plugins/examples/     example plugins (npm run plugin:pack -- --examples → plugins/dist/*.zip)
skills/               music-production skills for Claude Desktop / claude.ai users (npm run skills:pack)
docs/                 user & developer docs; docs/MCP.md is generated
```

## Commands

```bash
npm install
npm run dev          # server :3001 + Vite :5173 (proxy /api /mcp /ws)
npm test             # core, server and client unit/integration tests (node:test)
npm run lint         # ESLint (must be clean)
npm run test:e2e     # builds the client, runs Playwright against a throwaway server (port 3199)
npm run screenshots  # regenerates docs/screenshots/*.png
npm run docs:mcp     # regenerates docs/MCP.md from the live tool definitions
npm run plugin:pack -- <folder> | --examples   # validate + zip a plugin
npm run skills:pack  # zips skills/* for upload to Claude Desktop / claude.ai (skills/dist)
npm start            # production server (serves client/dist)
```

Before finishing any change: `npm run lint && npm test`, and `npm run test:e2e` when the client or the
server↔browser protocol changed. Update docs (and `npm run docs:mcp` for tool changes).

## Core conventions (read before editing)

- **Time**: ticks, `PPQ = 96` per beat, `STEP = 24` (a 16th). Bars come from `ticksPerBar(project)` (time-sig aware).
  MCP tools speak 16th-note *steps* (0-based inside patterns) and *bars/tracks* (1-based); bar ranges are inclusive.
- **Ops are the only way to change a project.** Add a new op type in `core/src/ops.js` (+ `prepareOps` if it creates
  ids, + `describeOps`) rather than mutating projects anywhere else. `applyOps` must be deterministic: random ids/colours
  are filled in by `prepareOps` *before* applying, so the sender, the server and other tabs build identical projects.
- **Normalize at the boundary**: anything loaded from disk, imported or restored goes through `normalizeProject`.
- **Param definitions are the single source of truth** for instruments/effects (ranges, units, automatable).
  Use `sanitizeParams(defs, params, { strict: true })` for validated input (MCP), non-strict to clamp.
- **Ownership**: every project/sample/export belongs to a user. Server code must use `store.getOwned(id, userId)` /
  `samples.get(id, userId)` — never return another user's data, and respond 404 (not 403) for foreign ids.
- **Auth**: browser = `gtd_session` cookie; scripts/MCP = personal API token `gtd_…` (Bearer or `?token=` for MCP/WS).
  Tokens can't use `/admin/*`, `/me/password` or token management (`auth.requireSession`). Token-less MCP only works
  from this computer when the admin allows it (`isLocalRequest` in `mcp/http.js`).
- **MCP tools** (`server/src/mcp/tools/*.js`): zod input schemas with `.describe()` on every non-obvious field,
  annotations from `util.js`, errors thrown as `Error` (the wrapper turns them into `isError` results with a message
  that tells Claude how to recover), replies that include the ids of created things in `[brackets]`. Validate
  everything *before* the first `backend.applyOps` so a failed call changes nothing.
- **Browser jobs**: work that needs Web Audio or the plugin sandbox (`render`, `analyze-sample`, `sound`,
  `export-stems`, `spatial`, `generator`; `JOB_KINDS` in `api.js`) runs in the user's tab via `hub.requestJob` → WS
  `job` → `client/src/lib/jobs.js` → `POST /api/jobs/:id/result` (stems upload each file to `/api/jobs/:id/files`
  first). Progress is forwarded to MCP progress notifications.
- **Client state**: subscribe to the narrowest slice (`useStore((s) => s.x)`); never put `useStore.getState()` in a
  hook dependency list (it changes on every update). Panels are memoized in `App.jsx`.
- **Audio engine**: realtime uses a lookahead scheduler; offline render (`audio/render.js`) schedules in chunks with
  `OfflineAudioContext.suspend()` and reaps finished voices — keep both paths in mind when touching `Transport`.
  Velocity → gain is squared (`velocityGain`) and timbre is scaled by `timbre(velRaw, floor)` normalized to 1 at 0.8:
  keep new instruments consistent. Note-driven sidechain: `triggerNote` calls `pump.trigger()` for its source channel.
- **Effect params of type `channel`** (e.g. the pump's `source`) hold a channel id; MCP tools accept names and resolve
  them (`resolveEffectParams` in `mcp/tools/mix.js`); the UI shows a channel picker (`ParamControls`).
- **Changing sound defaults changes existing songs** (velocity curve, limiter makeup, reverb IR): keep levels
  comparable (the convolver normalizes every generated room), check a render before/after, and note it in
  `CHANGELOG.md`.
- **Web Audio units**: the Q of low-/high-pass biquads is in **dB** (`FLAT_Q = -3.0103` = Butterworth, no bump);
  peaking/band-pass Q is linear (`FLAT_Q` lives in `audio/dsp.js`). `DynamicsCompressorNode` looks ahead 6 ms, truncated
  to whole frames (264 @ 44.1 kHz): delay parallel dry paths by `Math.floor(0.006 * sampleRate)` frames.
- **Plugins are untrusted code.** The server must never execute them; DSP code is only ever served through
  `workletModule()` (AudioWorklet-only harness), generator code only as text into the sandbox iframe
  (`lib/sandbox.js` ↔ `server/src/sandbox.js`). Everything coming back (audio, notes, params, manifest text) is data
  that gets validated/cleaned (`cleanGeneratedNotes`, `sanitizePluginValues`, harness `clean`). Installing needs a
  browser session and `trust: true`; never add a path that installs or enables a plugin from MCP/API tokens. A
  project must keep working when a plugin is missing (silent channel, pass-through effect, settings kept).
- **Spatial**: an insert with `spatial.enabled` is a 3D object; the `SpatialRig` (not the stereo router) connects it.
  Exports are rendered by the `spatial` job; positions automate `spatialX/Y/Z`. See `docs/spatial.md`.
- **Samples**: a sample's audio can be replaced (wave editor "Replace original", `edit_sample saveAs=replace`): the id stays,
  `rev` goes up. Files are cached as immutable, so always fetch them with `sampleFileUrl(id)` (`?v=rev`), never a bare
  `/api/samples/:id/file`. Folders are per user (`folderId` null = unfiled); bulk endpoints check every id before
  changing anything. Deleting/replacing asks first with `sampleUsage` (which projects, channels, clips).
- **Recording**: needs a secure context (HTTPS or localhost); the take is aligned with `Transport.play({ at })` + output/
  input latency. Long DSP (pitch, stretch, PSOLA) never runs on the main thread — use `runAudioJob` / `editClip`.
- **ffmpeg** is optional: everything must work (WAV) without it, and conversions only ever touch files the server
  wrote itself (`server/src/ffmpeg.js`: argument arrays, `-protocol_whitelist file`, forced `-f wav`, timeout).
- Comments explain *why*; keep functions small; no new dependencies without a good reason (licence must be
  MIT-compatible — e.g. `audio-decode` was rejected for GPL decoders).

## Gotchas

- `DATA_DIR` defaults to `./data` — tests and e2e always use temp dirs; never point tests at real data.
- On first start with no users the studio shows the admin setup screen; when `HOST` is not loopback a setup code is
  printed in the server log (or set `SETUP_CODE`).
- MCP HTTP responses are SSE (needed for progress) — raw `fetch` tests must send
  `Accept: application/json, text/event-stream` and parse `data:` lines (`readRpc` in `server/test/helpers.js`).
- Playwright in this repo uses `@playwright/test`; install browsers with `npx playwright install chromium`.
- The generator sandbox page has an **opaque origin**: to the browser its own `/sandbox/generator.js` is a
  cross-origin load (it must keep `Cross-Origin-Resource-Policy: cross-origin`), and it can't use cookies or the API.
- An AudioWorklet scope can't re-register a processor name: plugin processors are named with the package hash
  (`pluginProcessorName`), and modules load once per `AudioContext` (offline renders get their own).
- Physical-model notes (piano/guitar/bass/pizz and the world strings) are rendered in workers and cached; offline
  renders wait for the prewarm. Changing a model's rendered params invalidates its cache key — keep
  `MODELS[...].keys` accurate.
- The wave editor keeps its own undo history: its Ctrl+Z only works while it has focus (it re-focuses itself after a
  toolbar edit, `keepFocus`); with focus elsewhere Ctrl+Z undoes the project as usual. Its `busy` state is shared with
  the Pitch tab: claim it only when free and clear it only while it still holds your label; a save records the
  `stateId` it uploads (an edit landing during the upload stays unsaved).
- e2e with a microphone: launch Chromium with `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`
  (a beeping fake input; see `e2e/workflow-samples.spec.js`). A test that drags in the pitch view finds a note block by
  its colour in the canvas.
- The CSS class `sel` means "selected" (clips, notes, rows); dropdowns are `.ui-select`. Window title bars drag from
  anywhere except real controls (`INTERACTIVE` in `ui/Window.jsx`); a custom control in a toolbar needs
  `data-nodrag` (or a role) so dragging it doesn't move the window.

## Project skills & agents

See `.claude/skills/` (add-instrument, add-effect, add-mcp-tool, add-project-op, spatial-audio, plugin-system,
write-plugin, export-formats, test-and-qa, docs-and-release) and
`.claude/agents/` (`qa-reviewer` — read-only code review; `music-industry-advisor` — read-only product advice from a
20-year music-industry veteran's perspective). The top-level `skills/` folder is different: skills for *users* making
music with GreanTeaDawy from Claude Desktop / claude.ai (beat making, mixing by numbers, spatial, arranging, plugin
authoring) — keep them in sync with the MCP tools and `guide.js`.
