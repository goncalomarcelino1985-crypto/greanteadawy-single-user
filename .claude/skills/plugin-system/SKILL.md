---
name: plugin-system
description: Change GreanTeaDawy's plugin system (manifest schema, install flow, worklet harness, generator sandbox, plugin UI or MCP tools) without weakening its security model. Use for any edit to core/plugins.js, server/src/plugins.js, zip.js, sandbox.js, client audio/plugins.js or lib/sandbox.js.
---

# The plugin system

User plugins are **untrusted code**. Read `docs/plugins.md` (authors' view) and `docs/security.md#plugins` (threat
model) before changing anything here.

| Layer | File | Responsibility |
|-------|------|----------------|
| Manifest | `packages/core/src/plugins.js` | `validateManifest` (schema, permissions, per-type rules), `sanitizePluginValues` (strict for MCP), `sanitizeStoredPluginParams` (loose, for projects), `pluginParamValues`, `cleanGeneratedNotes`, `pluginProcessorName` |
| Project model | `core/instruments.js` (`INSTRUMENTS.plugin`), `core/effects.js` (`EFFECTS.plugin`), `model.js`, `ops.js`, `summary.js` | channels `{ kind: 'plugin', plugin, preset, params }`, effects `{ type: 'plugin', plugin, params }` — kept even when the plugin is missing |
| Zip | `server/src/zip.js` | `readZip` limits (entries, sizes, ratio, CRC, paths, links, ZIP64/encryption refused), `writeZip` |
| Store + serving | `server/src/plugins.js` | `inspect` → pending token (≤ 3 per user, 15 min) → `install` (tmp dir + rename, per-user lock), `checkPluginCode`, `workletModule` harness |
| Sandbox page | `server/src/sandbox.js` | `/sandbox/generator.html` + `.js`: CSP `sandbox allow-scripts`, `connect-src 'none'`, worker harness that removes network APIs |
| Routes | `server/src/api.js` (`/api/plugins/*`), `auth/routes.js` (`allowPlugins`, user deletion) | session-only install/change, 404 for foreign ids, `plugins-changed` WS hints |
| MCP | `server/src/mcp/tools/plugins.js` (`list_plugins`, `run_generator`), `sounds.js`/`mix.js` (plugin channels/effects) | validate against the manifest before any op |
| Browser audio | `client/src/audio/plugins.js` | registry, `addModule` per context, voices (`gtdGate`/`gtdKill`), effect slots (pass-through until loaded), sample zones |
| Browser sandbox | `client/src/lib/sandbox.js`, `lib/jobs.js` (`generator` job), `lib/actions.js` (`generateNotes`) | post code + input to the iframe, accept replies only from it |
| UI | `Settings.jsx` (PluginsTab, InstallReview), `Browser.jsx`, `Mixer.jsx`, `ChannelSettings.jsx`, `Generate.jsx` | trust warning + checkbox, errors |

## Invariants — every change must keep these

1. **The server never executes plugin code** (no `eval`, `vm`, `require`/`import` of plugin files, no worker threads
   running it). It only validates, stores and serves.
2. **Installing needs the user**: `requireSession` (API tokens → 403) and `trust: true` from the review dialog. Never
   add an MCP tool or token-accessible route that installs, updates or enables a plugin.
3. **DSP code is only served inside `workletModule()`** (throws outside `AudioWorkletGlobalScope`), as
   `application/javascript` with `CORP same-origin`. **Generator code only as `text/plain` + `CSP: sandbox`**, run in
   the opaque-origin iframe's throwaway Worker. Don't serve plugin code any other way.
4. **No new capabilities without a permission.** A new ability (e.g. MIDI output, custom UI) needs a new permission
   in `PLUGIN_PERMISSIONS` with an honest description shown in the dialog, a per-type rule in `validateManifest`, and
   a sandbox that enforces it. `FORBIDDEN_PERMISSIONS` stays refused.
5. **Everything coming back is data**: audio is cleaned by the harness, notes by `cleanGeneratedNotes`, params by
   `sanitizePluginValues`; manifest text is rendered as text only (React), `color` is `#rrggbb`, `homepage` https and
   not a link.
6. **Per-user isolation**: `DATA_DIR/plugins/<userId>/`, `PLUGIN_ID_RE` on every id, 404 for other users' plugins,
   `removeUser` on account deletion.
7. **Projects survive missing plugins**: silent channel, pass-through effect slot, settings kept (normalizers must not
   drop `plugin` ids or params).
8. Updates must not reuse old code: processor names carry the package hash; open studios reload on `plugins-changed`.

If a change can't keep one of these, stop and explain the trade-off instead of shipping it.

## Testing

- Core: `packages/core/test/plugins.test.js` (schema, permissions, values, generated notes).
- Server: `server/test/plugins.test.js` (zip attacks, install/trust/token flow, serving headers, isolation, admin
  switch, MCP tools with a fake browser).
- Real browser: `e2e/workflow-plugins.spec.js` installs through the dialog, renders DSP + sample plugins, runs
  generators in the real sandbox, and checks hostile plugins (network probes, infinite loop, NaN output, crashes).
  Add a hostile case for every new capability.
- After changes, run the `qa-reviewer` agent with a security focus on these files.
