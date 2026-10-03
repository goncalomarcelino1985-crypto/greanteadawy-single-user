---
name: add-mcp-tool
description: Add or change a GreanTeaDawy MCP tool (the API Claude uses to make music) with proper schema, validation, ids in replies, tests and regenerated docs.
---

# Add an MCP tool

Tools live in `server/src/mcp/tools/<area>.js` (projects, sounds, notes, arrange, mix, samples, production — groove,
fills and transitions that compose ordinary ops —, export (ffmpeg formats), spatial, plugins) and are registered by
`createMcpServer` in `server/src/mcp/tools.js`. They run against a **backend** (`server/src/backend.js`): local
(in-process, used by `/mcp`) or remote (the stdio bridge talking REST). Use only backend methods so both work.

## Template

```js
tool('humanize_groove', {
  title: 'Humanize groove',
  description: 'Add human feel to a channel: timing drift (steps) and velocity variation. Keeps notes on the grid ' +
    'when amount is 0. Use after programming drums.',
  inputSchema: {
    projectId: projectIdArg,
    pattern: z.string().describe('Pattern id or name'),
    channel: z.string().describe('Channel id or name'),
    amount: z.number().min(0).max(1).optional().describe('0..1 (default 0.3)')
  },
  annotations: A.edit                       // readOnly | edit | destructive (from ../util.js)
}, async ({ projectId, pattern, channel, amount = 0.3 }, extra) => {
  const p = await load(projectId);          // resolves the active project when projectId is omitted
  const pt = findPattern(p, pattern);       // throws a helpful "not found. Available: …" error
  const ch = findChannel(p, channel);
  // 1) validate EVERYTHING first — a failed call must not leave half an edit behind
  // 2) build ops; create ids yourself (uid('n')) when the reply needs them
  await backend.applyOps(p.id, ops);        // one batch = one undo step for Claude, one live update in the browser
  return ok(`Humanized ${n} notes of "${ch.name}" in "${pt.name}" [${ids.join(', ')}].`);
});
```

## Rules

- **Units**: steps (16ths, 0-based) inside patterns, bars/tracks 1-based, bar ranges inclusive. Say so in `.describe()`.
- **Errors**: `throw new Error('…how to fix…')`. The wrapper turns it into an `isError` result. Mention valid values.
- **Replies**: short, factual, include created ids in `[brackets]`, the resulting state (e.g. new length) and any
  warnings (clamped values, tempo mismatch). Use the second `ok(text, data)` argument for structured data.
- **Long work** (browser jobs): pass `onProgress: progressNotifier(extra, '…')` to `backend.requestJob` (see `mix.js`).
- **Annotations**: anything that writes files or changes state is not `readOnly`.
- Prefer extending an existing tool with an optional parameter over adding near-duplicate tools; keep the total
  number of tools manageable for the model.
- If the tool needs a new kind of edit, add an op first (skill: add-project-op).

## Finish

1. Tests in `server/test/mcp-edge.test.js` (or `mcp.test.js`): happy path, validation errors, and that nothing changes
   on error. Use `callTool(client)` from `test/helpers.js`.
2. Update the guide (`server/src/mcp/guide.js`) or prompts (`prompts.js`) if the workflow changes.
3. `npm run docs:mcp` (regenerates `docs/MCP.md`), `npm run lint && npm test`.
4. Update the tool count where it's quoted (README, docs/README, docs/claude-mcp.md, CLAUDE.md) and the user skills in
   `skills/` that describe the workflow (e.g. `greanteadawy-beatmaking`), then `npm run skills:pack`.
