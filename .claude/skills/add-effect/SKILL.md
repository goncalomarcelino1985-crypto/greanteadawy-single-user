---
name: add-effect
description: Add a new mixer effect (or new params for an existing one) to GreanTeaDawy, including automation support and MCP exposure.
---

# Add a mixer effect

| Part | File |
|------|------|
| Definition (params, ranges, automatable flags) | `packages/core/src/effects.js` → `EFFECTS` |
| DSP graph | `client/src/audio/effects.js` → `FACTORIES` |

The mixer UI, `list_effects`, `add_effect` / `update_effect` validation, automation targets and docs all derive from
the definition.

## Steps

1. **Define** in `EFFECTS`:
   ```js
   tape: {
     label: 'Tape', description: 'Tape saturation with wow & flutter.',   // shown to Claude
     params: [
       n('drive', 'Drive', 0, 1, 0.3, { automatable: true }),
       n('wow', 'Wow', 0, 1, 0.1),
       sel('speed', 'Speed', ['7.5ips', '15ips', '30ips'], '15ips'),
       n('mix', 'Mix', 0, 1, 1, { automatable: true })
     ]
   }
   ```
   `automatable: true` only when the value maps to an `AudioParam` (or the factory exposes a `transform`).
   Param types: `n` (number), `sel` (select), `bool`, and `channelRef` (a channel id or null — e.g. the pump's
   sidechain `source`; MCP accepts a channel name and `resolveEffectParams` turns it into the id, the UI shows a
   channel picker). New params on an existing effect get their default in old projects via `normalizeProject`, but
   read them defensively in the factory too (`p.size ?? 0.5`).
2. **Implement the factory** in `FACTORIES` (client):
   ```js
   tape(ctx, engine) {
     const wd = wetDry(ctx);               // input → dry/wet → output helper
     // …build nodes between wd.input and wd.wet…
     const mix = mixParam(ctx, wd);
     return {
       input: wd.input, output: wd.output,
       update(p) { /* setParam(node.param, p.x, ctx) for every param */ mix.set(p.mix); },
       automation: { drive: shaperGain.gain, mix: mix.param },    // param key → AudioParam(s)
       transform: { /* optional: param key → (raw) => audio value */ },
       dispose() { /* stop oscillators, disconnect */ },
       onTempo() { /* optional: re-sync tempo-based params */ }
     };
   }
   ```
   - Use `setParam` from `dsp.js` (smooth, avoids zipper noise).
   - Anything with feedback must be bounded (< 1) and NaN-safe.
   - A dry/wet mix around a `DynamicsCompressorNode` needs the dry path delayed by `COMPRESSOR_LATENCY` (6 ms look-ahead),
     or it comb-filters (see the compressor factory).
   - WaveShapers that clip or saturate hard should use `oversample = '4x'` (aliasing, inter-sample overs).
   - Generated buffers (impulse responses, noise) must be seeded/deterministic so renders are reproducible.
   - Stop LFO oscillators in `dispose()`; the engine calls it when the effect is removed.
3. **Master chain**: `add_effect` on insert 0 inserts before the limiter by default — keep the limiter last.
4. **Tests**: add effect params checks in `packages/core/test/core.test.js`; an MCP test in
   `server/test/mcp-edge.test.js` (`add_effect` accepts valid params, rejects out-of-range ones).
5. Verify by ear in `npm run dev` (Mixer → Add effect) and with `render_mix` (no NaN: the report flags invalid renders).
6. `npm run lint && npm test && npm run test:e2e`, then `npm run docs:mcp`.
