---
name: write-plugin
description: Write, pack and test a GreanTeaDawy plugin (DSP instrument, sample instrument, effect or note generator) — e.g. a new example in plugins/examples — following docs/plugins.md.
---

# Write a plugin

The authoring guide is `docs/plugins.md`; the examples in `plugins/examples/` are the reference implementations.

1. **Pick the type** and copy the closest example folder:
   - DSP instrument → `chiptune` (`gtd.registerInstrument({ createVoice })`)
   - sampled instrument → `kalimba` (no code: `samples` zones + `samples` permission)
   - effect → `tape-wobble` (`gtd.registerEffect({ create })`)
   - generator → `euclid`, or `counter-melody` when it needs the pattern's notes (`project-read`)
2. **plugin.json**: a unique `id` (`vendor.name`), semver `version`, the minimum permissions, params with musically
   safe ranges at both ends, presets (the first is the default and should equal the param defaults), `color`.
3. **Code rules**: one plain script; `import`/`importScripts` get the package refused (packer and server), `eval` /
   `new Function` are blocked at runtime by the CSP; allocate buffers in `create`/`createVoice`, never per sample block; output within ±1; return `false` from
   a voice's `process` when it has decayed; generators are synchronous and use `input.random()` (seeded).
4. **Levels**: square the velocity for gain (like the built-in instruments) so a plugin sits at the same loudness as
   the factory sounds at velocity 0.8.
5. **Pack**: `npm run plugin:pack -- plugins/examples/<name>` (validates like the server, writes `plugins/dist/`).
6. **Try it**: `npm run dev`, Settings → Plugins → Install the zip, then play it from the Browser / add it to an
   insert / piano roll → Gen. Ask Claude (MCP) to `list_plugins` and `render_mix` with it: no `INVALID RENDER`,
   sensible LUFS, no clicks at note starts/ends.
7. **Test**: for a new example, extend `e2e/workflow-plugins.spec.js` (it packs the examples in `beforeAll`) and the
   examples table in `plugins/README.md` and `docs/plugins.md`.

Samples for sample instruments: 44.1/48 kHz WAV, trimmed, peak around −3 dBFS, root note in the file name; write a
small generator script (see `kalimba/make-samples.mjs`) when they're synthesized, so they can be rebuilt.
