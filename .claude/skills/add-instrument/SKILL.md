---
name: add-instrument
description: Add a new synthesized instrument (or new presets) to GreanTeaDawy's channel rack so it appears in the UI, plays in realtime and offline renders, and is usable by Claude via MCP.
---

# Add an instrument

An instrument has two halves that must stay in sync:

| Part | File | Purpose |
|------|------|---------|
| Definition | `packages/core/src/instruments.js` → `INSTRUMENTS` | label, category, colour, `defaultKey`, `params` (drive knobs + MCP validation), `presets` |
| Voice | `client/src/audio/instruments.js` | builds the Web Audio graph for one note |

Everything else (Browser list, Channel settings knobs, `list_instruments`, `add_channel` enum, docs) is generated from
the definition.

## Steps

1. **Define it** in `INSTRUMENTS` (core). Use the `n()` / `sel()` / `bool()` helpers:
   ```js
   pluck: {
     label: 'Pluck', category: 'synth', melodic: true, defaultKey: 60, gm: 46, color: '#46c79a',
     description: 'Karplus-Strong style plucked string.',            // shown to Claude in list_instruments
     params: [
       n('damping', 'Damping', 0, 1, 0.4),
       n('brightness', 'Brightness', 200, 12000, 4000, { unit: 'Hz', curve: 'log' }),
       ...ampEnv(0.001, 0.8, 0, 0.3)
     ],
     presets: { Default: {}, Harp: { damping: 0.2, brightness: 7000 } }
   }
   ```
   - `category` decides the Browser section and the **+ Channel** submenu: one of `INSTRUMENT_CATEGORIES` in the same
     file (`drums`, `bass`, `keys`, `guitar`, `strings`, `synth`, `flutes`, `beatbox`, `indian`, `eastasian`,
     `sampler`). A new section is one entry there; a core test fails for an unknown or empty category.
   - Several kinds can share one engine with different defaults (the flutes share `windParams()`, the double reeds
     `reedParams()`, the modelled world strings `pluckParams()`); the voice picks the recipe by kind.
   - Ranges must be musically safe at both ends (no NaN/Infinity, no feedback > 0.99). The engine trusts them.
   - `curve: 'log'` for frequencies/times; `step: 1` for integers; `unit` for display.
   - Drums: `melodic: false`, `defaultKey: 60` (the instrument plays at its natural pitch on C4).
   - The first preset is the default; presets only list values that differ from param defaults.
2. **Write the voice** in `client/src/audio/instruments.js` (band instruments live in `client/src/audio/band.js`, the
   flute/beatbox/Indian/East Asian collections in `client/src/audio/world.js` — its `WORLD` table):
   - Signature: `function pluck(v, ctx, p, { t, vel, velRaw, key, ratio, glideFrom, buffer })`.
     `v` is the `Voice`; `p` = params with defaults applied; `t` start time; `vel` = the **gain** for the velocity
     (already squared, `velocityGain`); `velRaw` = the note's velocity 0..1 (use it for timbre: `timbre(velRaw, floor)`);
     `ratio` = pitch ratio vs C4.
   - Register every source with `v.add(src)` (that is how the voice knows when it ended) and connect the output to
     `v.out`.
   - Percussive voices return their natural end time (`return t + decay + 0.05`) and `stop()` their sources there.
   - Sustained voices set `v.releaseFn = (time) => { /* start release */ return endTime; }` and `v.freq` (for glide).
   - Dispatch it in `playNote()` (drums go in the `DRUMS` table, world voices in `WORLD`).
   - Level it against the existing instruments with `analyze_sound` (a held C5 at velocity 0.8: sustained leads
     ≈ −21 LUFS, plucked models −25…−27, kick −17, snare −22, closed hats −30…−33).
   - Never create nodes that run forever (LFOs, noise) without stopping them with the voice.
3. **Templates / builders** (optional): use it in `packages/core/src/templates.js` if it fits a genre.
4. **Tests**: add a case to `packages/core/test/core.test.js` (definition sanity: `makeInstrument('pluck', 'Harp')`
   returns all params, strict validation rejects out-of-range values).
5. **Check** in the browser: `npm run dev`, add the instrument from the Browser, play notes from the computer keyboard,
   render a WAV (File → Export) and make sure there are no clicks, DC offset or runaway levels. `render_mix` via MCP
   should report sane LUFS/peak for it.
6. `npm run lint && npm test && npm run test:e2e`, then `npm run docs:mcp` (the tool docs list instruments).

## Physical models (pre-rendered notes)

Instruments that are too expensive to build from Web Audio nodes per note (piano, guitar, bass, pizzicato, and the
world strings: sitar, tanpura, santoor, koto, guzheng, pipa, shamisen) are rendered into buffers instead:

- Write a pure renderer `(sampleRate, key, velocity, params) → Float32Array` in `client/src/audio/models.js` (no Web
  Audio, so it runs in Node tests and in `modelWorker.js`), end it with `finish(x, sr)` (levels the attack, soft-limits
  the transient, fades the tail) and register it in `MODELS` with the param keys that change the rendered sound —
  everything else (gain, release, pan, drive) is applied live by the voice and must not be in that list.
- Its voice uses `modelVoice()` in `client/src/audio/band.js`; `modelPool.js` prewarms every note the project plays
  in background workers and `noteBuffer()` renders a missing one on the spot.
- Plucked/struck strings: `worldString()` (Karplus–Strong that holds its T60 on high notes, pluck or mallet strike,
  exact tuning), `jawariBuzz()` (bridge buzz that lasts the whole note), `sympathetic()` (resonators at fixed pitches)
  and `skinHit()` (a plectrum on a skin) are the building blocks.
- Test it in `client/test/models.test.js` (finite, levelled, in tune, brighter with velocity).

## Pitfalls

- Clamp filter frequencies to `ctx.sampleRate / 2 - 100`.
- Use `setValueAtTime` before ramps; exponential ramps can't target 0 (use 0.0001).
- Keep per-note node count low: offline renders of long songs create thousands of voices.
